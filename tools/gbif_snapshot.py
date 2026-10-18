"""GBIF 국내 멸종위기 야생생물 기록 받기.

만드는 파일
- data/gbif-snapshot.json : 시·군·구 × 기간별 건수(좌표 없음, 공개)
- data/heat-gbif.json     : 약 250m 격자 × 기간별 건수(열지도용, 공개)
- data/precise-gbif.enc.json : 기록별 정밀 좌표(비밀번호로 암호화, 관리자 전용 내려받기)
  — 환경 변수 DATA_PASSWORD가 있을 때만 만들고, 없으면 기존 파일을 그대로 둠

받는 방법
- 모든 종의 기록을 받아 직접 셈. 시·군·구 코드가 없는 바다·해안 기록은 가장 가까운 시·군·구(25km 이내)로 배정.
- 기록이 많은 종은 자료 묶음별·연도별(필요하면 월별)로 3,000건 안팎씩 나눠 받음 — GBIF는 뒤쪽 페이지일수록 매우 느려서.
  이때 큰 자료 묶음의 연도 없는 기록이 빠지면, 시·군·구 건수는 GBIF 집계(facet)로 보완(격자·정밀 좌표에서는 빠짐).

    python tools/gbif_snapshot.py
    python tools/gbif_snapshot.py --only 종ID,종ID   # 그 종만 다시 받아 기존 파일에 반영
"""
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sgg import GRID, MAX_UNCERTAINTY, Locator, cell_of  # noqa: E402
import secure  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
API = "https://api.gbif.org/v1/occurrence/search"
UA = {"User-Agent": "korea-endangered-map/1.0 (citizen science map; weekly snapshot)"}
GATE = threading.BoundedSemaphore(6)   # GBIF에 동시에 보내는 요청 수(많으면 429로 거절당함)
PAGE = 300
CHUNK = 3000          # 한 번의 검색 크기(이보다 많으면 자료 묶음·연도·월로 나눠 받음)
# 동물원·식물원 개체(살아 있는 표본)와 화석은 빼고 받음
BASIS = ["HUMAN_OBSERVATION", "MACHINE_OBSERVATION", "PRESERVED_SPECIMEN", "OCCURRENCE", "MATERIAL_SAMPLE", "OBSERVATION"]
# iNaturalist 관찰은 앱이 iNaturalist에서 직접 받으므로 GBIF에서는 뺌(중복 방지)
INAT_DATASET = "50c9509d-22c7-4a22-a47d-8c48425ef4a7"
# 기간: 앱의 연도 필터 단위. 마지막 칸은 연도 미상
PERIODS = [("1999년 이전", 1000, 1999), ("2000~2009년", 2000, 2009), ("2010~2019년", 2010, 2019), ("2020년 이후", 2020, 2100)]
NP = len(PERIODS) + 1
DATA = ROOT / "data"


def period_of(year):
    for i, (_, a, b) in enumerate(PERIODS):
        if year and a <= year <= b:
            return i
    return len(PERIODS)


def license_short(url):
    u = (url or "").lower()
    if "zero" in u or "cc0" in u:
        return "CC0"
    if "by-nc" in u:
        return "CC BY-NC"
    if "/by/" in u or "by_4" in u:
        return "CC BY"
    return ""


def load_species():
    src = (ROOT / "js" / "data-species.js").read_text(encoding="utf-8")
    out = []
    for line in src.splitlines():
        m = re.search(r'\{ id: "([^"]+)", name: "([^"]+)".*?gbif: (\d+|null)', line)
        if m and m.group(3) != "null":
            alt = re.search(r"gbifAlt: \[([\d, ]+)\]", line)
            keys = [int(m.group(3))] + ([int(k) for k in alt.group(1).split(",")] if alt else [])
            out.append((m.group(1), m.group(2), keys))
    return out


