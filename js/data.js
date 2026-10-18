// 앱 상태와 통합 조회
// 출처 세 가지: verified(시민 관찰·검증됨) / pending(시민 관찰·확인 중) / gbif(기관·타 플랫폼 기록)
// 멸종위기종이라 좌표는 갖고 있지 않고, 기록마다 시·군·구 코드(gid)와 기간만 씁니다.
App.state = {
  species: [],
  spById: new Map(),
  inat: {},              // speciesId → [관찰 객체]
  inatTaxa: {},          // speciesId → { id, photo, lic, by, wiki }
  inatSnapshotAt: null,
  inatSyncedAt: null,    // 마지막 실시간 갱신 시각(Date)
  gbif: {},              // speciesId → { taxonKey, total, units: {gid: [기간별 건수]}, sea: [..], years, ds }
  heat: null,            // speciesId → [격자, 기간, 건수, …] (열지도를 처음 열 때 받음)
  precise: null,         // 관리자 잠금을 풀었을 때만: { gbif, inat } 정밀 기록
  gbifDatasets: [],
  gbifAt: null,
  filters: {
    groups: new Set(Object.keys(window.TAXON_GROUPS)),
    species: null,       // null = 전체
    grades: null,        // null = 전체, Set("en1"|"en2")
    periods: new Set([0, 1, 2, 3, 4]),
    sources: { verified: true, pending: true, gbif: true },
  },
  mapUnit: "sgg",        // sgg(시·군·구) | sido(시·도) | heat(열지도)
  choroMetric: "species",
};

