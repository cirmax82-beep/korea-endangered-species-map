// 분포지도 (Leaflet + OpenStreetMap) — 시·군·구(또는 시·도) 단위로 칠하거나, 약 250m 격자 열지도로 보여 줌
App.map = (() => {
  const { esc, fmt, seqColor, SEQ } = App.util;
  const S = App.state;
  const SRC = () => App.sources;

  let map, sggLayer, sidoLayer, sidoLines, heat;
  let heatInfo = { cells: 0, records: 0 };
  let open = null;          // { kind: "sgg"|"sido", key }
  let scale = { max: 0, min: 0, metric: "species" };

  const fmtDate = (d) => (d ? `${String(d).slice(0, 4)}.${Number(String(d).slice(4, 6))}.${Number(String(d).slice(6, 8))}` : "날짜 미상");

  const init = () => {
    map = L.map("map", { minZoom: 6, maxZoom: 13, maxBounds: [[30.5, 121], [40.5, 134.5]], zoomSnap: 0.5 })
      .setView([36.0, 127.8], 7);
    const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
    const osm = (cls) => L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: osmAttr, className: cls });
    const base = {
      "밝은 지도": osm("tiles-muted"),
      "일반 지도": osm(""),
      "위성 영상": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19, attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics",
      }),
    };
    base["밝은 지도"].addTo(map);
    L.control.layers(base, null, { position: "topright" }).addTo(map);
    L.control.scale({ imperial: false, position: "bottomright" }).addTo(map);
    map.attributionControl.addAttribution('기록: <a href="https://www.inaturalist.org" target="_blank" rel="noopener">iNaturalist</a>, <a href="https://www.gbif.org" target="_blank" rel="noopener">GBIF</a> · 경계: 통계청');

    // 열지도에서는 시·군·구 경계만 옅게(눌러서 지역 패널을 여는 용도)
    const rest = () => (S.mapUnit === "heat" ? { weight: 0.5, color: "#7d8a7e" } : { weight: 0.6, color: "#ffffff" });
    const hover = (layer, on) => layer.setStyle(on ? { weight: 2.4, color: "#173a24" } : rest());
    sggLayer = L.geoJSON(window.KR_SGG, {
      style: () => ({ weight: 0.6, color: "#fff", fillOpacity: 0.85, fillColor: "#eee" }),
      onEachFeature: (feat, layer) => {
        layer.on({
          // bringToFront는 쓰지 않음 — 크롬에서 요소를 다시 붙이면 클릭이 사라짐
          mouseover: (e) => hover(e.target, true),
          mouseout: (e) => hover(e.target, false),
          click: () => showPanel("sgg", feat.properties.gid),
        });
      },
    });
    sidoLayer = L.geoJSON(window.KR_SIDO, {
      style: () => ({ weight: 0.6, color: "#fff", fillOpacity: 0.85, fillColor: "#eee" }),
      onEachFeature: (feat, layer) => {
        layer.on({
          mouseover: (e) => hover(e.target, true),
          mouseout: (e) => hover(e.target, false),
          click: () => showPanel("sido", feat.properties.code),
        });
      },
    });
    sidoLines = L.geoJSON(window.KR_SIDO, { interactive: false, style: { className: "prov-line", weight: 1.3, opacity: 1, fill: false } });
    heat = L.heatLayer([], {
      radius: HEAT.radius, blur: 14, maxZoom: HEAT.maxZoom, minOpacity: 0.04, max: 1,
      gradient: { 0.2: "#4dabf7", 0.4: "#51cf66", 0.6: "#fcc419", 0.8: "#ff922b", 1: "#e03131" },
    });
    map.on("zoomend", () => { if (map.hasLayer(heat)) heat.setOptions({ max: heatMax() }); });
  };

  // 진하기 기준: 지금 확대 수준에서 열지도 플러그인과 같은 방식으로 칸(반지름의 절반)마다 세기를 더해 보고,
  // 상위 0.5% 칸이 가장 진하게 되도록 맞춤 — 전국을 볼 때 온통 빨갛게 포화되지 않게
  const HEAT = { radius: 12, maxZoom: 12, top: 0.995 };
  let heatPts = [];
  const heatMax = () => {
    const z = map.getZoom();
    const size = HEAT.radius / 2;
    const v = 1 / Math.pow(2, Math.max(0, Math.min(HEAT.maxZoom - z, 12)));
    const cells = new Map();
    for (const [lat, lng, w] of heatPts) {
      const p = map.project([lat, lng], z);
      const k = `${Math.floor(p.x / size)}|${Math.floor(p.y / size)}`;
      cells.set(k, (cells.get(k) || 0) + w * v);
    }
    const sums = [...cells.values()].sort((a, b) => a - b);
    return sums.length ? Math.max(1e-6, sums[Math.floor(sums.length * HEAT.top)]) : 1;
  };

  // 격자 하나의 세기는 건수의 로그(조사 지점 한 곳에 기록이 몰려도 지도를 다 덮지 않게)
  const renderHeat = (on) => {
    if (!on) { if (map.hasLayer(heat)) map.removeLayer(heat); return; }
    const pts = App.data.heatPoints();
    heatInfo = { cells: pts.length, records: pts.reduce((a, p) => a + p[2], 0) };
    heatPts = pts.map(([lat, lng, n]) => [lat, lng, Math.log1p(n)]);
    heat.setOptions({ max: heatMax() });
    heat.setLatLngs(heatPts);
    if (!map.hasLayer(heat)) map.addLayer(heat);
  };

  const sidoIdx = (code) => App.geo.regions.findIndex((r) => r.code === code);

  // 현재 필터 기준 집계: key(gid 또는 시·도 코드) → { records, bySource, species }
  const statsFor = (unit) => {
    if (unit === "sgg") return App.data.byUnit().units;
    const r = App.data.bySido();
    return new Map(App.geo.regions.map((reg, i) => [reg.code, r.regions[i]]));
  };

  const tooltip = (name, a) => {
    if (!a) return `<b>${esc(name)}</b><br><span class="muted">기록 없음</span>`;
    const b = a.bySource;
    const g = { en1: 0, en2: 0 };
    a.species.forEach((n, id) => { const sp = S.spById.get(id); if (sp) g[sp.grade]++; });
    return `<b>${esc(name)}</b><br>${a.species.size}종 · 기록 ${fmt(a.records)}건<br>` +
      `<span class="muted">Ⅰ급 ${g.en1}종 · Ⅱ급 ${g.en2}종</span><br>` +
      `<span class="muted">검증됨 ${fmt(b.verified)} · 확인 중 ${fmt(b.pending)} · 기관 ${fmt(b.gbif)}</span>`;
  };

  // 한 종만 고르면 출현 종 수는 모두 1이라 기록 수로 칠함
  const metricNow = () => (S.filters.species && S.filters.species.size === 1 ? "records" : S.choroMetric);

  const paint = (layer, stats, keyOf, nameOf, ghost = false) => {
    const metric = metricNow();
    const val = (a) => (!a ? 0 : metric === "species" ? a.species.size : a.records);
    const vals = [...stats.values()].map(val).filter((v) => v > 0);
    const max = vals.length ? Math.max(...vals) : 0;
    const min = vals.length ? Math.min(...vals) : 0;
    scale = { max, min, metric };
    const f = metric === "species" ? (v) => v : Math.log;
    const span = f(max) - f(min || 1);
    layer.eachLayer((l) => {
      const key = keyOf(l.feature.properties);
      const a = stats.get(key);
      const v = val(a);
      const t = !v ? 0 : span > 0 ? 0.1 + 0.9 * ((f(v) - f(min)) / span) : 1;
      l.setStyle(ghost ? { fillOpacity: 0, weight: 0.5, color: "#7d8a7e" }
        : { fillColor: seqColor(t) || "#f4f5f2", fillOpacity: v ? 0.85 : 0.55, weight: 0.6, color: "#ffffff" });
      l.unbindTooltip();
      l.bindTooltip(tooltip(nameOf(l.feature.properties), a), { sticky: true, className: "region-tooltip" });
    });
  };

  const renderSummary = (stats) => {
    let records = 0;
    const sp = new Set();
    let sea = 0;
    App.data.each((spId, gid, p, source, n) => { records += n; sp.add(spId); if (!gid) sea += n; });
    const areas = [...stats.values()].filter((a) => a && a.records > 0).length;
    const one = S.filters.species && S.filters.species.size === 1 ? S.spById.get([...S.filters.species][0]) : null;
    const head = `<div class="sum-main">${one ? `${esc(one.name)} · ` : ""}${fmt(records)}건 · ${sp.size}종</div>`;
    if (S.mapUnit === "heat") {
      document.getElementById("map-summary").innerHTML = `${head}
        <div class="muted" style="margin-bottom:6px">열지도 격자 ${fmt(heatInfo.cells)}칸 · 기록 ${fmt(heatInfo.records)}건${records > heatInfo.records ? ` (위치를 흐렸거나 오차가 큰 ${fmt(records - heatInfo.records)}건 제외)` : ""}</div>
        <div class="legend-scale" style="background:linear-gradient(90deg,#4dabf7,#51cf66,#fcc419,#ff922b,#e03131);height:10px;border-radius:3px"></div>
        <div class="legend-scale-labels"><span>적음</span><span>기록 밀도(약 250m 격자)</span><span>많음</span></div>
        <div class="muted" style="margin-top:6px;font-size:11px">시·군·구를 누르면 그 지역에 기록된 종을 볼 수 있습니다.</div>`;
      return;
    }
    const unitLabel = S.mapUnit === "sgg" ? "시·군·구" : "시·도";
    const label = scale.metric === "species" ? "출현 종 수" : "기록 수(로그 척도)";
    document.getElementById("map-summary").innerHTML = `${head}
      <div class="muted" style="margin-bottom:6px">기록이 있는 ${unitLabel} ${areas}곳${sea ? ` · 지도 밖(바다 등) ${fmt(sea)}건` : ""}</div>
      <div class="legend-scale">${SEQ.slice(1).map((col) => `<span style="background:${col}"></span>`).join("")}</div>
      <div class="legend-scale-labels"><span>${fmt(scale.min || 0)}</span><span>${label}</span><span>${fmt(scale.max)}</span></div>
      <div class="muted" style="margin-top:6px;font-size:11px">기록이 있는 지역을 ${unitLabel} 단위로 칠했습니다. 더 자세한 분포는 ‘열지도’에서 볼 수 있습니다.</div>`;
  };

  const render = () => {
    if (!map) return;
    const unit = S.mapUnit;
    const stats = statsFor(unit === "heat" ? "sgg" : unit);
    renderHeat(unit === "heat");
    if (unit === "sgg" || unit === "heat") {
      if (map.hasLayer(sidoLayer)) map.removeLayer(sidoLayer);
      paint(sggLayer, stats, (p) => p.gid, (p) => `${p.short} ${p.name}`, unit === "heat");
      if (!map.hasLayer(sggLayer)) map.addLayer(sggLayer);
    } else {
      if (map.hasLayer(sggLayer)) map.removeLayer(sggLayer);
      paint(sidoLayer, stats, (p) => p.code, (p) => p.name);
      if (!map.hasLayer(sidoLayer)) map.addLayer(sidoLayer);
    }
    if (!map.hasLayer(sidoLines)) map.addLayer(sidoLines);
    sidoLines.bringToFront();
    renderSummary(stats);
    if (open) showPanel(open.kind, open.key, true);
  };

  // ---------- 지역 패널 ----------
  const photoChip = (spId, o) => {
    const sp = S.spById.get(spId) || { name: "" };
    const url = SRC().obsUrl(o);
    const inner = `<img src="${SRC().photoUrl(o.ph, "small")}" alt="${esc(sp.name)} 관찰 사진" loading="lazy">
      <span class="rp-photo-cap">${esc(sp.name)} · ${fmtDate(o.date)}<br>© ${esc(o.u)} · ${esc(SRC().licenseLabel(o.lic))}</span>`;
    return url ? `<a class="rp-photo" href="${url}" target="_blank" rel="noopener">${inner}</a>` : `<span class="rp-photo">${inner}</span>`;
  };

  const showPanel = (kind, key, refresh) => {
    if (kind === "sgg" ? !App.geo.unit(key) : sidoIdx(key) < 0) return;
    open = { kind, key };
    const stats = kind === "sgg" ? App.data.byUnit().units.get(key) : App.data.bySido().regions[sidoIdx(key)];
    const a = stats || { records: 0, bySource: { verified: 0, pending: 0, gbif: 0 }, species: new Map() };
    const u = kind === "sgg" ? App.geo.unit(key) : null;
    const title = u ? u.name : App.geo.regions[sidoIdx(key)].name;
    const sub = u ? App.geo.regions[u.sido].name : "시·도 전체";
    const list = [...a.species.entries()].map(([id, n]) => ({ sp: S.spById.get(id), n }))
      .sort((x, y) => (x.sp.grade === y.sp.grade ? y.n - x.n : x.sp.grade < y.sp.grade ? -1 : 1));
    const g = { en1: 0, en2: 0 };
    list.forEach(({ sp }) => { g[sp.grade]++; });
    const max = Math.max(1, ...list.map((x) => x.n));
    const photos = kind === "sgg"
      ? App.data.recentInat({ gid: key, withPhoto: true, limit: 6, filter: (id) => App.data.speciesVisible(id) }) : [];
    const panel = document.getElementById("region-panel");
    panel.innerHTML = `
      <div class="rp-head">
        <div><h2>${esc(title)}</h2><div class="muted small">${esc(sub)} · 현재 필터 기준</div></div>
        <button class="icon-btn" id="rp-close" aria-label="닫기">✕</button>
      </div>
      <div class="rp-body">
        <div class="rp-stats">
          <div class="rp-stat"><b>${list.length}</b><span>출현 종</span></div>
          <div class="rp-stat"><b>${fmt(a.records)}</b><span>전체 기록</span></div>
          <div class="rp-stat"><b>${g.en1}</b><span>Ⅰ급 종</span></div>
          <div class="rp-stat"><b>${g.en2}</b><span>Ⅱ급 종</span></div>
        </div>
        <div class="muted small" style="margin:-4px 0 10px">시민 관찰 검증됨 ${fmt(a.bySource.verified)} · 확인 중 ${fmt(a.bySource.pending)} · 기관 ${fmt(a.bySource.gbif)}</div>
        <h3 style="margin-bottom:8px">기록된 멸종위기종</h3>
        ${list.length ? `<div class="bars">${list.map(({ sp, n }) => `
          <div class="bar-row clickable" data-sp="${esc(sp.id)}" title="${esc(sp.sci)} — 이 종만 지도에 표시">
            <span class="bar-label">${App.data.gradeBadge(sp, { short: true })} ${esc(sp.name)}</span>
            <span class="bar-track"><span class="bar-fill" style="display:block;width:${(n / max) * 100}%;background:${App.data.colorOf(sp.id)}"></span></span>
            <span class="bar-val">${fmt(n)}</span></div>`).join("")}</div>`
          : `<p class="muted">현재 필터 조건에서 기록이 없습니다. 기록이 없다고 그 지역에 없다는 뜻은 아닙니다.</p>`}
        ${photos.length ? `<h3 style="margin:16px 0 8px">최근 시민 관찰 사진</h3><div class="rp-photos">${photos.map(({ spId, o }) => photoChip(spId, o)).join("")}</div>
          <p class="muted small" style="margin-top:6px">보호를 위해 관찰 원본 링크는 iNaturalist가 위치를 흐린 관찰에만 겁니다.</p>` : ""}
      </div>`;
    panel.hidden = false;
    panel.querySelector("#rp-close").onclick = () => { panel.hidden = true; open = null; };
    panel.querySelectorAll("[data-sp]").forEach((el) => { el.onclick = () => App.ui.selectOnlySpecies(el.dataset.sp); });
  };

  const flyTo = (kind, key) => {
    const layer = (kind === "sgg" ? sggLayer : sidoLayer).getLayers()
      .find((l) => (kind === "sgg" ? l.feature.properties.gid : l.feature.properties.code) === key);
    if (layer) map.fitBounds(layer.getBounds(), { padding: [40, 40] });
  };

  const closePanel = () => { document.getElementById("region-panel").hidden = true; open = null; };
  const invalidate = () => map && map.invalidateSize();

  return { init, render, showPanel, closePanel, flyTo, invalidate };
})();
