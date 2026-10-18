// 자료 출처: iNaturalist(시민 관찰, 실시간)와 GBIF(기관·타 플랫폼 기록, 시·군·구별 집계 스냅샷)
App.sources = (() => {
  const INAT_API = "https://api.inaturalist.org/v2/observations";
  const PLACE_KOREA = 6891;
  const FIELDS = "id,quality_grade,observed_on,location,obscured,positional_accuracy," +
    "user.login,photos.url,photos.license_code,license_code,taxon.id,taxon.ancestor_ids";
  const LICENSES = {
    cc0: "CC0", "cc-by": "CC BY", "cc-by-nc": "CC BY-NC", "cc-by-sa": "CC BY-SA", "cc-by-nd": "CC BY-ND",
    "cc-by-nc-sa": "CC BY-NC-SA", "cc-by-nc-nd": "CC BY-NC-ND",
  };

  // ---------- 사진 ----------
  // 스냅샷은 사진을 'o123.jpg'(open-data 저장소) / 's123.jpeg'(iNaturalist 서버)로 줄여 저장
  const photoUrl = (code, size = "small") => {
    if (!code) return "";
    const m = /^([os])(\d+)\.(\w+)$/.exec(code);
    if (!m) return "";
    const host = m[1] === "o" ? "https://inaturalist-open-data.s3.amazonaws.com" : "https://static.inaturalist.org";
    return `${host}/photos/${m[2]}/${size}.${m[3]}`;
  };
  const shortPhoto = (photos) => {
    for (const p of photos || []) {
      const m = /\/\/(inaturalist-open-data\.s3\.amazonaws\.com|static\.inaturalist\.org)\/photos\/(\d+)\/square\.(\w+)/.exec(p.url || "");
      if (p.license_code && m) return [`${m[1].startsWith("inaturalist-open-data") ? "o" : "s"}${m[2]}.${m[3]}`, p.license_code];
    }
    return ["", ""];
  };
  const licenseLabel = (code) => LICENSES[code] || "";

  // 관찰 원본 링크는 iNaturalist가 위치를 흐린 관찰에만 겁니다(그 밖의 관찰은 원본 페이지에 정확한 위치가 보이므로).
  const obsUrl = (o) => (o && o.obsc ? `https://www.inaturalist.org/observations/${o.id}` : "");
  const taxonUrl = (id) => `https://www.inaturalist.org/taxa/${id}`;
  const identifyUrl = (taxonIds) =>
    `https://www.inaturalist.org/observations/identify?place_id=${PLACE_KOREA}&quality_grade=needs_id&taxon_ids=${taxonIds.join(",")}`;
  const gbifSpeciesUrl = (key) => `https://www.gbif.org/species/${key}`;
  const gbifDatasetUrl = (key) => `https://www.gbif.org/dataset/${key}`;
  // GBIF 자료를 낸 기관 이름(영문) → 한글
  const ORGS = {
    "National Institute of Biological Resources": "국립생물자원관",
    "Korea National Park Service": "국립공원공단",
    "National Institute of Fisheries Science": "국립수산과학원",
    "Cetacean Research Institute": "고래연구센터",
    "National Institute of Ecology": "국립생태원",
    "NATURING": "네이처링(시민 관찰)",
    "National Science Museum of Korea": "국립중앙과학관",
    "Korea National Arboretum (Korea Forest Service)": "국립수목원",
    "Korea National Arboretum": "국립수목원",
    "Seongnam City Hall": "성남시청",
    "DMZ Botanic Garden": "DMZ자생식물원",
    "The International Barcode of Life Consortium": "국제생명바코드(BOLD)",
    "Cornell Lab of Ornithology": "코넬대 조류연구소(eBird)",
    "Observation.org": "Observation.org(시민 관찰)",
    "Korea Institute of Ocean Science & Technology": "한국해양과학기술원",
    "National Marine Biodiversity Institute of Korea": "국립해양생물자원관",
    "National Marine Biodiversity Institute Of Korea": "국립해양생물자원관",
    "Korea Institute of Environmental Ecology": "한국환경생태연구소",
    "Kunsan Passage Bird Research Institute": "군산철새연구소",
    "TB Lee Herbarium": "서울대 이창복 표본관",
    "K-water Institute": "K-water연구원",
    "Upo Wetland Ecological Park": "우포늪생태관",
    "Korean Aquatic Plant Resources and Information Bank": "한국수생식물자원정보은행",
    "Korean Natural History Museum": "한국자연사박물관",
    "Mokpo Natural History Museum": "목포자연사박물관",
    "Ewha Womans University Natural History Museum": "이화여대 자연사박물관",
    "Korean Association of Wild Birds Protection": "한국야생조류협회",
    "Kyungpook National University Natural History Museum": "경북대 자연사박물관",
  };
  const orgLabel = (name) => ORGS[name] || name || "";

  // ---------- iNaturalist ----------
  // 행: [id, gid, 관찰일(YYYYMMDD), 검증됨, 위치흐림, 관찰자, 사진, 사진 라이선스, 사진 수, 관찰 라이선스, 열지도 격자(-1 = 없음)]
  const toObs = (row) => {
    const [id, gid, date, q, obsc, u, ph, lic, np, olic, cell] = row;
    const y = Math.floor(date / 10000) || 0;
    return { id, gid: gid || null, date, y, p: App.data.periodOf(y), q, obsc, u, ph, lic, np, olic: olic || "", cell: cell == null ? -1 : cell };
  };

  const loadInatSnapshot = async (url) => {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snap = await res.json();
    const obs = {};
    Object.entries(snap.obs || {}).forEach(([spId, rows]) => { obs[spId] = rows.map(toObs); });
    return { obs, taxa: snap.taxa || {}, at: snap.generatedAt };
  };

  // API 결과 → 관찰 객체. 좌표는 시·군·구·격자 판별에 쓰고, 관리자 내려받기용으로 메모리에만 둠(저장하지 않음)
  const MAX_UNCERTAINTY = 1000;
  const fromApi = (o) => {
    const [lat, lng] = String(o.location).split(",").map(Number);
    const [ph, lic] = shortPhoto(o.photos);
    const gid = App.geo.gidOf(lat, lng);
    const acc = o.positional_accuracy;
    const fine = gid && !o.obscured && (acc == null || acc <= MAX_UNCERTAINTY);
    const obs = toObs([o.id, gid, Number(String(o.observed_on || "0").replace(/-/g, "")) || 0,
      o.quality_grade === "research" ? 1 : 0, o.obscured ? 1 : 0, (o.user || {}).login || "", ph, lic,
      (o.photos || []).length, o.license_code || "", fine ? App.geo.cellOf(lat, lng) : -1]);
    obs.ll = [lat, lng, acc == null ? -1 : acc];
    return obs;
  };

  // 목록 종의 iNaturalist 분류 ID → 앱의 종 ID
  const taxonIndex = () => {
    const m = new Map();
    App.state.species.forEach((s) => { if (s.inat) m.set(s.inat, s.id); });
    return m;
  };
  const speciesOf = (o, idx) => {
    if (o.taxon && idx.has(o.taxon.id)) return idx.get(o.taxon.id);
    const ids = (o.taxon && o.taxon.ancestor_ids) || [];
    for (let i = ids.length - 1; i >= 0; i--) if (idx.has(ids[i])) return idx.get(ids[i]);
    return null;
  };

  const getJSON = async (url, signal) => {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  /**
   * since 이후 새로 올라오거나 바뀐 관찰을 받음.
   * 결과: { upserts: [{spId, obs}], removed: [id] }  — 검증 대상에서 빠진 관찰(casual)은 removed
   */
  const inatChangesSince = async (sinceISO, { maxPages = 10, signal } = {}) => {
    const idx = taxonIndex();
    const upserts = [], removed = [];
    let last = 0;
    for (let page = 0; page < maxPages; page++) {
      const qs = new URLSearchParams({
        place_id: PLACE_KOREA, taxon_id: [...idx.keys()].join(","), updated_since: sinceISO,
        per_page: 200, order_by: "id", order: "asc", id_above: last, fields: FIELDS,
      });
      const d = await getJSON(`${INAT_API}?${qs}`, signal);
      const res = d.results || [];
      for (const o of res) {
        const spId = speciesOf(o, idx);
        if (!spId || !o.location || o.quality_grade === "casual") { removed.push(o.id); continue; }
        upserts.push({ spId, obs: fromApi(o) });
      }
      if (res.length < 200) break;
      last = res[res.length - 1].id;
    }
    return { upserts, removed };
  };

  // 스냅샷이 없을 때: 25종씩 묶어 전부 받음(느림, 비상용)
  const inatFullLoad = async (onProgress) => {
    const idx = taxonIndex();
    const ids = [...idx.keys()];
    const out = {};
    for (let i = 0; i < ids.length; i += 25) {
      let last = 0;
      for (;;) {
        const qs = new URLSearchParams({
          place_id: PLACE_KOREA, taxon_id: ids.slice(i, i + 25).join(","), verifiable: "true", per_page: 200,
          order_by: "id", order: "asc", id_above: last, fields: FIELDS,
        });
        const res = (await getJSON(`${INAT_API}?${qs}`)).results || [];
        res.forEach((o) => {
          const spId = speciesOf(o, idx);
          if (spId && o.location) (out[spId] = out[spId] || []).push(fromApi(o));
        });
        if (res.length < 200) break;
        last = res[res.length - 1].id;
        await new Promise((r) => setTimeout(r, 1000));
      }
      onProgress && onProgress(Math.min(i + 25, ids.length), ids.length);
    }
    return out;
  };

  // ---------- GBIF ----------
  const loadGbifSnapshot = async (url) => {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snap = await res.json();
    return { entries: snap.species || {}, datasets: snap.datasets || [], at: snap.generatedAt };
  };

  // 열지도용 기관 기록 격자(약 250m) — 열지도를 처음 열 때만 받음
  const loadHeat = async (url) => {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).species || {};
  };

  return {
    PLACE_KOREA, photoUrl, licenseLabel, obsUrl, taxonUrl, identifyUrl, gbifSpeciesUrl, gbifDatasetUrl, orgLabel,
    loadInatSnapshot, inatChangesSince, inatFullLoad, loadGbifSnapshot, loadHeat,
  };
})();
