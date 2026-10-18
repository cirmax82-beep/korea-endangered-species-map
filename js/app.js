// 앱 시작, 화면 전환, 필터, 실시간 갱신
(() => {
  const { $, $$, esc, fmt, debounce, toast } = App.util;
  const S = App.state;
  const VIEWS = ["map", "species", "stats", "join", "about"];
  const SYNC_EVERY = 10 * 60 * 1000;   // 10분마다 iNaturalist 새 관찰 확인
  let currentView = "map";

  // ================= 공통 UI =================
  const openModal = (title, html, onMount) => {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = html;
    $("#modal").hidden = false;
    $("#modal-body").scrollTop = 0;
    onMount && onMount($("#modal-body"));
  };
  const closeModal = () => { $("#modal").hidden = true; $("#modal-body").innerHTML = ""; };

  const showView = (name, { updateHash = true } = {}) => {
    if (!VIEWS.includes(name)) name = "map";
    currentView = name;
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
    if (updateHash) {
      try { history.replaceState(null, "", name === "map" ? location.pathname + location.search : `#${name}`); } catch (_) { /* 무시 */ }
    }
    renderView(name);
    if (name === "map") setTimeout(App.map.invalidate, 30);
  };

  const renderView = (name = currentView) => {
    if (name === "map") { renderSpeciesList(); App.map.render(); }
    if (name === "species") App.views.renderSpecies();
    if (name === "stats") App.views.renderStats();
    if (name === "join") App.views.renderJoin();
    if (name === "about") App.views.renderAbout();
  };

  const selectOnlySpecies = (id) => {
    const sp = S.spById.get(id);
    if (!sp) return;
    S.filters.species = new Set([id]);
    S.filters.groups.add(sp.group);
    if (S.filters.grades && !S.filters.grades.has(sp.grade)) S.filters.grades = null;
    renderChips();
    showView("map");
  };

  App.ui = { openModal, closeModal, showView, selectOnlySpecies };

  // ================= 실시간 표시 =================
  let liveState = "loading";
  const bootAt = Date.now();
  const ago = (d) => {
    const m = Math.round((Date.now() - d.getTime()) / 60000);
    return m < 1 ? "방금" : m < 60 ? `${m}분 전` : `${Math.round(m / 60)}시간 전`;
  };
  const renderLive = () => {
    const chip = $("#live-chip");
    chip.dataset.state = liveState;
    const text = {
      loading: "자료 여는 중…",
      syncing: "새 관찰 확인 중…",
      ok: `실시간 · ${S.inatSyncedAt ? ago(S.inatSyncedAt) : ""} 갱신`,
      error: "갱신 실패 · 다시 시도",
      offline: "기본 자료만 표시 중",
    }[liveState];
    chip.innerHTML = `<span class="sync-dot"></span><span>${esc(text)}</span>`;
    chip.title = "누르면 iNaturalist의 새 관찰을 지금 확인합니다.";
  };

  let syncing = false;
  const syncNow = async () => {
    if (syncing || !S.inatSnapshotAt) return;
    syncing = true;
    liveState = "syncing";
    renderLive();
    // 마지막 갱신 1분 전부터 다시 확인(경계에서 놓치지 않게)
    const since = S.inatSyncedAt ? new Date(S.inatSyncedAt.getTime() - 60000).toISOString() : S.inatSnapshotAt;
    try {
      const changes = await App.sources.inatChangesSince(since);
      const r = App.data.applyInatChanges(changes);
      S.inatSyncedAt = new Date();
      liveState = "ok";
      if (r.added || r.changed || r.removed) {
        renderView();
        if (r.added && Date.now() - bootAt > 15000) toast(`새 시민 관찰 ${fmt(r.added)}건이 지도에 추가됐습니다.`);
      }
    } catch (e) {
      console.warn("iNaturalist 갱신 실패", e);
      liveState = "error";
    } finally {
      syncing = false;
      renderLive();
    }
  };

  // ================= 지도 사이드바 =================
  const renderChips = () => {
    $("#group-chips").innerHTML = Object.entries(window.TAXON_GROUPS).map(([k, g]) =>
      `<button class="chip ${S.filters.groups.has(k) ? "on" : ""}" data-group="${k}"><span class="dot" style="background:${g.color}"></span>${g.label}</button>`).join("");
    const gr = S.filters.grades;
    $("#status-chips").innerHTML = Object.entries(window.STATUS).map(([k, st]) =>
      `<button class="chip ${!gr || gr.has(k) ? "on" : ""}" data-status="${k}"><span class="dot" style="background:${st.color}"></span>${esc(st.label)}</button>`).join("");
    $("#period-chips").innerHTML = App.data.PERIODS.map((p, i) =>
      `<button class="chip ${S.filters.periods.has(i) ? "on" : ""}" data-period="${i}">${esc(p.label)}</button>`).join("");
  };

  const renderSourceCounts = () => {
    const c = { verified: 0, pending: 0, gbif: 0 };
    App.data.each((id, gid, p, source, n) => { c[source] += n; },
      { ignoreSpeciesFilter: true, sources: { verified: true, pending: true, gbif: true } });
    $$("[data-src-count]").forEach((el) => { el.textContent = fmt(c[el.dataset.srcCount]); });
  };

  const renderSpeciesList = () => {
    const q = $("#sp-search").value.trim().toLowerCase();
    const counts = new Map();
    App.data.each((id, gid, p, source, n) => counts.set(id, (counts.get(id) || 0) + n), { ignoreSpeciesFilter: true });
    const sel = S.filters.species;
    const gr = S.filters.grades;
    $("#species-list").innerHTML = Object.entries(window.TAXON_GROUPS).map(([k, g]) => {
      if (!S.filters.groups.has(k)) return "";
      const items = S.species.filter((s) => s.group === k && (!gr || gr.has(s.grade)) &&
        (!q || s.name.toLowerCase().includes(q) || (s.sci || "").toLowerCase().includes(q)));
      if (!items.length) return "";
      return `<div class="sp-group-title"><span class="dot" style="background:${g.color};width:8px;height:8px"></span>${g.label}</div>` +
        items.map((s) => {
          const n = counts.get(s.id) || 0;
          return `<label class="sp-item ${n ? "" : "empty"}" title="${esc(s.sci || "")} · ${esc(App.data.grade(s).label)}">
            <input type="checkbox" data-sp="${esc(s.id)}" ${!sel || sel.has(s.id) ? "checked" : ""}>
            <span class="sp-name">${esc(s.name)} <small class="grade-${s.grade}">${esc(App.data.grade(s).short)}</small></span><span class="sp-count">${n ? fmt(n) : "-"}</span></label>`;
        }).join("");
    }).join("") || `<p class="muted small">검색 결과가 없습니다.</p>`;
    renderSourceCounts();
  };

  const rerenderMap = debounce(() => { if (currentView === "map") { renderSpeciesList(); App.map.render(); } }, 120);

  const syncSourceBoxes = () => ["verified", "pending", "gbif"].forEach((k) => { $(`#src-${k}`).checked = S.filters.sources[k]; });

  const bindSidebar = () => {
    $("#mode-switch").addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-mode]");
      if (!b) return;
      S.mapUnit = b.dataset.mode;
      $$("#mode-switch button").forEach((x) => x.classList.toggle("active", x === b));
      $("#metric-switch").hidden = S.mapUnit === "heat";
      App.map.closePanel();
      if (S.mapUnit === "heat" && !S.heat) {
        showBanner("열지도 자료 받는 중…", 0.5);
        try { S.heat = await App.sources.loadHeat("data/heat-gbif.json"); } catch (err) {
          console.warn("열지도 자료를 읽지 못했습니다", err);
          toast("기관 기록 열지도 자료를 받지 못해 시민 관찰만 보여 줍니다.", 4000);
          S.heat = {};
        }
        $("#load-banner").hidden = true;
      }
      App.map.render();
    });
    $("#metric-switch").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-metric]");
      if (!b) return;
      S.choroMetric = b.dataset.metric;
      $$("#metric-switch button").forEach((x) => x.classList.toggle("active", x === b));
      App.map.render();
    });
    ["verified", "pending", "gbif"].forEach((key) => {
      $(`#src-${key}`).addEventListener("change", (e) => { S.filters.sources[key] = e.target.checked; rerenderMap(); });
    });
    $("#only-verified").onclick = () => { S.filters.sources = { verified: true, pending: false, gbif: true }; syncSourceBoxes(); rerenderMap(); };
    $("#all-sources").onclick = () => { S.filters.sources = { verified: true, pending: true, gbif: true }; syncSourceBoxes(); rerenderMap(); };
    $("#period-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-period]");
      if (!b) return;
      const i = Number(b.dataset.period);
      if (S.filters.periods.has(i)) S.filters.periods.delete(i); else S.filters.periods.add(i);
      if (!S.filters.periods.size) S.filters.periods = App.data.ALL_PERIODS();
      renderChips();
      rerenderMap();
    });
    $$("[data-periods]").forEach((b) => b.addEventListener("click", () => {
      S.filters.periods = b.dataset.periods === "recent" ? new Set([3]) : b.dataset.periods === "since2010" ? new Set([2, 3]) : App.data.ALL_PERIODS();
      renderChips();
      rerenderMap();
    }));
    $("#status-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-status]");
      if (!b) return;
      const k = b.dataset.status;
      const f = S.filters.grades || new Set(Object.keys(window.STATUS));
      if (f.has(k)) f.delete(k); else f.add(k);
      S.filters.grades = !f.size || f.size === Object.keys(window.STATUS).length ? null : f;
      renderChips();
      rerenderMap();
    });
    $("#group-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-group]");
      if (!b) return;
      const g = b.dataset.group;
      if (S.filters.groups.has(g)) S.filters.groups.delete(g); else S.filters.groups.add(g);
      renderChips();
      rerenderMap();
    });
    $("#species-list").addEventListener("change", (e) => {
      const id = e.target.dataset.sp;
      if (!id) return;
      if (!S.filters.species) S.filters.species = new Set(S.species.map((s) => s.id));
      if (e.target.checked) S.filters.species.add(id); else S.filters.species.delete(id);
      if (S.filters.species.size === S.species.length) S.filters.species = null;
      rerenderMap();
    });
    $("#sp-all").onclick = () => {
      S.filters.species = null; S.filters.grades = null; S.filters.groups = new Set(Object.keys(window.TAXON_GROUPS));
      renderChips(); rerenderMap();
    };
    $("#sp-none").onclick = () => { S.filters.species = new Set(); rerenderMap(); };
    $("#sp-search").addEventListener("input", debounce(renderSpeciesList, 120));
    $("#sidebar-open").onclick = () => $("#map-sidebar").classList.add("open");
    $("#sidebar-close").onclick = () => $("#map-sidebar").classList.remove("open");
  };

  // ================= 다른 화면 =================
  const bindPages = () => {
    $$(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
    document.addEventListener("click", (e) => {
      const a = e.target.closest("[data-goto]");
      if (a) { e.preventDefault(); showView(a.dataset.goto); window.scrollTo(0, 0); }
    });
    $("#live-chip").addEventListener("click", syncNow);

    // 도감
    $("#catalog-search").addEventListener("input", debounce((e) => { App.views.catalogState.q = e.target.value; App.views.renderSpecies(); }, 150));
    $("#catalog-groups").addEventListener("click", (e) => {
      const b = e.target.closest("[data-g]");
      if (!b) return;
      App.views.catalogState.group = b.dataset.g || null;
      App.views.renderSpecies();
    });
    $("#catalog-status").addEventListener("click", (e) => {
      const b = e.target.closest("[data-st]");
      if (!b) return;
      App.views.catalogState.grade = b.dataset.st || null;
      App.views.renderSpecies();
    });
    $("#catalog-sort").addEventListener("change", (e) => { App.views.catalogState.sort = e.target.value; App.views.renderSpecies(); });
    const openCard = (e) => {
      const card = e.target.closest(".sp-card");
      if (card) App.views.speciesDetail(card.dataset.id);
    };
    $("#catalog-grid").addEventListener("click", openCard);
    $("#catalog-grid").addEventListener("keydown", (e) => { if (e.key === "Enter") openCard(e); });

    // 통계
    $("#stats-source").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-src]");
      if (!b) return;
      $$("#stats-source button").forEach((x) => x.classList.toggle("active", x === b));
      App.views.setStatsSource(b.dataset.src);
    });
    $("#view-stats").addEventListener("click", (e) => {
      const reg = e.target.closest("[data-sido]");
      if (reg) {
        const code = reg.dataset.sido;
        S.mapUnit = "sgg";
        $$("#mode-switch button").forEach((x) => x.classList.toggle("active", x.dataset.mode === "sgg"));
        showView("map");
        setTimeout(() => { App.map.flyTo("sido", code); }, 80);
        return;
      }
      const sp = e.target.closest("[data-sp], [data-detail]");
      if (sp) App.views.speciesDetail(sp.dataset.sp || sp.dataset.detail);
    });
    $("#matrix-csv").onclick = App.views.matrixCSV;
    $("#stats-export").onclick = () => App.exporter.openDialog("all");
    $("#about-export").onclick = () => App.exporter.openDialog("all");
    $("#map-export").onclick = () => App.exporter.openDialog("map");

    // 모달
    $("#modal-close").onclick = closeModal;
    $("#modal").addEventListener("mousedown", (e) => { if (e.target.id === "modal") closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });
    window.addEventListener("hashchange", () => showView(location.hash.slice(1) || "map", { updateHash: false }));
  };

  // ================= 자료 불러오기 =================
  const showBanner = (text, ratio) => {
    $("#load-banner").hidden = false;
    $("#load-text").textContent = text;
    $("#load-bar").style.width = `${Math.round(ratio * 100)}%`;
  };

  const loadData = async () => {
    showBanner("관찰 자료 여는 중…", 0.3);
    const [inat, gbif] = await Promise.allSettled([
      App.sources.loadInatSnapshot("data/inat-snapshot.json"),
      App.sources.loadGbifSnapshot("data/gbif-snapshot.json"),
    ]);
    if (gbif.status === "fulfilled") {
      S.gbif = gbif.value.entries;
      S.gbifDatasets = gbif.value.datasets;
      S.gbifAt = gbif.value.at;
    } else {
      console.warn("GBIF 자료를 읽지 못했습니다", gbif.reason);
    }
    if (inat.status === "fulfilled") {
      S.inat = inat.value.obs;
      S.inatTaxa = inat.value.taxa;
      S.inatSnapshotAt = inat.value.at;
    } else {
      // 스냅샷이 없으면 iNaturalist에서 직접 전부 받음(몇 분)
      console.warn("iNaturalist 스냅샷이 없어 직접 받습니다", inat.reason);
      try {
        S.inat = await App.sources.inatFullLoad((done, total) =>
          showBanner(`iNaturalist 시민 관찰 받는 중… ${done}/${total}종`, done / total));
        S.inatSnapshotAt = new Date().toISOString();
        S.inatSyncedAt = new Date();
      } catch (e) {
        toast("iNaturalist에 연결하지 못했습니다. 인터넷 연결을 확인하세요.", 5000);
        liveState = "offline";
      }
    }
    $("#load-banner").hidden = true;
  };

  // ================= 시작 =================
  const boot = async () => {
    App.data.rebuildSpecies();
    App.map.init();
    renderChips();
    bindSidebar();
    bindPages();
    renderLive();
    showView(location.hash.slice(1) || "map", { updateHash: false });

    await loadData();
    renderView();
    if (liveState === "offline") { renderLive(); return; }
    await syncNow();
    setInterval(() => { if (!document.hidden) syncNow(); }, SYNC_EVERY);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && S.inatSyncedAt && Date.now() - S.inatSyncedAt > SYNC_EVERY) syncNow();
    });
    setInterval(renderLive, 60000);
  };

  boot();
})();
