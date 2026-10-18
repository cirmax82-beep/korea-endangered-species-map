"""시·군·구 경계(js/data-sgg.js)를 만듭니다.

- 경계: 통계청 2018 시·군·구(southkorea/southkorea-maps 간소화 TopoJSON, KOSTAT 자료는 자유 이용)
- 단위: GBIF가 기록에 붙이는 GADM 2단계 코드(229개)에 맞춤. 일반구(수원시 장안구 등)는 시 하나로 합침.
- 시·도: 현재 기준(군위군은 2023년 대구광역시 편입, 미추홀구는 2018년 인천 남구에서 이름 바뀜)

    python tools/build_regions.py
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
SRC = "https://raw.githubusercontent.com/southkorea/southkorea-maps/master/kostat/2018/json/skorea-municipalities-2018-topo-simple.json"
UA = {"User-Agent": "korea-endangered-map/1.0 (regions build)"}

# 통계청 시·도 코드 → (GADM 1단계, 이름, 짧은 이름)
SIDO = {
    "11": ("KOR.16_1", "서울특별시", "서울"), "21": ("KOR.1_1", "부산광역시", "부산"), "22": ("KOR.4_1", "대구광역시", "대구"),
    "23": ("KOR.11_1", "인천광역시", "인천"), "24": ("KOR.7_1", "광주광역시", "광주"), "25": ("KOR.5_1", "대전광역시", "대전"),
    "26": ("KOR.17_1", "울산광역시", "울산"), "29": ("KOR.15_1", "세종특별자치시", "세종"), "31": ("KOR.8_1", "경기도", "경기"),
    "32": ("KOR.6_1", "강원특별자치도", "강원"), "33": ("KOR.2_1", "충청북도", "충북"), "34": ("KOR.3_1", "충청남도", "충남"),
    "35": ("KOR.13_1", "전북특별자치도", "전북"), "36": ("KOR.14_1", "전라남도", "전남"), "37": ("KOR.9_1", "경상북도", "경북"),
    "38": ("KOR.10_1", "경상남도", "경남"), "39": ("KOR.12_1", "제주특별자치도", "제주"),
}
# 일반구를 가진 시: 국명 → GADM 이름
CITY = {"수원시": "Suwon", "성남시": "Seongnam", "안양시": "Anyang", "안산시": "Ansan", "고양시": "Goyang", "용인시": "Yongin",
        "청주시": "Cheongju", "천안시": "Cheonan", "전주시": "Jeonju", "포항시": "Pohang", "창원시": "Changwon"}
# 영문 이름이 틀렸거나 바뀐 곳
FIX_ENG = {"32360": "Cheorwon", "23030": "Michuhol", "31250": "Gwangju"}
FIX_KO = {"23030": "미추홀구", "29010": "세종특별자치시"}
MOVE_SIDO = {"37310": "22"}  # 군위군 → 대구광역시


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return json.load(r)


def topo_features(topo):
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)

    def ring(idx):
        out = []
        for i in idx:
            pts = arcs[i] if i >= 0 else arcs[~i][::-1]
            out.extend(pts if not out else pts[1:])
        return out

    obj = list(topo["objects"].values())[0]
    for g in obj["geometries"]:
        polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
        coords = []
        for p in polys:
            rings = [ring(r) for r in p]
            if len(rings[0]) < 4:  # 간소화로 점처럼 줄어든 작은 섬은 뺌
                continue
            coords.append([rings[0]] + [h for h in rings[1:] if len(h) >= 4])
        yield g["properties"], shape({"type": "MultiPolygon", "coordinates": coords}).buffer(0)


def norm(s):
    s = s.lower().replace("'", "").replace(" ", "")
    s = re.sub(r"-(gu|si|gun)$", "", s)
    s = re.sub(r"(si|gun)$", "", s) if not s.endswith("-") else s
    return s.replace("-", "")


def rnd(geom, nd=3):
    """좌표를 반올림(소수 셋째 자리 ≈ 100m)하고 겹친 점을 뺌. 이웃 경계는 같은 점이라 같이 반올림돼 틈이 생기지 않음."""
    def ring(pts):
        out = []
        for x, y in pts:
            q = [round(x, nd), round(y, nd)]
            if not out or q != out[-1]:
                out.append(q)
        return out if len(out) >= 4 else None

    def r(c):
        if isinstance(c[0][0], (int, float)):
            return ring(c)
        return [x for x in (r(y) for y in c) if x]
    m = mapping(geom)
    if m["type"] == "Polygon":
        m = {"type": "MultiPolygon", "coordinates": [m["coordinates"]]}
    return {"type": m["type"], "coordinates": r(m["coordinates"])}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    gadm1 = {v[0] for v in SIDO.values()}
    gadm2 = {}
    for l1 in sorted(gadm1):
        for x in get(f"https://api.gbif.org/v1/geocode/gadm/{l1}/subdivisions"):
            gadm2[(l1, norm(x["name"]))] = x["id"]

    units = {}  # gid → {name, sido, geoms}
    for p, geom in topo_features(get(SRC)):
        code, ko = p["code"], FIX_KO.get(p["code"], p["name"])
        l1 = SIDO[code[:2]][0]
        city = next((c for c in CITY if ko.startswith(c) and ko != c), None)
        eng = CITY[city] if city else FIX_ENG.get(code, p["name_eng"])
        gid = gadm2.get((l1, norm(eng)))
        if not gid:
            print("대응 없음:", code, ko, p["name_eng"])
            continue
        u = units.setdefault(gid, {"name": city or ko, "sido": MOVE_SIDO.get(code, code[:2]), "geoms": []})
        u["geoms"].append(geom)

    missing = set(gadm2.values()) - set(units)
    for m in sorted(missing):
        print("경계 없음:", m)

    feats = []
    for gid, u in sorted(units.items(), key=lambda kv: (kv[1]["sido"], kv[1]["name"])):
        g = unary_union(u["geoms"]).simplify(0.0005, preserve_topology=True)
        if g.geom_type == "MultiPolygon":  # 0.3㎢ 안팎보다 작은 섬은 그리지 않음(기록 배정은 가까운 경계로 됨)
            big = [x for x in g.geoms if x.area > 0.00003]
            g = unary_union(big or [max(g.geoms, key=lambda x: x.area)])
        s = SIDO[u["sido"]]
        feats.append({"type": "Feature", "properties": {"gid": gid, "name": u["name"], "sido": u["sido"], "sidoName": s[1], "short": s[2]},
                      "geometry": rnd(g)})
    sido = []
    for code, (l1, name, short) in SIDO.items():
        g = unary_union([unary_union(u["geoms"]) for u in units.values() if u["sido"] == code]).simplify(0.0015, preserve_topology=True)
        sido.append({"type": "Feature", "properties": {"code": code, "name": name, "short": short, "gadm": l1}, "geometry": rnd(g, 3)})

    head = ("// 시·군·구 경계 — tools/build_regions.py 가 만든 파일입니다.\n"
            "// 출처: 통계청 2018 행정구역(southkorea/southkorea-maps 간소화본). gid: GBIF가 쓰는 GADM 2단계 코드.\n"
            "// 일반구는 시 하나로 합쳤고, 시·도는 현재 기준입니다(군위군 → 대구광역시).\n")
    body = ("window.KR_SGG = " + json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, separators=(",", ":")) + ";\n"
            "window.KR_SIDO = " + json.dumps({"type": "FeatureCollection", "features": sido}, ensure_ascii=False, separators=(",", ":")) + ";\n")
    out = ROOT / "js" / "data-sgg.js"
    out.write_text(head + body, encoding="utf-8")
    print(f"시·군·구 {len(feats)}곳, 시·도 {len(sido)}곳 → {out.name} {out.stat().st_size / 1024:.0f}KB")


if __name__ == "__main__":
    main()