def fetch(taxon_keys, offset=0, limit=PAGE, extra=()):
    # 같은 종이 여러 학명(키)으로 올라간 경우 함께 조회(OR)
    qs = urllib.parse.urlencode([("taxonKey", k) for k in taxon_keys] + [
        ("country", "KR"), ("hasCoordinate", "true"), ("hasGeospatialIssue", "false"),
        ("occurrenceStatus", "PRESENT"), ("limit", limit), ("offset", offset),
    ] + [("basisOfRecord", b) for b in BASIS] + list(extra))
    # GBIF는 가끔 응답 없이 멈추므로 오래 기다리지 않고 다시 요청.
    # 요청이 너무 많다(429)·서버 오류(5xx)면 알려 준 시간(Retry-After)이나 점점 길게 기다렸다 다시 보냄
    for attempt in range(10):
        try:
            with GATE, urllib.request.urlopen(urllib.request.Request(f"{API}?{qs}", headers=UA), timeout=25) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if attempt == 9 or (e.code != 429 and e.code < 500):
                raise
            wait = e.headers.get("Retry-After")
            time.sleep(min(120, float(wait) if wait and wait.isdigit() else 5 * 2 ** min(attempt, 4)))
        except Exception:
            if attempt == 9:
                raise
            time.sleep(min(30, 2 + 2 * attempt))


def facet(d, field):
    for f in d.get("facets") or []:
        if f["field"].replace("_", "").lower() == field.replace("_", "").lower():
            return {c["name"]: c["count"] for c in f["counts"]}
    return {}


FACETS = [("facet", "gadmLevel2Gid"), ("facet", "year"), ("facet", "datasetKey"), ("facetLimit", 400)]


def kor(counts):
    """남한 시·군·구 코드만(국가 코드가 KR이어도 좌표가 북한·바다 건너인 기록이 있음)."""
    return Counter({k: v for k, v in counts.items() if k.startswith("KOR.")})


def plan_chunks(keys, head):
    """검색 조건 목록: 한 번의 검색이 CHUNK 이하가 되도록 위도·경도 범위를 반씩 나눔.
    GBIF는 1만 번째 이후 페이지가 매우 느리므로 깊이 넘기지 않기 위한 것. 모든 기록에 좌표가 있어 빠지는 기록이 없음.
    같은 지점에 기록이 아주 많아 좌표로 더 못 나누면 연도로 나눔(이때만 연도 없는 기록이 빠질 수 있음)."""
    if head["count"] <= CHUNK:
        return [[]]
    out = []
    q = lambda r: [(d, f"{lo},{hi}") for d, (lo, hi) in r.items()]  # noqa: E731

    def count(r):
        return fetch(keys, limit=0, extra=q(r))["count"]

    def go(r, n, ex):
        if n <= CHUNK:
            out.append(q(r))
            return
        for d, minw in (("decimalLatitude", 1e-5), ("decimalLongitude", 1e-5), ("year", 0)):
            if d not in r:
                if d != "year":
                    continue
                r = {**r, "year": (1000, 2100)}
            lo, hi = r[d]
            if hi - lo > minw:
                mid = (lo + hi) / 2 if d != "year" else (lo + hi) // 2
                subs = [{**r, d: (lo, mid)}, {**r, d: (mid if d != "year" else mid + 1, hi)}]
                for sub, m in zip(subs, ex.map(count, subs)):
                    if m:
                        go(sub, m, ex)
                return
        out.append(q(r))   # 더 못 나누면 그대로(깊은 페이지)

    # 한국 둘레 상자와 그 바깥(국가 코드는 KR인데 좌표가 먼 기록) 4개로 시작
    starts = [
        {"decimalLatitude": (32.0, 40.0), "decimalLongitude": (123.0, 132.0)},
        {"decimalLatitude": (-90.0, 31.99999), "decimalLongitude": (-180.0, 180.0)},
        {"decimalLatitude": (40.00001, 90.0), "decimalLongitude": (-180.0, 180.0)},
        {"decimalLatitude": (32.0, 40.0), "decimalLongitude": (-180.0, 122.99999)},
        {"decimalLatitude": (32.0, 40.0), "decimalLongitude": (132.00001, 180.0)},
    ]
    with ThreadPoolExecutor(max_workers=5) as ex:
        for r, n in zip(starts, list(ex.map(count, starts))):
            if n:
                go(r, n, ex)
    return out


