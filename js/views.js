// 종 도감, 통계, 참여하기, 자료 안내 화면
App.views = (() => {
  const { $, esc, fmt, seqColor, toCSV, download } = App.util;
  const S = App.state;
  const R = () => App.geo.regions;
  const SRC = () => App.sources;
  const P = () => App.data.PERIODS;

  const ALL = { verified: true, pending: true, gbif: true };
  const allFilters = (sources = ALL) => ({
    groups: new Set(Object.keys(window.TAXON_GROUPS)), species: null, grades: null, periods: App.data.ALL_PERIODS(), sources,
  });

  const groupBadge = (sp) => {
    const g = App.data.group(sp);
    return `<span class="badge" style="background:${g.color}1a;color:${g.color}">${esc(g.label)}</span>`;
  };
  const short = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const fmtDate = (d) => (d ? `${String(d).slice(0, 4)}.${Number(String(d).slice(4, 6))}.${Number(String(d).slice(6, 8))}` : "날짜 미상");
  const daysAgo = (n) => {
    const d = new Date(Date.now() - n * 86400000);
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  };

  const barList = (rows, { color, onClickAttr } = {}) => {
    const max = Math.max(1, ...rows.map((r) => r.value));
    return `<div class="bars">${rows.map((r) => `
      <div class="bar-row ${onClickAttr ? "clickable" : ""}" ${onClickAttr ? `${onClickAttr}="${esc(r.key)}"` : ""} title="${esc(r.title || r.label)}: ${fmt(r.value)}">
        <span class="bar-label">${r.html || esc(r.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="display:block;width:${(r.value / max) * 100}%;background:${r.color || color || "var(--primary)"}"></span></span>
        <span class="bar-val">${fmt(r.value)}</span>
      </div>`).join("")}</div>`;
  };

  const vbars = (labels, vals, tickEvery = 2) => {
    const max = Math.max(1, ...vals);
    return `<div class="vbars">${labels.map((lab, i) => `
      <div class="vbar" title="${esc(lab)}: ${fmt(vals[i])}건">
        <span class="vval">${vals[i] ? short(vals[i]) : ""}</span>
        <span class="vfill" style="height:${(vals[i] / max) * 100}%"></span>
        <span class="vlab">${(labels.length - 1 - i) % tickEvery === 0 ? esc(lab) : ""}</span>
      </div>`).join("")}</div>`;
  };

  const yearBars = (yearMap, span = 20) => {
    const now = new Date().getFullYear();
    const years = Array.from({ length: span }, (_, i) => now - span + 1 + i);
    return vbars(years.map((y) => String(y).slice(2)), years.map((y) => yearMap.get(y) || 0));
  };

  const IUCN = { EX: "절멸", EW: "야생절멸", CR: "위급", EN: "위기", VU: "취약", NT: "준위협", LC: "관심대상", DD: "정보부족" };
  const iucnBadge = (sp) => (sp.iucn && IUCN[sp.iucn]
    ? `<span class="badge badge-gray" title="IUCN 적색목록(전 세계 기준)">IUCN ${esc(sp.iucn)} ${IUCN[sp.iucn]}</span>` : "");
  const wikiText = (spId) => ((S.inatTaxa[spId] || {}).wiki || "").replace(/<[^>]+>/g, "").trim();

  const kpi = (label, value, sub = "") =>
    `<div class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;

  // 관찰 사진 카드 (CC 라이선스 사진만 저장되어 있음). 원본 링크는 위치를 흐린 관찰에만
  const photoThumb = (spId, o) => {
    const sp = S.spById.get(spId) || { name: "" };
    const st = App.data.SOURCES[o.q ? "verified" : "pending"];
    const u = o.gid ? App.geo.unit(o.gid) : null;
    const url = SRC().obsUrl(o);
    const inner = `<span class="obs-img"><img src="${SRC().photoUrl(o.ph, "small")}" alt="${esc(sp.name)} 관찰 사진" loading="lazy">
        <span class="badge ${st.badge} obs-badge">${st.short}</span></span>
      <span class="obs-meta"><b>${esc(sp.name)}</b><span>${fmtDate(o.date)}${u ? ` · ${esc(u.full)}` : ""}</span>
        <span class="obs-credit">© ${esc(o.u)} · ${esc(SRC().licenseLabel(o.lic))}</span></span>`;
    return url ? `<a class="obs-card" href="${url}" target="_blank" rel="noopener" title="${esc(sp.name)} · ${esc(o.u)}">${inner}</a>`
      : `<span class="obs-card" title="${esc(sp.name)} · ${esc(o.u)}">${inner}</span>`;
  };

  const empty = () => ({ total: 0, verified: 0, pending: 0, gbif: 0, units: new Map(), sido: new Int32Array(17), periods: [0, 0, 0, 0, 0], sea: 0 });
  const nSido = (x) => x.sido.reduce((a, v) => a + (v > 0 ? 1 : 0), 0);

  // ================= 종 도감 =================
  const catalogState = { q: "", group: null, grade: null, sort: "group" };

  const renderSpecies = () => {
    const stats = App.data.bySpecies({ filters: allFilters() });
    const q = catalogState.q.trim().toLowerCase();
    const groupOrder = Object.keys(window.TAXON_GROUPS);
    const st = (s) => stats.get(s.id) || empty();
    let list = S.species.filter((s) => (!catalogState.group || s.group === catalogState.group) &&
      (!catalogState.grade || s.grade === catalogState.grade) &&
      (!q || [s.name, s.sci, s.family].some((v) => (v || "").toLowerCase().includes(q))));
    const sorters = {
      group: (a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) || a.grade.localeCompare(b.grade) || a.name.localeCompare(b.name, "ko"),
      grade: (a, b) => a.grade.localeCompare(b.grade) || groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group),
      records: (a, b) => st(b).total - st(a).total,
      citizen: (a, b) => (st(b).verified + st(b).pending) - (st(a).verified + st(a).pending),
      units: (a, b) => st(b).units.size - st(a).units.size || st(b).total - st(a).total,
      scarce: (a, b) => st(a).periods[3] - st(b).periods[3] || st(a).total - st(b).total,
      name: (a, b) => a.name.localeCompare(b.name, "ko"),
    };
    list = list.sort(sorters[catalogState.sort]);

    const n1 = S.species.filter((s) => s.grade === "en1").length;
    $("#species-sub").textContent = `멸종위기 야생생물 ${S.species.length}종 (Ⅰ급 ${n1}종 · Ⅱ급 ${S.species.length - n1}종) · 사진은 iNaturalist 참여자가 CC 라이선스로 공개한 것입니다.`;
    $("#catalog-status").innerHTML = [`<button class="chip ${!catalogState.grade ? "on" : ""}" data-st="">모든 등급</button>`,
      ...Object.entries(window.STATUS).map(([k, g]) =>
        `<button class="chip ${catalogState.grade === k ? "on" : ""}" data-st="${k}"><span class="dot" style="background:${g.color}"></span>${esc(g.label)}</button>`)].join("");
    $("#catalog-groups").innerHTML = [`<button class="chip ${!catalogState.group ? "on" : ""}" data-g="">전체</button>`,
      ...Object.entries(window.TAXON_GROUPS).map(([k, g]) =>
        `<button class="chip ${catalogState.group === k ? "on" : ""}" data-g="${k}"><span class="dot" style="background:${g.color}"></span>${g.label}</button>`)].join("");

    $("#catalog-grid").innerHTML = list.length ? list.map((s) => {
      const c = App.data.group(s).color;
      const x = st(s);
      const max = Math.max(1, ...x.sido);
      const strip = R().map((r, i) => {
        const v = x.sido[i];
        return `<span title="${esc(r.short)} ${fmt(v)}건" style="${v ? `background:${c};opacity:${0.25 + 0.75 * (Math.log1p(v) / Math.log1p(max))}` : ""}"></span>`;
      }).join("");
      const t = S.inatTaxa[s.id] || {};
      return `<article class="sp-card" style="--c:${c}" data-id="${esc(s.id)}" tabindex="0">
        <div class="sp-photo">${t.photo
          ? `<img src="${SRC().photoUrl(t.photo, "small")}" alt="${esc(s.name)}" loading="lazy" title="${esc(t.by || "")}">`
          : `<span class="sp-photo-empty">사진 없음</span>`}
          <span class="sp-photo-group">${esc(App.data.group(s).label)}</span>
        </div>
        <div class="sp-card-body">
          <h4>${esc(s.name)}</h4>
          <div class="sci">${esc(s.sci || "")}</div>
          <div class="meta">${App.data.gradeBadge(s)}${iucnBadge(s)}</div>
          <p class="desc">${esc(s.note || wikiText(s.id) || s.family || "")}</p>
          <div class="mini-regions" title="시·도별 분포 (서울→제주)">${strip}</div>
          <div class="nums">
            <span><b>${x.units.size}</b> 시·군·구</span>
            <span><b>${fmt(x.periods[3])}</b> 2020년 이후</span>
            <span><b>${fmt(x.total)}</b> 전체</span>
          </div>
        </div>
      </article>`;
    }).join("") : `<div class="empty-state"><p>검색 결과가 없습니다.</p></div>`;
  };

  const speciesDetail = (id) => {
    const s = S.spById.get(id);
    if (!s) return;
    const x = App.data.bySpecies({ filters: { ...allFilters(), species: new Set([id]) } }).get(id) || empty();
    const years = App.data.byYear({ filters: { ...allFilters(), species: new Set([id]) } });
    const sidoRows = R().map((r, i) => ({ key: i, label: r.name, value: x.sido[i] })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
    const unitRows = [...x.units.entries()].map(([gid, v]) => ({ key: gid, label: App.geo.unit(gid).full, value: v })).sort((a, b) => b.value - a.value);
    const color = App.data.group(s).color;
    const t = S.inatTaxa[id] || {};
    const recent = App.data.recentInat({ spId: id, withPhoto: true, limit: 8 });
    const e = S.gbif[id];
    const ds = e ? e.ds.slice(0, 5).map(([i, n]) => {
      const d = S.gbifDatasets[i] || [];
      return `${esc([SRC().orgLabel(d[2]), d[1]].filter(Boolean).join(" · "))} <span class="muted">${fmt(n)}건</span>`;
    }) : [];
    const html = `
      <div class="detail-grid">
        <div class="detail-info">
          ${t.photo ? `<figure class="detail-photo"><img src="${SRC().photoUrl(t.photo, "medium")}" alt="${esc(s.name)}"><figcaption>${esc(t.by || "")}</figcaption></figure>` : ""}
          <p style="margin-top:0">${groupBadge(s)} ${App.data.gradeBadge(s)} <i class="muted">${esc(s.sci || "")}</i></p>
          <dl>
            <dt>분류</dt><dd>${esc(App.data.group(s).label)} · ${esc(s.family || "-")}</dd>
            <dt>보전 등급</dt><dd>${esc(App.data.grade(s).label)} (야생생물법 시행규칙 별표 1)</dd>
            <dt>IUCN</dt><dd>${iucnBadge(s) || "-"}</dd>
            <dt>위치 공개</dt><dd>보호를 위해 시·군·구 단위로만 보여 줍니다.</dd>
            ${s.note ? `<dt>참고</dt><dd>${esc(s.note)}</dd>` : ""}
            ${wikiText(id) ? `<dt>설명</dt><dd>${esc(wikiText(id))} <span class="muted small">— 위키백과(CC BY-SA)</span></dd>` : ""}
            <dt>기록</dt><dd>시민 관찰 검증됨 ${fmt(x.verified)} · 확인 중 ${fmt(x.pending)} · 기관 ${fmt(x.gbif)}${x.sea ? ` · 지도 밖(바다 등) ${fmt(x.sea)}` : ""}</dd>
            ${ds.length ? `<dt>기관 기록 출처</dt><dd>${ds.join("<br>")}</dd>` : ""}
          </dl>
          <div class="actions" style="margin-top:16px">
            <button class="btn btn-primary" id="d-map">지도에서 보기</button>
            ${s.inat ? `<a class="btn btn-light" href="${SRC().taxonUrl(s.inat)}" target="_blank" rel="noopener">iNaturalist 종 정보 ↗</a>` : ""}
            ${s.gbif ? `<a class="btn btn-light" href="${SRC().gbifSpeciesUrl(s.gbif)}" target="_blank" rel="noopener">GBIF 종 정보 ↗</a>` : ""}
            ${s.inat && x.pending ? `<a class="btn btn-light" href="${SRC().identifyUrl([s.inat])}" target="_blank" rel="noopener">확인 돕기 (${fmt(x.pending)}건) ↗</a>` : ""}
          </div>
        </div>
        <div>
          <h3>시기별 기록</h3>
          ${barList(P().map((p, i) => ({ key: i, label: p.label, value: x.periods[i] })), { color })}
          <h3 style="margin-top:18px">시·도별 기록 <small class="muted">${sidoRows.length}/17곳</small></h3>
          ${sidoRows.length ? barList(sidoRows, { color }) : `<p class="muted">기록이 없습니다.</p>`}
          ${unitRows.length ? `<h3 style="margin-top:18px">시·군·구 <small class="muted">${unitRows.length}곳${unitRows.length > 12 ? ", 많은 순 12곳" : ""}</small></h3>
            ${barList(unitRows.slice(0, 12), { color })}` : ""}
          <h3 style="margin-top:18px">연도별 기록 <small class="muted">(최근 20년)</small></h3>
          ${yearBars(years)}
          ${recent.length ? `<h3 style="margin-top:18px">최근 시민 관찰</h3><div class="obs-grid compact">${recent.map(({ spId, o }) => photoThumb(spId, o)).join("")}</div>` : ""}
        </div>
      </div>`;
    App.ui.openModal(s.name, html, (body) => {
      body.querySelector("#d-map").onclick = () => { App.ui.closeModal(); App.ui.selectOnlySpecies(id); };
    });
  };

  // ================= 통계 =================
  let statsSource = "all";
  const STATS_SOURCES = {
    all: ALL,
    citizen: { verified: true, pending: true, gbif: false },
    verified: { verified: true, pending: false, gbif: false },
    gbif: { verified: false, pending: false, gbif: true },
  };

  const citizenStats = () => {
    const users = new Set();
    let verified = 0, pending = 0, last30 = 0;
    const since = daysAgo(30);
    for (const id in S.inat) for (const o of S.inat[id]) {
      users.add(o.u);
      if (o.q) verified++; else pending++;
      if (o.date >= since) last30++;
    }
    return { users: users.size, verified, pending, last30 };
  };

  const renderStats = () => {
    const filters = allFilters(STATS_SOURCES[statsSource]);
    const sido = App.data.bySido({ filters });
    const units = App.data.byUnit({ filters });
    const sps = App.data.bySpecies({ filters });
    const total = [...sps.values()].reduce((a, s) => a + s.total, 0);
    const cs = citizenStats();
    let richest = null;
    units.units.forEach((a, gid) => { if (!richest || a.species.size > richest.n) richest = { gid, n: a.species.size }; });
    const recentSp = [...sps.values()].filter((s) => s.periods[3] > 0).length;

    $("#stats-kpis").innerHTML = [
      kpi("선택한 자료의 기록", `${fmt(total)}<small>건</small>`, `기록 있는 종 ${sps.size}/${S.species.length}`),
      kpi("2020년 이후 기록된 종", `${recentSp}<small>종</small>`, `${S.species.length - recentSp}종은 최근 기록 없음`),
      kpi("시민 관찰", `${fmt(cs.verified + cs.pending)}<small>건</small>`, `검증됨 ${fmt(cs.verified)} · 확인 중 ${fmt(cs.pending)}`),
      kpi("참여자", `${fmt(cs.users)}<small>명</small>`, `최근 30일 새 관찰 ${fmt(cs.last30)}건`),
      kpi("기록이 있는 시·군·구", `${units.units.size}<small>/${App.geo.units.length}</small>`),
      kpi("가장 많은 종이 기록된 곳", richest ? esc(App.geo.unit(richest.gid).full) : "-", richest ? `${richest.n}종` : ""),
    ].join("");

    const sidoSp = R().map((r, i) => ({ key: r.code, label: r.name, value: sido.regions[i].species.size })).sort((a, b) => b.value - a.value);
    $("#chart-region-species").innerHTML = barList(sidoSp, { color: "#c92a2a", onClickAttr: "data-sido" });
    const sidoRec = R().map((r, i) => ({ key: r.code, label: r.name, value: sido.regions[i].records })).sort((a, b) => b.value - a.value);
    $("#chart-region").innerHTML = barList(sidoRec, { onClickAttr: "data-sido" });

    const groupRows = Object.entries(window.TAXON_GROUPS).map(([k, g]) => {
      const listed = S.species.filter((s) => s.group === k).length;
      let n = 0;
      sps.forEach((s, id) => { if (S.spById.get(id).group === k) n++; });
      return { key: k, label: `${g.label} (${n}/${listed}종)`, title: `${g.label}: 기록 있는 종 ${n} / 목록 ${listed}종`, value: n, color: g.color };
    });
    $("#chart-group").innerHTML = barList(groupRows);

    const per = [0, 0, 0, 0, 0];
    sps.forEach((s) => s.periods.forEach((v, i) => { per[i] += v; }));
    $("#chart-period").innerHTML = barList(P().map((p, i) => ({ key: i, label: p.label, value: per[i] })), { color: "#1c7ed6" });

    $("#chart-year").innerHTML = yearBars(App.data.byYear({ filters }));

    // 최근(2010년 이후) 기록이 없는 종
    const silent = S.species.filter((s) => { const x = sps.get(s.id); return !x || !(x.periods[2] + x.periods[3]); })
      .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name, "ko"));
    $("#silent-species").innerHTML = silent.length
      ? `<p class="muted small">${silent.length}종 · 오래된 기록만 있거나 공개된 기록이 없는 종입니다. 실제로 사라졌다는 뜻은 아닙니다(조사·공개가 안 된 경우가 많음).</p>
        <div class="chip-row">${silent.map((s) => `<button class="chip" data-detail="${esc(s.id)}"><span class="dot" style="background:${App.data.colorOf(s.id)}"></span>${esc(s.name)}</button>`).join("")}</div>`
      : `<p class="muted">모든 종에 2010년 이후 기록이 있습니다.</p>`;

    // 월별 시민 관찰 (최근 24개월)
    const now = new Date();
    const months = Array.from({ length: 24 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 23 + i, 1);
      return d.getFullYear() * 100 + d.getMonth() + 1;
    });
    const mcount = new Map(months.map((m) => [m, 0]));
    for (const id in S.inat) for (const o of S.inat[id]) {
      const m = Math.floor(o.date / 100);
      if (mcount.has(m)) mcount.set(m, mcount.get(m) + 1);
    }
    $("#chart-month").innerHTML = vbars(months.map((m) => `${m % 100}월`), months.map((m) => mcount.get(m)), 3);

    renderMatrix(sps);
  };

  let lastMatrix = null;
  const renderMatrix = (sps) => {
    const order = Object.keys(window.TAXON_GROUPS);
    const rows = S.species.map((s) => ({ s, x: sps.get(s.id) }))
      .sort((a, b) => order.indexOf(a.s.group) - order.indexOf(b.s.group) || (b.x ? b.x.total : 0) - (a.x ? a.x.total : 0));
    lastMatrix = rows;
    let max = 1;
    rows.forEach(({ x }) => x && x.sido.forEach((v) => { if (v > max) max = v; }));
    const head = `<thead><tr><th>종 \\ 시·도</th>${R().map((r) => `<th title="${esc(r.name)}">${esc(r.short)}</th>`).join("")}<th class="tot">시·군·구</th><th class="tot">합계</th></tr></thead>`;
    const body = rows.map(({ s, x }) => {
      const cells = R().map((r, i) => {
        const v = x ? x.sido[i] : 0;
        if (!v) return "<td></td>";
        const t = Math.log1p(v) / Math.log1p(max);
        return `<td style="background:${seqColor(t)};color:${t > 0.55 ? "#fff" : "#1d2a20"}" title="${esc(s.name)} · ${esc(r.name)}: ${fmt(v)}건">${short(v)}</td>`;
      }).join("");
      return `<tr><th data-sp="${esc(s.id)}" style="cursor:pointer"><span class="dot" style="background:${App.data.colorOf(s.id)}"></span>${esc(s.name)} <small class="muted">${esc(App.data.grade(s).short)}</small></th>${cells}
        <td class="tot">${x ? x.units.size : 0}</td><td class="tot">${x ? short(x.total) : 0}</td></tr>`;
    }).join("");
    $("#matrix").innerHTML = `<table class="matrix">${head}<tbody>${body}</tbody></table>`;
  };

  const matrixCSV = () => {
    if (!lastMatrix) return;
    const head = ["종", "학명", "등급", "분류군", ...R().map((r) => r.name), "출현 시·군·구 수", "합계"];
    const rows = lastMatrix.map(({ s, x }) => [s.name, s.sci, App.data.grade(s).label, App.data.group(s).label,
      ...R().map((r, i) => (x ? x.sido[i] : 0)), x ? x.units.size : 0, x ? x.total : 0]);
    download(`시도별_멸종위기종_분포현황_${App.util.today()}.csv`, toCSV([head, ...rows]), "text/csv;charset=utf-8");
  };

  const setStatsSource = (src) => { statsSource = src; renderStats(); };

  // ================= 참여하기 =================
  const renderJoin = () => {
    const cs = citizenStats();
    const since7 = daysAgo(7);
    let last7 = 0;
    for (const id in S.inat) for (const o of S.inat[id]) if (o.date >= since7) last7++;
    $("#join-kpis").innerHTML = [
      kpi("지금까지 시민 관찰", `${fmt(cs.verified + cs.pending)}<small>건</small>`, `참여자 ${fmt(cs.users)}명`),
      kpi("최근 7일 새 관찰", `${fmt(last7)}<small>건</small>`, `최근 30일 ${fmt(cs.last30)}건`),
      kpi("확인을 기다리는 관찰", `${fmt(cs.pending)}<small>건</small>`, "종 이름을 아시면 도와주세요"),
    ].join("");
    $("#join-identify").href = SRC().identifyUrl(S.species.filter((s) => s.inat).map((s) => s.inat));

    // 한 사람이 같은 종을 몰아서 올린 경우 2장까지만 보여 다양하게
    const seen = new Map();
    const recent = App.data.recentInat({ withPhoto: true, limit: 400 }).filter(({ spId, o }) => {
      const k = `${o.u}|${spId}`;
      seen.set(k, (seen.get(k) || 0) + 1);
      return seen.get(k) <= 2;
    }).slice(0, 24);
    $("#join-recent").innerHTML = recent.length ? recent.map(({ spId, o }) => photoThumb(spId, o)).join("")
      : `<p class="muted">아직 불러온 관찰이 없습니다.</p>`;

    // 최근 1년 많이 기록한 참여자
    const since = daysAgo(365);
    const byUser = new Map();
    for (const id in S.inat) for (const o of S.inat[id]) if (o.date >= since) byUser.set(o.u, (byUser.get(o.u) || 0) + 1);
    const top = [...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    $("#join-top").innerHTML = top.length ? `<ol class="rank">${top.map(([u, n]) =>
      `<li><a href="https://www.inaturalist.org/people/${encodeURIComponent(u)}" target="_blank" rel="noopener">${esc(u)}</a><span>${fmt(n)}건</span></li>`).join("")}</ol>`
      : `<p class="muted">최근 1년 기록이 없습니다.</p>`;
  };

  // ================= 자료 안내 =================
  const renderAbout = () => {
    const cs = citizenStats();
    let gbifN = 0;
    const byOrg = new Map();
    for (const id in S.gbif) {
      const e = S.gbif[id];
      gbifN += e.total;
      e.ds.forEach(([i, n]) => {
        const d = S.gbifDatasets[i];
        const org = SRC().orgLabel(d ? d[2] : "") || "기타";
        byOrg.set(org, (byOrg.get(org) || 0) + n);
      });
    }
    const when = (iso) => (iso ? new Date(iso).toLocaleString("ko-KR") : "-");
    const withRec = S.species.filter((s) => (S.gbif[s.id] && S.gbif[s.id].total) || (S.inat[s.id] && S.inat[s.id].length)).length;
    $("#about-status").innerHTML = `
      <div><b>대상</b> 멸종위기 야생생물 ${S.species.length}종 중 ${withRec}종에 공개 기록이 있습니다.</div>
      <div style="margin-top:8px"><b>시민 관찰(iNaturalist)</b> ${fmt(cs.verified + cs.pending)}건 — 검증됨 ${fmt(cs.verified)}, 확인 중 ${fmt(cs.pending)}</div>
      <div class="muted">기본 자료 ${when(S.inatSnapshotAt)} · 마지막 실시간 갱신 ${S.inatSyncedAt ? S.inatSyncedAt.toLocaleString("ko-KR") : "아직 없음"}</div>
      <div style="margin-top:8px"><b>기관·타 플랫폼 기록(GBIF)</b> ${fmt(gbifN)}건 · 자료 기준 ${when(S.gbifAt)}</div>
      <div class="muted">${[...byOrg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([o, n]) => `${esc(o)} ${fmt(n)}건`).join(" · ")}</div>`;
  };

  return {
    catalogState, renderSpecies, speciesDetail, renderStats, setStatsSource, matrixCSV, renderJoin, renderAbout,
  };
})();
