"""iNaturalist 국내 멸종위기 야생생물 관찰 스냅샷(data/inat-snapshot.json).

앱은 이 스냅샷을 먼저 읽고, 그 뒤에 바뀐 관찰만 iNaturalist API에서 실시간으로 받아 합칩니다.
공개 스냅샷에는 좌표 대신 관찰마다 시·군·구 코드와 열지도 격자(약 250m) 번호만 저장합니다.
iNaturalist가 위치를 흐린 관찰과 위치 오차가 1km를 넘는 관찰은 격자 번호를 비워 둡니다.
정밀 좌표는 환경 변수 DATA_PASSWORD가 있을 때만 암호화해 data/precise-inat.enc.json에 저장합니다.

    python tools/inat_snapshot.py

사진은 CC 라이선스가 붙은 것만 미리보기 대상으로 저장합니다(‘모든 권리 보유’ 사진은 링크만).
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sgg import MAX_UNCERTAINTY, Locator, cell_of  # noqa: E402
import secure  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
API = "https://api.inaturalist.org/v2/observations"
PLACE_KOREA = 6891
UA = {"User-Agent": "korea-endangered-map/1.0 (citizen science map; snapshot)"}
BATCH = 25
FIELDS = ("id,quality_grade,observed_on,location,obscured,positional_accuracy,taxon.id,taxon.ancestor_ids,"
          "user.login,photos.url,photos.license_code,license_code")


def get(url):
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return json.load(r)
        except Exception:
            if attempt == 4:
                raise
            time.sleep(3 * (attempt + 1))


def load_species():
    src = (ROOT / "js" / "data-species.js").read_text(encoding="utf-8")
    out = []
    for line in src.splitlines():
        m = re.search(r'\{ id: "([^"]+)", name: "([^"]+)".*?inat: (\d+)', line)
        if m:
            out.append((m.group(1), m.group(2), int(m.group(3))))
    return out


def short_photo(photos):
    """CC 라이선스 사진 1장을 'o123.jpg'(open-data) 또는 's123.jpg'(static) 꼴로 줄여 저장."""
    for p in photos or []:
        lic = p.get("license_code")
        url = p.get("url") or ""
        m = re.search(r"//(inaturalist-open-data\.s3\.amazonaws\.com|static\.inaturalist\.org)/photos/(\d+)/square\.(\w+)", url)
        if lic and m:
            host = "o" if m.group(1).startswith("inaturalist-open-data") else "s"
            return f"{host}{m.group(2)}.{m.group(3)}", lic
    return "", ""


def pack(o, loc):
    """(공개 행, 정밀 행)"""
    lat, lng = (float(v) for v in o["location"].split(","))
    date = int((o.get("observed_on") or "0").replace("-", "") or 0)
    photo, lic = short_photo(o.get("photos"))
    gid = loc.locate(lat, lng) or ""
    acc = o.get("positional_accuracy")
    fine = gid and not o.get("obscured") and (acc is None or acc <= MAX_UNCERTAINTY)
    cell = cell_of(lat, lng) if fine else None
    row = [o["id"], gid, date, 1 if o["quality_grade"] == "research" else 0,
           1 if o.get("obscured") else 0, (o.get("user") or {}).get("login", ""), photo, lic,
           len(o.get("photos") or []), o.get("license_code") or "", -1 if cell is None else cell]
    return row, [o["id"], round(lat, 6), round(lng, 6), -1 if acc is None else round(acc), 1 if o.get("obscured") else 0]


def fetch_batch(tids, owner, loc, obs, precise):
    last, n = 0, 0
    while True:
        qs = urllib.parse.urlencode({
            "place_id": PLACE_KOREA, "taxon_id": ",".join(map(str, tids)), "verifiable": "true", "per_page": 200,
            "order_by": "id", "order": "asc", "id_above": last, "fields": FIELDS,
        })
        res = get(f"{API}?{qs}").get("results", [])
        for o in res:
            t = o.get("taxon") or {}
            # 아종·변종으로 올라온 관찰도 목록의 종으로 모음
            sid = owner.get(t.get("id")) or next((owner[a] for a in reversed(t.get("ancestor_ids") or []) if a in owner), None)
            if sid and o.get("location"):
                row, fine = pack(o, loc)
                obs.setdefault(sid, []).append(row)
                precise.setdefault(sid, []).append(fine)
                n += 1
        if len(res) < 200:
            return n
        last = res[-1]["id"]
        time.sleep(1.0)   # iNaturalist 권장: 초당 1회 이하


def taxon_photos(ids):
    out = {}
    results = []
    for i in range(0, len(ids), 20):   # 한 번에 너무 많이 요청하면 422 오류
        results += get("https://api.inaturalist.org/v1/taxa/" + ",".join(map(str, ids[i:i + 20])) + "?locale=ko").get("results", [])
        time.sleep(1.0)
    for t in results:
        wiki = re.sub(r"<[^>]+>", "", t.get("wikipedia_summary") or "").strip()
        if len(wiki) > 420:
            wiki = wiki[:420].rsplit(" ", 1)[0] + "…"
        out.setdefault(t["id"], {})["wiki"] = wiki
        p = t.get("default_photo") or {}
        url = p.get("square_url") or ""
        m = re.search(r"//(inaturalist-open-data\.s3\.amazonaws\.com|static\.inaturalist\.org)/photos/(\d+)/square\.(\w+)", url)
        if m and p.get("license_code"):
            host = "o" if m.group(1).startswith("inaturalist-open-data") else "s"
            out[t["id"]].update({"photo": f"{host}{m.group(2)}.{m.group(3)}", "lic": p["license_code"],
                                 "by": p.get("attribution", "")})
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    species, loc = load_species(), Locator()
    started = datetime.now(timezone.utc)
    owner = {tid: sid for sid, _, tid in species}
    photos = taxon_photos([t for _, _, t in species])
    obs, precise = {}, {}
    tids = [t for _, _, t in species]
    for i in range(0, len(tids), BATCH):
        n = fetch_batch(tids[i:i + BATCH], owner, loc, obs, precise)
        print(f"  {i + 1}~{min(i + BATCH, len(tids))}번째 종: {n:,}건", flush=True)
        time.sleep(1.0)
    taxa = {sid: {"id": tid, **photos.get(tid, {})} for sid, _, tid in species}
    total = sum(len(v) for v in obs.values())
    out = {
        "generatedAt": started.isoformat(timespec="seconds"),
        "source": "iNaturalist (place_id=6891, verifiable=true) — 좌표 대신 시·군·구 코드와 약 250m 격자 번호",
        "place_id": PLACE_KOREA,
        "columns": ["id", "gid", "date", "verified", "obscured", "user", "photo", "photo_license", "photos", "obs_license", "cell"],
        "taxa": taxa,
        "obs": obs,
    }
    path = ROOT / "data" / "inat-snapshot.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"저장: {path.name} ({len(obs)}종 {total:,}건, {path.stat().st_size / 1e6:.2f} MB)")
    pw = secure.password()
    if pw:
        enc = ROOT / "data" / "precise-inat.enc.json"
        secure.write_encrypted(enc, {
            "generatedAt": started.isoformat(timespec="seconds"), "source": "iNaturalist (place_id=6891, verifiable=true)",
            "columns": ["id", "lat", "lng", "accuracy_m", "obscured"], "species": precise,
        }, pw)
        print(f"저장: {enc.name} (암호화 {enc.stat().st_size / 1e6:.2f} MB)")
    else:
        print("비밀번호(DATA_PASSWORD)가 없어 정밀 좌표 파일은 그대로 둡니다.")


if __name__ == "__main__":
    main()
