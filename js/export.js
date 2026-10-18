// 연구용 자료 내려받기: 엑셀(여러 시트), CSV(집계 원자료), GeoJSON(시·군·구 경계 + 집계)
// 멸종위기종이라 좌표 대신 시·군·구 × 기간 단위 집계만 제공합니다.
App.exporter = (() => {
  const { esc, fmt, toCSV, download, toast } = App.util;
  const S = App.state;
  const XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
  const SITE = "https://endangered.biogrideia.com/";

  // 엑셀 도구는 내려받을 때만 불러옴(약 0.9 MB)
  let xlsxP = null;
  const loadXLSX = () => xlsxP || (xlsxP = new Promise((resolve, reject) => {
    if (window.XLSX) return resolve(window.XLSX);
    const s = document.createElement("script");
    s.src = XLSX_URL;
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { xlsxP = null; reject(new Error("엑셀 도구를 불러오지 못했습니다.")); };
    document.head.appendChild(s);
  }));

  const SOURCE_LABEL = { verified: "시민 관찰·검증됨", pending: "시민 관찰·확인 중", gbif: "기관·타 플랫폼" };
  const INAT_LICENSE = {
    cc0: "CC0", "cc-by": "CC BY", "cc-by-nc": "CC BY-NC", "cc-by-sa": "CC BY-SA", "cc-by-nd": "CC BY-ND",
    "cc-by-nc-sa": "CC BY-NC-SA", "cc-by-nc-nd": "CC BY-NC-ND",
  };
  const dateStr = (d) => {
    if (!d) return "";
    const y = Math.floor(d / 10000), m = Math.floor(d / 100) % 100, day = d % 100;
    return m ? (day ? `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}` : `${y}-${String(m).padStart(2, "0")}`) : String(y);
  };
  const ALL_FILTERS = (sources) => ({
    groups: new Set(Object.keys(window.TAXON_GROUPS)), species: null, grades: null, periods: App.data.ALL_PERIODS(), sources,
  });
  const scopeFilters = (opts) => (opts.scope === "map" ? S.filters : ALL_FILTERS(opts.sources));

  // ---------- 집계 원자료 열 정의: [키, 한글 이름, 영문, 설명] ----------
  const COLUMNS = [
    ["speciesId", "종 ID", "speciesID", "이 지도에서 쓰는 종 식별자"],
    ["name", "국명", "vernacularName", "별표 1의 국명"],
    ["sci", "학명", "scientificName", "별표 1의 학명(원자료 분류와 다를 수 있음)"],
    ["grade", "등급", "conservationStatusKR", "멸종위기 야생생물 Ⅰ급 / Ⅱ급"],
    ["group", "분류군", "taxonGroup", "포유류·조류·양서파충류·어류·곤충·무척추동물·육상식물·해조류·고등균류"],
    ["family", "과", "family", "분류학적 과(GBIF 기준)"],
    ["sidoCode", "시도 코드", "provinceCode", "통계청 시·도 코드"],
    ["sido", "시도", "stateProvince", "현재 기준 시·도(군위군은 대구광역시)"],
    ["unit", "시군구", "county", "시·군·구(일반구는 시로 합침). 비어 있으면 지도 밖(바다·위치 미상)"],
    ["gid", "시군구 코드", "gadmGid", "GBIF가 쓰는 GADM 2단계 코드"],
    ["period", "기간", "period", "1999년 이전 / 2000~2009년 / 2010~2019년 / 2020년 이후 / 연도 미상"],
    ["category", "자료 종류", "recordCategory", "시민 관찰·검증됨 / 시민 관찰·확인 중 / 기관·타 플랫폼"],
    ["n", "기록 수", "individualRecordCount", "이 칸에 해당하는 기록 건수"],
  ];

  // ---------- 집계 행 만들기 (종 × 시·군·구 × 기간 × 자료 종류) ----------
  const collect = (opts) => {
    const m = new Map();
    App.data.each((spId, gid, p, source, n) => {
      const k = `${spId}|${gid || ""}|${p}|${source}`;
      m.set(k, (m.get(k) || 0) + n);
    }, { filters: scopeFilters(opts) });
    const rows = [];
    m.forEach((n, k) => {
      const [spId, gid, p, source] = k.split("|");
      const sp = S.spById.get(spId);
      const u = gid ? App.geo.unit(gid) : null;
      const r = u ? App.geo.regions[u.sido] : null;
      rows.push({
        spId, gid: gid || "", p: Number(p), source, n,
        speciesId: spId, name: sp.name, sci: sp.sci, grade: App.data.grade(sp).label, group: App.data.group(sp).label, family: sp.family || "",
        sidoCode: r ? r.code : "", sido: r ? r.name : "", unit: u ? u.name : "", period: App.data.PERIODS[p].label, category: SOURCE_LABEL[source],
      });
    });
    const order = Object.keys(window.TAXON_GROUPS);
    rows.sort((a, b) => order.indexOf(S.spById.get(a.spId).group) - order.indexOf(S.spById.get(b.spId).group) ||
      a.name.localeCompare(b.name, "ko") || a.sidoCode.localeCompare(b.sidoCode) || a.unit.localeCompare(b.unit, "ko") || a.p - b.p);
    return rows;
  };

  const speciesOrder = () => {
    const order = Object.keys(window.TAXON_GROUPS);
    return S.species.slice().sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.grade.localeCompare(b.grade) || a.name.localeCompare(b.name, "ko"));
  };
  const sum = (a) => a.reduce((x, v) => x + v, 0);

  // ---------- 집계 시트 ----------
  const sheetSpecies = (rows) => {
    const m = new Map();
    rows.forEach((r) => {
      let s = m.get(r.spId);
      if (!s) { s = { total: 0, verified: 0, pending: 0, gbif: 0, units: new Set(), sido: new Set(), per: [0, 0, 0, 0, 0], sea: 0 }; m.set(r.spId, s); }
      s.total += r.n; s[r.source] += r.n; s.per[r.p] += r.n;
      if (r.gid) { s.units.add(r.gid); s.sido.add(r.sidoCode); } else s.sea += r.n;
    });
    const head = ["종 ID", "국명", "학명", "등급", "분류군", "과", "IUCN", "GBIF 키", "iNaturalist ID", "전체 기록", "시민 관찰·검증됨",
      "시민 관찰·확인 중", "기관·타 플랫폼", "출현 시군구 수", "출현 시도 수", ...App.data.PERIODS.map((p) => p.label), "지도 밖(바다 등)"];
    const body = speciesOrder().map((sp) => {
      const s = m.get(sp.id);
      return [sp.id, sp.name, sp.sci, App.data.grade(sp).label, App.data.group(sp).label, sp.family || "", sp.iucn || "", sp.gbif || "", sp.inat || "",
        s ? s.total : 0, s ? s.verified : 0, s ? s.pending : 0, s ? s.gbif : 0, s ? s.units.size : 0, s ? s.sido.size : 0,
        ...(s ? s.per : [0, 0, 0, 0, 0]), s ? s.sea : 0];
    });
    return [head, ...body];
  };

  const unitAgg = (rows) => {
    const m = new Map();
    rows.forEach((r) => {
      if (!r.gid) return;
      let a = m.get(r.gid);
      if (!a) { a = { total: 0, verified: 0, pending: 0, gbif: 0, sp: new Map() }; m.set(r.gid, a); }
      a.total += r.n; a[r.source] += r.n;
      a.sp.set(r.spId, (a.sp.get(r.spId) || 0) + r.n);
    });
    return m;
  };

  const sheetUnits = (rows) => {
    const m = unitAgg(rows);
    const groups = Object.entries(window.TAXON_GROUPS);
    const head = ["시군구 코드", "시도", "시군구", "전체 기록", "시민 관찰·검증됨", "시민 관찰·확인 중", "기관·타 플랫폼", "출현 종 수", "Ⅰ급 종 수", "Ⅱ급 종 수",
      ...groups.map(([, g]) => `${g.label} 종 수`), "출현 종"];
    const body = App.geo.units.map((u) => {
      const a = m.get(u.gid) || { total: 0, verified: 0, pending: 0, gbif: 0, sp: new Map() };
      const sps = [...a.sp.keys()].map((id) => S.spById.get(id));
      return [u.gid, App.geo.regions[u.sido].name, u.name, a.total, a.verified, a.pending, a.gbif, sps.length,
        sps.filter((s) => s.grade === "en1").length, sps.filter((s) => s.grade === "en2").length,
        ...groups.map(([k]) => sps.filter((s) => s.group === k).length), sps.map((s) => s.name).sort((x, y) => x.localeCompare(y, "ko")).join(", ")];
    }).sort((a, b) => (a[1] + a[2]).localeCompare(b[1] + b[2], "ko"));
    return [head, ...body];
  };

  // 시·군·구(행) × 종(열) 출현 1 / 0 — 기록 있는 종만 열로
  const sheetUnitPresence = (rows) => {
    const m = unitAgg(rows);
    const sps = speciesOrder().filter((sp) => rows.some((r) => r.spId === sp.id && r.gid));
    const head = ["시군구 코드", "시도", "시군구", ...sps.map((s) => s.name), "출현 종 수"];
    const body = App.geo.units.map((u) => {
      const a = m.get(u.gid);
      const cells = sps.map((s) => (a && a.sp.has(s.id) ? 1 : 0));
      return [u.gid, App.geo.regions[u.sido].name, u.name, ...cells, sum(cells)];
    }).sort((a, b) => (a[1] + a[2]).localeCompare(b[1] + b[2], "ko"));
    return [head, ...body];
  };

  const sheetSidoSpecies = (rows) => {
    const idx = new Map();
    rows.forEach((r) => { if (r.sidoCode) { const k = `${r.spId}|${r.sidoCode}`; idx.set(k, (idx.get(k) || 0) + r.n); } });
    const regs = App.geo.regions;
    const head = ["종 ID", "국명", "학명", "등급", ...regs.map((r) => r.name), "합계"];
    const body = speciesOrder().map((sp) => {
      const vals = regs.map((r) => idx.get(`${sp.id}|${r.code}`) || 0);
      return [sp.id, sp.name, sp.sci, App.data.grade(sp).label, ...vals, sum(vals)];
    });
    return [head, ...body];
  };

  const sheetPeriodSpecies = (rows) => {
    const idx = new Map();
    rows.forEach((r) => { const k = `${r.spId}|${r.p}`; idx.set(k, (idx.get(k) || 0) + r.n); });
    const head = ["종 ID", "국명", "학명", "등급", ...App.data.PERIODS.map((p) => p.label), "합계"];
    const body = speciesOrder().map((sp) => {
      const vals = App.data.PERIODS.map((_, i) => idx.get(`${sp.id}|${i}`) || 0);
      return [sp.id, sp.name, sp.sci, App.data.grade(sp).label, ...vals, sum(vals)];
    });
    return [head, ...body];
  };

  // 연도(행) × 종(열): 기관 기록은 연도 집계, 시민 관찰은 관찰일 기준 (시·군·구 구분 없음)
  const sheetYearSpecies = (rows, opts) => {
    const f = scopeFilters(opts);
    const src = f.sources;
    const sps = speciesOrder().filter((sp) => App.data.speciesVisible(sp.id, f));
    const idx = new Map();
    let min = Infinity, max = 0;
    const put = (id, y, n) => {
      if (!y || !f.periods.has(App.data.periodOf(y))) return;
      idx.set(`${y}|${id}`, (idx.get(`${y}|${id}`) || 0) + n);
      if (y < min) min = y; if (y > max) max = y;
    };
    sps.forEach((sp) => {
      (S.inat[sp.id] || []).forEach((o) => { if (src[o.q ? "verified" : "pending"]) put(sp.id, o.y, 1); });
      if (src.gbif && S.gbif[sp.id]) S.gbif[sp.id].years.forEach(([y, n]) => put(sp.id, y, n));
    });
    const used = sps.filter((sp) => [...idx.keys()].some((k) => k.endsWith(`|${sp.id}`)));
    const head = ["연도", ...used.map((s) => s.name), "합계"];
    if (min === Infinity) return [head];
    const body = Array.from({ length: max - min + 1 }, (_, i) => min + i).map((y) => {
      const vals = used.map((s) => idx.get(`${y}|${s.id}`) || 0);
      return [y, ...vals, sum(vals)];
    });
    return [head, ...body];
  };

  const sheetGroups = (rows) => {
    const m = new Map();
    rows.forEach((r) => {
      let a = m.get(r.group);
      if (!a) { a = { total: 0, verified: 0, pending: 0, gbif: 0, sp: new Set(), units: new Set(), recent: new Set() }; m.set(r.group, a); }
      a.total += r.n; a[r.source] += r.n; a.sp.add(r.spId); if (r.gid) a.units.add(r.gid);
      if (r.p === 3) a.recent.add(r.spId);
    });
    const head = ["분류군", "목록 종 수", "Ⅰ급", "Ⅱ급", "기록 있는 종 수", "2020년 이후 기록된 종 수", "전체 기록", "시민 관찰·검증됨", "시민 관찰·확인 중", "기관·타 플랫폼", "출현 시군구 수"];
    const body = Object.entries(window.TAXON_GROUPS).map(([k, g]) => {
      const a = m.get(g.label) || { total: 0, verified: 0, pending: 0, gbif: 0, sp: new Set(), units: new Set(), recent: new Set() };
      const listed = S.species.filter((s) => s.group === k);
      return [g.label, listed.length, listed.filter((s) => s.grade === "en1").length, listed.filter((s) => s.grade === "en2").length,
        a.sp.size, a.recent.size, a.total, a.verified, a.pending, a.gbif, a.units.size];
    });
    return [head, ...body];
  };

  // GBIF 자료 묶음별 기록 수 (종별 상위 30개 묶음 기준 — 스냅샷에 담긴 범위)
  const sheetSources = (rows, opts) => {
    const f = scopeFilters(opts);
    const m = new Map();
    if (f.sources.gbif) {
      for (const id in S.gbif) {
        if (!App.data.speciesVisible(id, f)) continue;
        S.gbif[id].ds.forEach(([i, n]) => m.set(i, (m.get(i) || 0) + n));
      }
    }
    const head = ["플랫폼", "자료 기관", "자료 묶음", "GBIF 자료 키", "주소", "기록 수(기간 필터와 무관)"];
    const body = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([i, n]) => {
      const d = S.gbifDatasets[i] || [];
      return ["GBIF", App.sources.orgLabel(d[2]) || "", d[1] || "", d[0] || "", d[0] ? App.sources.gbifDatasetUrl(d[0]) : "", n];
    });
    const cit = rows.filter((r) => r.source !== "gbif").reduce((a, r) => a + r.n, 0);
    if (cit) body.unshift(["iNaturalist", "iNaturalist", "iNaturalist 관찰(국내)", "", "https://www.inaturalist.org", cit]);
    return [head, ...body];
  };

  // 시민 관찰 목록 — 좌표 없이 시·군·구만. 원본 주소는 iNaturalist가 위치를 흐린 관찰에만
  const sheetCitizen = (rows, opts) => {
    const f = scopeFilters(opts);
    const head = ["iNaturalist 관찰 번호", "국명", "학명", "등급", "시도", "시군구", "관찰일", "자료 종류", "관찰자", "관찰 라이선스", "사진 수", "위치 흐림(iNaturalist)", "원본 주소"];
    const body = [];
    App.data.each((spId, gid, p, source, n, o) => {
      if (!o) return;
      const sp = S.spById.get(spId);
      const u = gid ? App.geo.unit(gid) : null;
      body.push([o.obsc ? o.id : "", sp.name, sp.sci, App.data.grade(sp).label, u ? App.geo.regions[u.sido].name : "", u ? u.name : "",
        dateStr(o.date), SOURCE_LABEL[source], o.u, INAT_LICENSE[o.olic] || "", o.np, o.obsc ? "예" : "아니오", App.sources.obsUrl(o)]);
    }, { filters: f });
    body.sort((a, b) => (b[6] > a[6] ? 1 : b[6] < a[6] ? -1 : 0));
    return [head, ...body];
  };

  const gbifSearchUrl = () => {
    const keys = S.species.filter((s) => s.gbif).map((s) => `taxon_key=${s.gbif}`).join("&");
    return `https://www.gbif.org/occurrence/search?country=KR&${keys}&has_coordinate=true`;
  };

  const sheetReadme = (rows, opts) => {
    const cnt = { verified: 0, pending: 0, gbif: 0 };
    rows.forEach((r) => { cnt[r.source] += r.n; });
    const when = (v) => (v ? new Date(v).toLocaleString("ko-KR") : "-");
    const f = S.filters;
    const scopeText = opts.scope === "map"
      ? `지도 필터 적용 — 분류군 ${f.groups.size}개, 등급 ${f.grades ? [...f.grades].map((g) => window.STATUS[g].label).join("·") : "전체"}, 종 ${f.species ? f.species.size + "개 선택" : "전체"}, 기간 ${[...f.periods].map((p) => App.data.PERIODS[p].label).join("·")}`
      : "전체 자료(필터 없음)";
    return [
      ["멸종위기종 종합관리 · 시민 분포지도 — 연구용 자료"],
      [],
      ["만든 시각", new Date().toLocaleString("ko-KR")],
      ["지도 주소", SITE],
      ["범위", scopeText],
      ["기록 수", cnt.verified + cnt.pending + cnt.gbif, `시민 관찰·검증됨 ${cnt.verified} · 시민 관찰·확인 중 ${cnt.pending} · 기관·타 플랫폼 ${cnt.gbif}`],
      ["iNaturalist 자료 기준", when(S.inatSnapshotAt), `마지막 실시간 갱신 ${S.inatSyncedAt ? S.inatSyncedAt.toLocaleString("ko-KR") : "-"}`],
      ["GBIF 자료 기준", when(S.gbifAt)],
      ["공간 단위", "시·군·구 229곳(통계청 2018 경계, 일반구는 시로 합침, GBIF의 GADM 2단계 코드와 같음)"],
      [],
      ["시트 안내"],
      ...opts.sheets.map((k) => [SHEETS[k].name, SHEETS[k].desc]),
      [],
      ["자료 출처와 인용"],
      ["대상 종", "야생생물 보호 및 관리에 관한 법률 시행규칙 [별표 1] 멸종위기 야생생물(2022. 12. 9. 개정) 282종"],
      ["시민 관찰", "iNaturalist (https://www.inaturalist.org) — 국내(place_id=6891) 관찰. 관찰마다 라이선스가 다르므로 '시민 관찰' 시트의 라이선스를 확인하세요."],
      ["기관·타 플랫폼", "GBIF.org (https://www.gbif.org) — 국내 기관 조사·표본, 네이처링, eBird 등. GBIF에 이미 들어 있는 iNaturalist 기록은 중복을 막기 위해 뺐습니다."],
      ["논문 인용", "GBIF 자료를 논문에 쓰려면 아래 주소에서 같은 조건으로 직접 내려받아 DOI를 인용하세요."],
      ["GBIF 같은 조건 검색", gbifSearchUrl()],
      ["이 지도", `멸종위기종 종합관리 시민 분포지도, ${SITE} (내려받은 날짜 함께 적기)`],
      [],
      ["유의할 점"],
      ["", "멸종위기종 보호를 위해 좌표는 제공하지 않고 시·군·구 × 기간 단위 건수만 제공합니다. 정밀 위치가 필요한 연구는 원자료 기관에 직접 요청하세요."],
      ["", "기록은 조사·관찰이 많은 곳에 몰립니다. 기록이 없다고 그 지역에 없다는 뜻은 아닙니다(출현 자료, 부재 자료 아님)."],
      ["", "‘시민 관찰·확인 중’은 종이 틀렸을 수 있습니다. 분석에는 ‘검증됨’과 ‘기관·타 플랫폼’만 쓰는 것을 권합니다."],
      ["", "iNaturalist가 위치를 흐린 관찰은 실제 위치에서 수 km 떨어진 좌표로 공개되므로 이웃 시·군·구로 잡혔을 수 있습니다."],
      ["", "바다나 남한 밖 좌표 기록은 시군구 칸이 비어 있습니다(가까운 해안 25km 이내는 가장 가까운 시·군·구로 배정)."],
      ["", "동물 아종(예: 반달가슴곰 Ursus thibetanus ussuricus)은 종 단위로 모았습니다. 국내 기록은 사실상 그 아종입니다."],
    ];
  };

  const sheetColumns = () => [["열 이름(한글)", "열 이름(영문)", "설명"], ...COLUMNS.map(([, ko, en, desc]) => [ko, en, desc])];

  const rawTable = (rows, lang) => {
    const head = COLUMNS.map(([, ko, en]) => (lang === "en" ? en : ko));
    return [head, ...rows.map((r) => COLUMNS.map(([k]) => r[k] ?? ""))];
  };

  const SHEETS = {
    raw: { name: "시군구×종×기간", desc: "종·시군구·기간·자료 종류별 기록 수(한 줄에 한 칸) — 분석용 긴 형식" },
    species: { name: "종별 요약", desc: "282종 전체의 기록 수, 자료 종류별 수, 출현 시군구·시도 수, 기간별 기록 수" },
    units: { name: "시군구별 요약", desc: "시·군·구별 기록 수, 출현 종 수(등급·분류군별), 출현 종 목록" },
    unitPresence: { name: "시군구×종 출현여부", desc: "시·군·구(행) × 종(열) 출현 1 / 기록 없음 0" },
    sidoSpecies: { name: "시도×종 기록수", desc: "종(행) × 시·도(열) 기록 수" },
    periodSpecies: { name: "기간×종", desc: "종(행) × 기간(열) 기록 수 — 최근 기록이 끊긴 종 찾기에 유용" },
    yearSpecies: { name: "연도×종", desc: "연도(행) × 종(열) 기록 수(시군구 구분 없음)" },
    groups: { name: "분류군별 요약", desc: "분류군별 목록 종 수, 기록 있는 종 수, 최근 기록된 종 수" },
    citizen: { name: "시민 관찰", desc: "iNaturalist 관찰 목록(좌표 없이 시군구만, 라이선스 포함)" },
    sources: { name: "자료 출처", desc: "GBIF 자료 묶음·기관별 기록 수와 주소" },
    columns: { name: "열 설명", desc: "‘시군구×종×기간’ 시트의 열 이름과 설명" },
  };
  const BUILDERS = {
    species: sheetSpecies, units: sheetUnits, unitPresence: sheetUnitPresence, sidoSpecies: sheetSidoSpecies,
    periodSpecies: sheetPeriodSpecies, yearSpecies: sheetYearSpecies, groups: sheetGroups, citizen: sheetCitizen,
    sources: sheetSources, columns: sheetColumns,
  };

  // ---------- 파일 만들기 ----------
  const stamp = () => App.util.today().replace(/-/g, "");

  const toSheet = (XLSX, aoa, { autofilter = true } = {}) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = (aoa[0] || []).map((_, c) => {
      let w = 6;
      for (let r = 0; r < Math.min(aoa.length, 200); r++) {
        const v = aoa[r][c];
        if (v != null) w = Math.max(w, Math.min(50, String(v).length * (/[가-힣]/.test(String(v)) ? 2 : 1.1) + 2));
      }
      return { wch: Math.round(w) };
    });
    if (autofilter && aoa.length > 1 && ws["!ref"]) ws["!autofilter"] = { ref: ws["!ref"] };
    return ws;
  };

  const buildXlsx = async (rows, opts) => {
    const XLSX = await loadXLSX();
    const wb = XLSX.utils.book_new();
    wb.Props = { Title: "멸종위기종 연구용 자료", Author: "멸종위기종 종합관리 시민 분포지도", CreatedDate: new Date() };
    XLSX.utils.book_append_sheet(wb, toSheet(XLSX, sheetReadme(rows, opts), { autofilter: false }), "안내");
    for (const key of opts.sheets) {
      const aoa = key === "raw" ? rawTable(rows, opts.lang) : BUILDERS[key](rows, opts);
      XLSX.utils.book_append_sheet(wb, toSheet(XLSX, aoa), SHEETS[key].name);
    }
    const out = XLSX.write(wb, { bookType: "xlsx", type: "array", compression: true, bookSST: true });
    return { filename: `멸종위기종_연구자료_${stamp()}.xlsx`, blob: new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }) };
  };

  const buildCsv = (rows, opts) => ({
    filename: `멸종위기종_시군구별_기록_${stamp()}.csv`,
    blob: new Blob([toCSV(rawTable(rows, opts.lang))], { type: "text/csv;charset=utf-8" }),
  });

  // 시·군·구 경계에 집계를 붙인 GeoJSON
  const buildGeoJSON = (rows, opts) => {
    const m = unitAgg(rows);
    const en = opts.lang === "en";
    const feats = App.geo.sggFeatures.map((f) => {
      const u = App.geo.unit(f.properties.gid);
      const a = m.get(u.gid) || { total: 0, verified: 0, pending: 0, gbif: 0, sp: new Map() };
      const sps = [...a.sp.keys()].map((id) => S.spById.get(id));
      const p = en
        ? { gid: u.gid, province: App.geo.regions[u.sido].name, county: u.name, records: a.total, verified: a.verified, pending: a.pending, institutional: a.gbif,
          species: sps.length, en1: sps.filter((s) => s.grade === "en1").length, en2: sps.filter((s) => s.grade === "en2").length, speciesList: sps.map((s) => s.sci).join("; ") }
        : { 시군구코드: u.gid, 시도: App.geo.regions[u.sido].name, 시군구: u.name, 기록수: a.total, 검증됨: a.verified, 확인중: a.pending, 기관: a.gbif,
          출현종수: sps.length, Ⅰ급: sps.filter((s) => s.grade === "en1").length, Ⅱ급: sps.filter((s) => s.grade === "en2").length, 출현종: sps.map((s) => s.name).join(", ") };
      return { type: "Feature", properties: p, geometry: f.geometry };
    });
    return {
      filename: `멸종위기종_시군구_${stamp()}.geojson`,
      blob: new Blob([JSON.stringify({ type: "FeatureCollection", features: feats })], { type: "application/geo+json" }),
    };
  };

  const makeFile = async (opts) => {
    const rows = collect(opts);
    const file = opts.format === "xlsx" ? await buildXlsx(rows, opts)
      : opts.format === "csv" ? buildCsv(rows, opts) : buildGeoJSON(rows, opts);
    return { ...file, count: rows.reduce((a, r) => a + r.n, 0) };
  };

  // ---------- 내려받기 창 ----------
  const openDialog = (presetScope = "all") => {
    const cnt = { verified: 0, pending: 0, gbif: 0 };
    App.data.each((id, gid, p, source, n) => { cnt[source] += n; }, { filters: ALL_FILTERS({ verified: true, pending: true, gbif: true }) });
    const sheetChecks = Object.entries(SHEETS).map(([k, s]) => `
      <label class="check sheet-check"><input type="checkbox" name="sheet" value="${k}" checked>
        <span><b>${esc(s.name)}</b><small>${esc(s.desc)}</small></span></label>`).join("");
    const html = `
      <form class="export-form" id="export-form" novalidate>
        <p class="muted small" style="margin-top:0">🔒 멸종위기종 보호를 위해 좌표는 내려받을 수 없고, 시·군·구 × 기간 단위 집계만 제공합니다.</p>
        <fieldset>
          <legend>범위</legend>
          <label class="check"><input type="radio" name="scope" value="all" ${presetScope === "all" ? "checked" : ""}> 모든 자료</label>
          <label class="check"><input type="radio" name="scope" value="map" ${presetScope === "map" ? "checked" : ""}> 지금 지도에 걸어 둔 조건 그대로(분류군·등급·종·기간·기록 종류)</label>
        </fieldset>
        <fieldset id="export-sources">
          <legend>기록 종류</legend>
          <label class="check"><input type="checkbox" name="src" value="verified" checked> 시민 관찰·검증됨 <span class="muted">${fmt(cnt.verified)}건</span></label>
          <label class="check"><input type="checkbox" name="src" value="pending" checked> 시민 관찰·확인 중 <span class="muted">${fmt(cnt.pending)}건 · 종이 틀렸을 수 있음</span></label>
          <label class="check"><input type="checkbox" name="src" value="gbif" checked> 기관·타 플랫폼(GBIF) <span class="muted">${fmt(cnt.gbif)}건</span></label>
        </fieldset>
        <fieldset>
          <legend>형식</legend>
          <label class="check"><input type="radio" name="format" value="xlsx" checked> 엑셀(.xlsx) — 집계표를 시트별로</label>
          <label class="check"><input type="radio" name="format" value="csv"> CSV — 시군구×종×기간 긴 형식 한 표(R·Python·엑셀)</label>
          <label class="check"><input type="radio" name="format" value="geojson"> GeoJSON — 시·군·구 경계 + 출현 종 수(QGIS 등)</label>
        </fieldset>
        <fieldset>
          <legend>열 이름</legend>
          <label class="check"><input type="radio" name="lang" value="ko" checked> 한글</label>
          <label class="check"><input type="radio" name="lang" value="en"> 영문(분석 프로그램용)</label>
        </fieldset>
        <fieldset id="export-sheets">
          <legend>엑셀에 넣을 시트 <span class="muted">(‘안내’ 시트는 항상 포함)</span></legend>
          <div class="sheet-grid">${sheetChecks}</div>
        </fieldset>
        <div class="export-foot">
          <span class="muted" id="export-count"></span>
          <button type="submit" class="btn btn-primary" id="export-go">내려받기</button>
        </div>
        <p class="muted small">논문 등에 쓸 때는 ‘안내’ 시트의 인용 방법을 따라 주세요.</p>
      </form>`;
    App.ui.openModal("연구용 자료 내려받기", html, (body) => {
      const form = body.querySelector("form");
      const readOpts = () => {
        const fd = new FormData(form);
        const sources = { verified: false, pending: false, gbif: false };
        fd.getAll("src").forEach((k) => { sources[k] = true; });
        return { scope: fd.get("scope"), format: fd.get("format"), lang: fd.get("lang"), sources, sheets: fd.getAll("sheet") };
      };
      const update = () => {
        const o = readOpts();
        body.querySelector("#export-sources").disabled = o.scope === "map";
        body.querySelector("#export-sheets").hidden = o.format !== "xlsx";
        const rows = collect(o);
        const n = rows.reduce((a, r) => a + r.n, 0);
        body.querySelector("#export-count").textContent = `기록 ${fmt(n)}건 · 집계 ${fmt(rows.length)}줄`;
        body.querySelector("#export-go").disabled = !n;
      };
      form.addEventListener("change", update);
      update();
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = body.querySelector("#export-go");
        const o = readOpts();
        btn.disabled = true;
        btn.textContent = "파일 만드는 중…";
        await new Promise((r) => setTimeout(r, 30));
        try {
          const file = await makeFile(o);
          download(file.filename, file.blob);
          toast(`기록 ${fmt(file.count)}건을 파일로 저장했습니다.`);
        } catch (err) {
          console.warn(err);
          toast(err.message || "파일을 만들지 못했습니다.", 5000);
        } finally {
          btn.disabled = false;
          btn.textContent = "내려받기";
        }
      });
    });
  };

  return { openDialog, collect, makeFile, loadXLSX, SHEETS, COLUMNS };
})();