class Tally:
    """받은 기록을 바로바로 셈(기록 원본을 쌓아 두지 않아 메모리를 적게 씀)."""

    def __init__(self, loc):
        self.loc = loc
        self.units, self.sea = defaultdict(lambda: [0] * NP), [0] * NP
        self.years, self.ds, self.cells = Counter(), Counter(), Counter()
        self.precise, self.seen = [], set()

    def add(self, results):
        for r in results:
            if r["key"] in self.seen or r.get("datasetKey") == INAT_DATASET or r.get("decimalLatitude") is None:
                continue
            self.seen.add(r["key"])
            lat, lng = r["decimalLatitude"], r["decimalLongitude"]
            p = period_of(r.get("year"))
            gid = ((r.get("gadm") or {}).get("level2") or {}).get("gid") or ""
            if not gid.startswith("KOR."):
                gid = self.loc.locate(lat, lng)
            if gid:
                self.units[gid][p] += 1
            else:
                self.sea[p] += 1
            if r.get("year"):
                self.years[r["year"]] += 1
            self.ds[r.get("datasetKey") or ""] += 1
            unc = r.get("coordinateUncertaintyInMeters")
            if gid and (unc is None or unc <= MAX_UNCERTAINTY):
                c = cell_of(lat, lng)
                if c is not None:
                    self.cells[(c, p)] += 1
            y, m, d = r.get("year") or 0, r.get("month") or 0, r.get("day") or 0
            self.precise.append([r["key"], round(lat, 6), round(lng, 6), -1 if unc is None else round(unc),
                                 y * 10000 + m * 100 + d if y else 0, r.get("basisOfRecord") or "", r.get("datasetKey") or "",
                                 license_short(r.get("license")), gid or ""])


def fetch_records(keys, head, loc, name=""):
    """나눈 조각의 첫 페이지들을 동시에 받고, 이어서 나머지 페이지들을 동시에 받음."""
    t = Tally(loc)
    chunks = plan_chunks(keys, head)
    if len(chunks) > 1:
        print(f"  {name}: {head['count']:,}건을 {len(chunks)}번에 나눠 받는 중…", flush=True)
    with ThreadPoolExecutor(max_workers=5) as ex:
        firsts = list(ex.map(lambda e: fetch(keys, extra=e), chunks))
        jobs = []
        for extra, first in zip(chunks, firsts):
            t.add(first["results"])
            jobs += [(extra, off) for off in range(PAGE, first["count"], PAGE)]
        for page in ex.map(lambda j: fetch(keys, j[1], extra=j[0]), jobs):
            t.add(page["results"])
    return t


