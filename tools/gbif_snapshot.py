"""GBIF 국내 멸종위기 야생생물 기록 → 시·군·구별 집계(data/gbif-snapshot.json).

멸종위기종은 정확한 위치를 공개하지 않으므로 기록 하나하나의 좌표는 저장하지 않고,
시·군·구 × 기간별 건수만 저장합니다.

- 기록이 적은 종(SMALL 이하): 기록을 모두 받아 GBIF가 붙인 시·군·구 코드로 세고,
  코드가 없는 바다·해안 기록은 가장 가까운 시·군·구(25km 이내)로 배정합니다.
- 기록이 많은 종: GBIF 집계(facet) 기능으로 시·군·구별 건수를 한 번에 받습니다(몇 초면 끝남).

    python tools/gbif_snapshot.py
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sgg import Locator  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
API = "https://api.gbif.org/v1/occurrence/search"
PAGE = 300
SMALL = 3000
CHUNK = 3000          # 기록을 직접 받을 때 한 번의 검색 크기
COASTAL_MAX = 30000   # 바다 기록이 많은 종을 직접 받는 최대 기록 수
PLAIN_MAX = 10000     # 이보다 적으면 연도 구간으로 나누지 않고 한 번에 받음
# 동물원·식물원 개체(살아 있는 표본)와 화석은 빼고 받음
BASIS = ["HUMAN_OBSERVATION", "MACHINE_OBSERVATION", "PRESERVED_SPECIMEN", "OCCURRENCE", "MATERIAL_SAMPLE", "OBSERVATION"]
# iNaturalist 관찰은 앱이 iNaturalist에서 직접 받으므로 GBIF에서는 뺌(중복 방지)
INAT_DATASET = "50c9509d-22c7-4a22-a47d-8c48425ef4a7"
# 기간: 앱의 연도 필터 단위. 마지막 칸은 연도 미상
PERIODS = [("1999년 이전", 1000, 1999), ("2000~2009년", 2000, 2009), ("2010~2019년", 2010, 2019), ("2020년 이후", 2020, 2100)]
NP = len(PERIODS) + 1


def period_of(year):
    for i, (_, a, b) in enumerate(PERIODS):
        if year and a <= year <= b:
            return i
    return len(PERIODS)


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
    for attempt in range(5):
        try:
            with urllib.request.urlopen(f"{API}?{qs}", timeout=90) as r:
                return json.load(r)
        except Exception:
            if attempt == 4:
                raise
            time.sleep(2 + 2 * attempt)


def facet(d, field):
    for f in d.get("facets") or []:
        if f["field"].replace("_", "").lower() == field.replace("_", "").lower():
            return {c["name"]: c["count"] for c in f["counts"]}
    return {}


FACETS = [("facet", "gadmLevel2Gid"), ("facet", "year"), ("facet", "datasetKey"), ("facetLimit", 400)]


def kor(counts):
    """남한 시·군·구 코드만(국가 코드가 KR이어도 좌표가 북한·바다 건너인 기록이 있음)."""
    return Counter({k: v for k, v in counts.items() if k.startswith("KOR.")})


def year_chunks(head):
    """연도 구간 조건 목록: 구간마다 기록이 CHUNK 안팎이 되게(GBIF는 뒤쪽 페이지일수록 매우 느려짐)."""
    years = sorted((int(k), v) for k, v in facet(head, "year").items())
    chunks, cur, n = [], None, 0
    for y, c in years:
        if cur and n + c > CHUNK:
            chunks.append([("year", f"{cur[0]},{cur[1]}")])
            cur, n = None, 0
        cur = (cur[0] if cur else y, y)
        n += c
    if cur:
        chunks.append([("year", f"{cur[0]},{cur[1]}")])
    return chunks


def by_records(keys, loc, chunks=([],)):
    """기록을 모두 받아 직접 셈. chunks를 주면 연도 구간별로 나눠 받음(연도 없는 기록은 빠짐)."""
    results = []
    for extra in chunks:
        first = fetch(keys, extra=extra)
        results.extend(first["results"])
        with ThreadPoolExecutor(max_workers=3) as ex:
            for page in ex.map(lambda off: fetch(keys, off, extra=extra), range(PAGE, first["count"], PAGE)):
                results.extend(page["results"])
    units, sea, years, ds, seen = defaultdict(lambda: [0] * NP), [0] * NP, Counter(), Counter(), set()
    for r in results:
        if r["key"] in seen or r.get("datasetKey") == INAT_DATASET or r.get("decimalLatitude") is None:
            continue
        seen.add(r["key"])
        p = period_of(r.get("year"))
        gid = ((r.get("gadm") or {}).get("level2") or {}).get("gid") or ""
        if not gid.startswith("KOR."):
            gid = loc.locate(r["decimalLatitude"], r["decimalLongitude"])
        if gid:
            units[gid][p] += 1
        else:
            sea[p] += 1
        if r.get("year"):
            years[r["year"]] += 1
        ds[r.get("datasetKey") or ""] += 1
    return units, sea, years, ds


def by_facets(keys, head):
    """GBIF 집계로 셈(기록이 많은 종). iNaturalist 몫은 따로 집계해서 뺌."""
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
        return sid, None
    small = head["count"] <= SMALL
    units, sea, years, ds = by_records(keys, loc) if small else by_facets(keys, head)
    how = "" if small else " (집계)"
    total = sum(sea) + sum(sum(v) for v in units.values())
    # 갯벌·해안 새처럼 바다 좌표 기록이 많으면, 연도가 있는 기록은 직접 받아 가까운 해안 시·군·구로 배정
    if not small and sum(sea) > 0.1 * total and head["count"] <= COASTAL_MAX:
        if head["count"] <= PLAIN_MAX:        # 1만 건 이하는 한 번에 다 받음(연도 없는 기록 포함)
            units, sea, years, _ = by_records(keys, loc)
        else:
            ru, rs, ry, _ = by_records(keys, loc, year_chunks(head))
            for gid, v in units.items():      # 연도 미상 몫은 집계 결과를 그대로 씀
                if v[-1]:
                    ru[gid][-1] += v[-1]
            rs[-1] += sea[-1]
            units, sea, years = ru, rs, ry
        how = " (집계+해안 배정)"
        total = sum(sea) + sum(sum(v) for v in units.values())
    print(f"  {name}: {total:,}건 · 시·군·구 {len(units)}곳{how}{f' · 바다·미상 {sum(sea):,}' if sum(sea) else ''}", flush=True)
    return sid, {"taxonKey": keys[0], "total": total, "units": dict(units), "sea": sea,
                 "years": sorted(years.items()), "ds": ds.most_common(30)}


_orgs = {}


def fetch_title(key):
    """자료 묶음 제목과 자료를 낸 기관 이름."""
    try:
        with urllib.request.urlopen(f"https://api.gbif.org/v1/dataset/{key}", timeout=60) as r:
            ds = json.load(r)
        org = ds.get("publishingOrganizationKey")
        if org and org not in _orgs:
            with urllib.request.urlopen(f"https://api.gbif.org/v1/organization/{org}", timeout=60) as r:
                _orgs[org] = json.load(r).get("title", "")
        return ds.get("title", ""), _orgs.get(org, "")
    except Exception:
        return "", ""


def main():
    """인자 없이: 전체를 새로 받음. --only 종ID,종ID: 기존 스냅샷에서 그 종만 다시 받아 바꿈."""
    sys.stdout.reconfigure(encoding="utf-8")
    started = time.time()
    path = ROOT / "data" / "gbif-snapshot.json"
    species, loc = load_species(), Locator()
    only = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None
    entries = {}
    if only:
        old = json.loads(path.read_text(encoding="utf-8"))
        old_keys = [d[0] for d in old["datasets"]]
        for sid, e in old["species"].items():
            if sid not in only:
                e["ds"] = [[old_keys[i], n] for i, n in e["ds"]]
                entries[sid] = e
        old_titles = {d[0]: (d[1], d[2]) for d in old["datasets"]}
        species = [s for s in species if s[0] in only]
    print(f"GBIF에서 {len(species)}종을 받습니다…", flush=True)
    with ThreadPoolExecutor(max_workers=6) as ex:
        entries.update({k: v for k, v in ex.map(lambda s: species_entry(s, loc), species) if v})
    # 자료 묶음(dataset) 키를 번호로 바꾸고 제목을 함께 저장 → "출처: 국립생태원 …" 표시
    keys = sorted({k for e in entries.values() for k, _ in e["ds"] if k})
    if only:
        _known = old_titles
        missing = [k for k in keys if k not in _known]
        with ThreadPoolExecutor(max_workers=6) as ex:
            _known.update(dict(zip(missing, ex.map(fetch_title, missing))))
        titles = {k: _known[k] for k in keys}
    else:
        with ThreadPoolExecutor(max_workers=6) as ex:
            titles = dict(zip(keys, ex.map(fetch_title, keys)))
    with ThreadPoolExecutor(max_workers=6) as ex:
        titles = dict(zip(keys, ex.map(fetch_title, keys)))
    index = {k: i for i, k in enumerate(keys)}
    for e in entries.values():
        e["ds"] = [[index[k], n] for k, n in e["ds"] if k in index]
    out = {
        "generatedAt": old["generatedAt"] if only else datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "GBIF.org occurrence search (country=KR, iNaturalist 제외) — 시·군·구별 집계",
        "periods": [p[0] for p in PERIODS] + ["연도 미상"],
        "datasets": [[k, *titles[k]] for k in keys],   # [키, 제목, 기관]
        "species": entries,
    }
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n = sum(e["total"] for e in entries.values())
    print(f"저장: {path.name} ({len(entries)}종 {n:,}건, {path.stat().st_size / 1e6:.2f} MB, {time.time() - started:.0f}초)")


if __name__ == "__main__":
    main()
