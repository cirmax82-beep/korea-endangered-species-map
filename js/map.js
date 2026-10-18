// 분포지도 (Leaflet + OpenStreetMap) — 멸종위기종이라 지점 대신 시·군·구(또는 시·도) 단위로만 칠함
App.map = (() => {
  const { esc, fmt, seqColor, SEQ } = App.util;
  const S = App.state;
  const SRC = () => App.sources;

  let map, sggLayer, sidoLayer, sidoLines;
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

    const hover = (layer, on) => layer.setStyle(on ? { weight: 2.4, color: "#173a24" } : { weight: 0.6, color: "#ffffff" });
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

  const paint = (layer, stats, keyOf, nameOf) => {
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
      l.setStyle({ fillColor: seqColor(t) || "#f4f5f2", fillOpacity: v ? 0.85 : 0.55 });
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
    const unitLabel = S.mapUnit === "sgg" ? "시·군·구" : "시·도";
    const label = scale.metric === "species" ? "출현 종 수" : "기록 수(로그 척도)";
    const one = S.filters.species && S.filters.species.size === 1 ? S.spById.get([...S.filters.species][0]) : null;
    document.getElementById("map-summary").innerHTML = `
      <div class="sum-main">${one ? `${esc(one.name)} · ` : ""}${fmt(records)}건 · ${sp.size}종</div>
      <div class="muted" style="margin-bottom:6px">기록이 있는 ${unitLabel} ${areas}곳${sea ? ` · 지도 밖(바다 등) ${fmt(sea)}건` : ""}</div>
      <div class="legend-scale">${SEQ.slice(1).map((col) => `<span style="background:${col}"></span>`).join("")}</div>
      <div class="legend-scale-labels"><span>${fmt(scale.min || 0)}</span><span>${label}</span><span>${fmt(scale.max)}</span></div>
      <div class="muted" style="margin-top:6px;font-size:11px">🔒 보호를 위해 정확한 위치 대신 ${unitLabel} 단위로만 보여 줍니다.</div>`;
  };

  const render = () => {
    if (!map) return;
    const unit = S.mapUnit;
    const stats = statsFor(unit);
    if (unit === "sgg") {
      if (map.hasLayer(sidoLayer)) map.removeLayer(sidoLayer);
      paint(sggLayer, stats, (p) => p.gid, (p) => `${p.short} ${p.name}`);
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