def by_facets(keys, head):
    """GBIF 집계로 시·군·구 건수를 셈(기록이 많은 종). iNaturalist 몫은 따로 집계해서 뺌."""
    has_inat = facet(head, "datasetKey").get(INAT_DATASET, 0) > 0

    def counts(extra):
        d = fetch(keys, limit=0, extra=[("facet", "gadmLevel2Gid"), ("facetLimit", 400)] + extra)
        return d["count"], kor(facet(d, "gadmLevel2Gid"))

    units, sea = defaultdict(lambda: [0] * NP), [0] * NP
    all_units = kor(facet(head, "gadmLevel2Gid"))
    all_total = head["count"]
    years, ds = Counter({int(k): v for k, v in facet(head, "year").items()}), Counter(facet(head, "datasetKey"))
    if has_inat:
        d = fetch(keys, limit=0, extra=[("datasetKey", INAT_DATASET)] + FACETS)
        all_units.subtract(kor(facet(d, "gadmLevel2Gid")))
        all_total -= d["count"]
        years.subtract({int(k): v for k, v in facet(d, "year").items()})
        del ds[INAT_DATASET]
    for i, (_, a, b) in enumerate(PERIODS):
        n, u = counts([("year", f"{a},{b}")])
        if has_inat:
            n2, u2 = counts([("year", f"{a},{b}"), ("datasetKey", INAT_DATASET)])
            n -= n2
            u.subtract(u2)
        for gid, c in u.items():
            if c > 0:
                units[gid][i] = c
        sea[i] = max(0, n - sum(c for c in u.values() if c > 0))
    # 연도 미상 = 전체 − 기간 합
    known = sum(sea[:-1]) + sum(sum(v[:-1]) for v in units.values())
    for gid, c in all_units.items():
        rest = c - sum(units[gid][:-1]) if gid in units else c
        if rest > 0:
            units[gid][-1] = rest
    sea[-1] = max(0, all_total - known - sum(v[-1] for v in units.values()))
    return units, sea, +years, +ds


def species_entry(sp, loc):
    sid, name, keys = sp
    head = fetch(keys, limit=0, extra=FACETS)
    if head["count"] == 0:
        print(f"  {name}: 0", flush=True)
        return sid, None, None
    t = fetch_records(keys, head, loc, name)
    units, sea, years, ds, cells, precise = t.units, t.sea, t.years, t.ds, t.cells, t.precise
    how = ""
    expected = head["count"] - facet(head, "datasetKey").get(INAT_DATASET, 0)
    if len(t.seen) < 0.995 * expected:   # 나눠 받다 연도 없는 기록이 빠졌으면 시·군·구 건수는 집계로
        fu, fs, fy, fds = by_facets(keys, head)
        ftotal = sum(fs) + sum(sum(v) for v in fu.values())
        if sum(fs) > 0.1 * ftotal:
            # 갯벌·해안 새처럼 바다 좌표가 많으면: 연도 있는 기록은 직접 센 값(해안 배정), 연도 미상 몫만 집계 값
            for gid, v in fu.items():
                if v[-1]:
                    units[gid][-1] += v[-1]
            sea[-1] += fs[-1]
            how = " (나눠 받음+해안 배정)"
        else:
            units, sea, years = fu, fs, fy
            how = " (집계)"
        ds = fds
    total = sum(sea) + sum(sum(v) for v in units.values())
    print(f"  {name}: {total:,}건 · 시·군·구 {len(units)}곳 · 격자 {len({c for c, _ in cells}):,}칸{how}"
          f"{f' · 바다·미상 {sum(sea):,}' if sum(sea) else ''}", flush=True)
    entry = {"taxonKey": keys[0], "total": total, "units": dict(units), "sea": sea,
             "years": sorted(years.items()), "ds": ds.most_common(30)}
    flat = [x for (c, p), n in sorted(cells.items()) for x in (c, p, n)]
    return sid, entry, {"cells": flat, "precise": precise}


_orgs = {}


