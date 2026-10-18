"""좌표 → 시·군·구(GADM 2단계 코드) 판별. 스냅샷 스크립트들이 함께 씁니다. 앱(js/geo.js)과 같은 규칙입니다."""
import json
from pathlib import Path

from shapely.geometry import Point, shape
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parent.parent
NEAR = 0.25  # 경계 밖(바다)이어도 약 25km 이내면 가장 가까운 시·군·구로 배정(해안·섬 기록)


class Locator:
    def __init__(self):
        src = (ROOT / "js" / "data-sgg.js").read_text(encoding="utf-8")
        start = src.index("window.KR_SGG = ") + len("window.KR_SGG = ")
        gj = json.loads(src[start:src.index(";\nwindow.KR_SIDO")])
        self.gids = [f["properties"]["gid"] for f in gj["features"]]
        self.geoms = [shape(f["geometry"]) for f in gj["features"]]
        self.tree = STRtree(self.geoms)

    def locate(self, lat, lng):
        p = Point(lng, lat)
        for i in self.tree.query(p, predicate="intersects"):
            return self.gids[i]
        i = self.tree.query_nearest(p, max_distance=NEAR)
        return self.gids[i[0]] if len(i) else None