App.data = (() => {
  const S = App.state;

  const SOURCES = {
    verified: { label: "시민 관찰 · 검증됨", short: "검증됨", badge: "badge-green" },
    pending: { label: "시민 관찰 · 확인 중", short: "확인 중", badge: "badge-orange" },
    gbif: { label: "기관·타 플랫폼 기록", short: "기관·타 플랫폼", badge: "badge-gray" },
  };

  // 기간: 기관 기록을 이 단위로 집계해 두었으므로 연도 필터도 이 단위
  const PERIODS = [
    { label: "1999년 이전", short: "~1999", from: 0, to: 1999 },
    { label: "2000~2009년", short: "2000년대", from: 2000, to: 2009 },
    { label: "2010~2019년", short: "2010년대", from: 2010, to: 2019 },
    { label: "2020년 이후", short: "2020~", from: 2020, to: 9999 },
    { label: "연도 미상", short: "미상", from: -1, to: -1 },
  ];
  const ALL_PERIODS = () => new Set(PERIODS.map((_, i) => i));
  const periodOf = (y) => {
    if (!y) return 4;
    for (let i = 0; i < 4; i++) if (y >= PERIODS[i].from && y <= PERIODS[i].to) return i;
    return 4;
  };

  const rebuildSpecies = () => {
    S.species = [...window.SPECIES_CATALOG];
    S.spById = new Map(S.species.map((s) => [s.id, s]));
  };

  const group = (sp) => window.TAXON_GROUPS[sp && sp.group] || { label: "기타", color: "#868e96" };
  const colorOf = (spId) => group(S.spById.get(spId)).color;
  const grade = (sp) => window.STATUS[sp && sp.grade] || { label: "", short: "", color: "#868e96" };
  const gradeBadge = (sp, { short = false } = {}) => {
    const g = grade(sp);
    return g.label ? `<span class="badge status-badge" style="--s:${g.color}" title="${App.util.esc(g.label)}">${App.util.esc(short ? g.short : g.label)}</span>` : "";
  };

  const speciesVisible = (spId, f = S.filters) => {
    const sp = S.spById.get(spId);
    if (!sp || !f.groups.has(sp.group)) return false;
    if (f.grades && !f.grades.has(sp.grade)) return false;
    return !f.species || f.species.has(spId);
  };

  /**
   * 조건에 맞는 모든 기록을 순회: cb(spId, gid, period, source, n, ref)
   * gid가 null이면 지도 밖(바다·위치 미상). n은 건수(기관 기록은 묶음 건수, 시민 관찰은 1)
   * ref — 시민 관찰은 관찰 객체
   */
  const each = (cb, opts = {}) => {
    const f = opts.filters || S.filters;
    const src = opts.sources || f.sources;
    const per = f.periods || ALL_PERIODS();
    const spOk = opts.ignoreSpeciesFilter ? (id) => S.spById.has(id) : (id) => speciesVisible(id, f);
    if (src.verified || src.pending) {
      for (const id in S.inat) {
        if (!spOk(id)) continue;
        for (const o of S.inat[id]) {
          const source = o.q ? "verified" : "pending";
          if (!src[source] || !per.has(o.p)) continue;
          cb(id, o.gid, o.p, source, 1, o);
        }
      }
    }
    if (src.gbif) {
      for (const id in S.gbif) {
        if (!spOk(id)) continue;
        const e = S.gbif[id];
        for (const gid in e.units) {
          const v = e.units[gid];
          for (let p = 0; p < v.length; p++) if (v[p] && per.has(p)) cb(id, gid, p, "gbif", v[p], null);
        }
        for (let p = 0; p < e.sea.length; p++) if (e.sea[p] && per.has(p)) cb(id, null, p, "gbif", e.sea[p], null);
      }
    }
  };

  const emptyAgg = () => ({ records: 0, bySource: { verified: 0, pending: 0, gbif: 0 }, species: new Map() });
  const add = (a, spId, source, n) => {
    a.records += n;
    a.bySource[source] += n;
    a.species.set(spId, (a.species.get(spId) || 0) + n);
  };

  // 시·군·구별 집계: Map gid → { records, bySource, species: Map spId → 건수 }, sea: 지도 밖 건수
  const byUnit = (opts) => {
    const m = new Map();
    let sea = 0;
    each((spId, gid, p, source, n) => {
      if (!gid) { sea += n; return; }
      let a = m.get(gid);
      if (!a) { a = emptyAgg(); m.set(gid, a); }
      add(a, spId, source, n);
    }, opts);
    return { units: m, sea };
  };

  // 시·도별 집계 (배열, App.geo.regions 순서)
  const bySido = (opts) => {
    const n = App.geo.regions.length;
    const out = Array.from({ length: n }, emptyAgg);
    let unknown = 0;
    each((spId, gid, p, source, k) => {
      const r = gid ? App.geo.sidoOf(gid) : -1;
      if (r < 0) { unknown += k; return; }
      add(out[r], spId, source, k);
    }, opts);
    return { regions: out, unknown };
  };

  const bySpecies = (opts) => {
    const out = new Map();
    const nR = App.geo.regions.length;
    each((spId, gid, p, source, n) => {
      let s = out.get(spId);
      if (!s) {
        s = { total: 0, verified: 0, pending: 0, gbif: 0, units: new Map(), sido: new Int32Array(nR), periods: [0, 0, 0, 0, 0], sea: 0 };
        out.set(spId, s);
      }
      s.total += n;
      s[source] += n;
      s.periods[p] += n;
      if (!gid) { s.sea += n; return; }
      s.units.set(gid, (s.units.get(gid) || 0) + n);
      const r = App.geo.sidoOf(gid);
      if (r >= 0) s.sido[r] += n;
    }, opts);
    return out;
  };

  // 연도별 건수(기관 기록은 연도 집계, 시민 관찰은 관찰일) — 기간 필터를 따름
  const byYear = (opts = {}) => {
    const f = opts.filters || S.filters;
    const src = opts.sources || f.sources;
    const per = f.periods || ALL_PERIODS();
    const out = new Map();
    const put = (y, n) => { if (y && per.has(periodOf(y))) out.set(y, (out.get(y) || 0) + n); };
    for (const id in S.inat) {
      if (!speciesVisible(id, f)) continue;
      for (const o of S.inat[id]) if (src[o.q ? "verified" : "pending"]) put(o.y, 1);
    }
    if (src.gbif) for (const id in S.gbif) if (speciesVisible(id, f)) S.gbif[id].years.forEach(([y, n]) => put(y, n));
    return out;
  };

  // 열지도 점: [위도, 경도, 건수] — 격자(약 250m) 중심. 위치를 흐린 관찰·오차 큰 기록은 격자가 없어 빠짐
  const heatPoints = (opts = {}) => {
    const f = opts.filters || S.filters;
    const src = f.sources;
    const per = f.periods || ALL_PERIODS();
    const m = new Map();
    const put = (c, n) => m.set(c, (m.get(c) || 0) + n);
    if (src.verified || src.pending) {
      for (const id in S.inat) {
        if (!speciesVisible(id, f)) continue;
        for (const o of S.inat[id]) if (o.cell >= 0 && src[o.q ? "verified" : "pending"] && per.has(o.p)) put(o.cell, 1);
      }
    }
    if (src.gbif && S.heat) {
      for (const id in S.heat) {
        if (!speciesVisible(id, f)) continue;
        const a = S.heat[id];
        for (let i = 0; i < a.length; i += 3) if (per.has(a[i + 1])) put(a[i], a[i + 2]);
      }
    }
    return [...m.entries()].map(([c, n]) => [...App.geo.cellCenter(c), n]);
  };

  // 시민 관찰 전체 목록(최근순) — 참여하기 화면, 종 상세, 시·군·구 패널에 사용
  const recentInat = ({ spId = null, gid = null, withPhoto = false, limit = 24, filter = null } = {}) => {
    const all = [];
    for (const id in S.inat) {
      if (spId && id !== spId) continue;
      if (filter && !filter(id)) continue;
      for (const o of S.inat[id]) {
        if (withPhoto && !o.ph) continue;
        if (gid && o.gid !== gid) continue;
        all.push({ spId: id, o });
      }
    }
    all.sort((a, b) => (b.o.date - a.o.date) || (b.o.id - a.o.id));
    return limit ? all.slice(0, limit) : all;
  };

  // 실시간 변경분 반영 (같은 관찰 ID는 교체, 검증 대상에서 빠진 것은 삭제)
  const applyInatChanges = ({ upserts, removed }) => {
    const remove = new Set(removed);
    upserts.forEach(({ obs }) => remove.add(obs.id));
    let added = 0;
    const known = new Set();
    for (const id in S.inat) S.inat[id].forEach((o) => known.add(o.id));
    for (const id in S.inat) {
      const before = S.inat[id].length;
      S.inat[id] = S.inat[id].filter((o) => !remove.has(o.id));
      if (S.inat[id].length !== before) S.inat[id] = S.inat[id].slice();
    }
    upserts.forEach(({ spId, obs }) => {
      if (!known.has(obs.id)) added++;
      (S.inat[spId] = S.inat[spId] || []).push(obs);
    });
    return { added, changed: upserts.length - added, removed: removed.filter((id) => known.has(id)).length };
  };

  return {
    SOURCES, PERIODS, ALL_PERIODS, periodOf, rebuildSpecies, group, colorOf, grade, gradeBadge, speciesVisible,
    each, byUnit, bySido, bySpecies, byYear, heatPoints, recentInat, applyInatChanges,
  };
})();