def fetch_title(key):
    """자료 묶음 제목과 자료를 낸 기관 이름."""
    def get(url):
        for attempt in range(6):
            try:
                with GATE, urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                    return json.load(r)
            except Exception:
                if attempt == 5:
                    raise
                time.sleep(3 * (attempt + 1))

    try:
        ds = get(f"https://api.gbif.org/v1/dataset/{key}")
        org = ds.get("publishingOrganizationKey")
        if org and org not in _orgs:
            _orgs[org] = get(f"https://api.gbif.org/v1/organization/{org}").get("title", "")
        return ds.get("title", ""), _orgs.get(org, "")
    except Exception:
        return "", ""


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    started = time.time()
    snap_path, heat_path, precise_path = DATA / "gbif-snapshot.json", DATA / "heat-gbif.json", DATA / "precise-gbif.enc.json"
    pw = secure.password()
    species, loc = load_species(), Locator()
    only = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None

    entries, cells, precise, titles = {}, {}, {}, {}
    if only:   # 기존 파일에서 나머지 종을 가져옴
        old = json.loads(snap_path.read_text(encoding="utf-8"))
        old_keys = [d[0] for d in old["datasets"]]
        titles = {d[0]: (d[1], d[2]) for d in old["datasets"]}
        for sid, e in old["species"].items():
            if sid not in only:
                e["ds"] = [[old_keys[i], n] for i, n in e["ds"]]
                entries[sid] = e
        if heat_path.exists():
            cells = {k: v for k, v in json.loads(heat_path.read_text(encoding="utf-8"))["species"].items() if k not in only}
        if pw and precise_path.exists():
            p_old = secure.read_encrypted(precise_path, pw)
            titles.update({d[0]: (d[1], d[2]) for d in p_old["datasets"]})
            precise = {k: [r[:6] + [p_old["datasets"][r[6]][0] if r[6] >= 0 else ""] + r[7:] for r in v]
                       for k, v in p_old["species"].items() if k not in only}
        species = [s for s in species if s[0] in only]

    print(f"GBIF에서 {len(species)}종을 받습니다…", flush=True)
    with ThreadPoolExecutor(max_workers=4) as ex:
        for sid, entry, extra in ex.map(lambda s: species_entry(s, loc), species):
            if entry:
                entries[sid] = entry
                cells[sid] = extra["cells"]
                precise[sid] = extra["precise"]

    # 자료 묶음(dataset) 제목·기관
    keys = sorted({k for e in entries.values() for k, _ in e["ds"] if k} | {r[6] for v in precise.values() for r in v if r[6]})
    missing = [k for k in keys if k not in titles]
    with ThreadPoolExecutor(max_workers=6) as ex:
        titles.update(dict(zip(missing, ex.map(fetch_title, missing))))
    index = {k: i for i, k in enumerate(keys)}
    datasets = [[k, *titles[k]] for k in keys]   # [키, 제목, 기관]
    for e in entries.values():
        e["ds"] = [[index[k], n] for k, n in e["ds"] if k in index]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    snap_path.write_text(json.dumps({
        "generatedAt": now, "source": "GBIF.org occurrence search (country=KR, iNaturalist 제외) — 시·군·구별 집계",
        "periods": [p[0] for p in PERIODS] + ["연도 미상"], "datasets": datasets, "species": entries,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    heat_path.write_text(json.dumps({
        "generatedAt": now, "grid": GRID, "columns": ["cell", "period", "n"], "species": cells,
    }, separators=(",", ":")), encoding="utf-8")
    n = sum(e["total"] for e in entries.values())
    print(f"저장: {snap_path.name} ({len(entries)}종 {n:,}건, {snap_path.stat().st_size / 1e6:.2f} MB), "
          f"{heat_path.name} ({sum(len(v) // 3 for v in cells.values()):,}칸, {heat_path.stat().st_size / 1e6:.2f} MB)")

    if pw:
        for v in precise.values():
            for r in v:
                r[6] = index.get(r[6], -1)
        secure.write_encrypted(precise_path, {
            "generatedAt": now, "source": "GBIF.org (country=KR, iNaturalist 제외)",
            "columns": ["gbifKey", "lat", "lng", "uncertainty_m", "date", "basisOfRecord", "dataset", "license", "gid"],
            "datasets": datasets, "species": precise,
        }, pw)
        print(f"저장: {precise_path.name} (정밀 기록 {sum(len(v) for v in precise.values()):,}건, 암호화 {precise_path.stat().st_size / 1e6:.2f} MB)")
    else:
        print("비밀번호(DATA_PASSWORD)가 없어 정밀 좌표 파일은 그대로 둡니다.")
    print(f"{time.time() - started:.0f}초")


if __name__ == "__main__":
    main()
