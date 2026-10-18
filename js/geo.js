// 시·군·구 / 시·도 경계와 좌표 → 시·군·구 판별
App.geo = (() => {
  const sggFeatures = window.KR_SGG.features;
  const sidoFeatures = window.KR_SIDO.features;

  // 시·도 17곳 (통계청 코드순)
  const regions = sidoFeatures.map((f, i) => ({ idx: i, code: f.properties.code, name: f.properties.name, short: f.properties.short }));
  const sidoIdx = new Map(regions.map((r) => [r.code, r.idx]));

  // 시·군·구 229곳 (GBIF가 쓰는 GADM 2단계 코드가 키)
  const units = sggFeatures.map((f, i) => ({
    idx: i, gid: f.properties.gid, name: f.properties.name, sido: sidoIdx.get(f.properties.sido),
    full: `${f.properties.short} ${f.properties.name}`,
  }));
  const byGid = new Map(units.map((u) => [u.gid, u]));
  const unit = (gid) => byGid.get(gid) || null;
  const sidoOf = (gid) => { const u = byGid.get(gid); return u ? u.sido : -1; };

  // 다각형별 경계상자를 미리 계산
  const shapes = sggFeatures.map((f) => f.geometry.coordinates.map((poly) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    poly[0].forEach(([x, y]) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    });
    return { rings: poly, bbox: [minX, minY, maxX, maxY] };
  }));

  const inRing = (x, y, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  const segDist2 = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy;
    let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    const ex = ax + t * dx - px, ey = ay + t * dy - py;
    return ex * ex + ey * ey;
  };

  const NEAR = 0.25; // 경계 밖(바다)이어도 약 25km 이내면 가장 가까운 시·군·구로 배정 — tools/sgg.py 와 같은 규칙

  // 좌표 → 시·군·구 코드(gid). 남한 밖이면 null
  const gidOf = (lat, lng) => {
    if (!(lat >= 32.8 && lat <= 39 && lng >= 124 && lng <= 132.2)) return null;
    for (let r = 0; r < shapes.length; r++) {
      for (const s of shapes[r]) {
        const b = s.bbox;
        if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
        let inside = false;
        for (const ring of s.rings) if (inRing(lng, lat, ring)) inside = !inside;
        if (inside) return units[r].gid;
      }
    }
    let best = -1, bestD = NEAR * NEAR;
    for (let r = 0; r < shapes.length; r++) {
      for (const s of shapes[r]) {
        const b = s.bbox;
        if (lng < b[0] - NEAR || lng > b[2] + NEAR || lat < b[1] - NEAR || lat > b[3] + NEAR) continue;
        const ring = s.rings[0];
        for (let i = 1; i < ring.length; i++) {
          const d = segDist2(lng, lat, ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]);
          if (d < bestD) { bestD = d; best = r; }
        }
      }
    }
    return best >= 0 ? units[best].gid : null;
  };

  return { regions, units, unit, sidoOf, gidOf, sggFeatures, sidoFeatures };
})();
