"""멸종위기 야생생물 목록(js/data-species.js)을 만듭니다.

기준 목록은 tools/endangered_2022.tsv 입니다(야생생물법 시행규칙 [별표 1], 2022. 12. 9. 개정 —
2026. 5. 12. 시행본에서도 같음). GBIF 분류 키, iNaturalist ID, IUCN 적색목록 범주, 과는 각 API에서
찾아 채웁니다. 목록이 바뀌면 TSV를 고친 뒤 다시 실행하세요.

    python tools/build_species.py
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UA = {"User-Agent": "korea-endangered-map/1.0 (species list build)"}

KINGDOM = {"plant": "Plantae", "algae": None, "fungi": "Fungi"}

# 별표 학명과 다르게 조회할 종: 국명 → (GBIF 학명 또는 "-"(조회 안 함), GBIF 보조 학명들, iNat 학명 또는 "-", 메모)
EXTIRPATED = "국내 야생 절멸(추정). 기록은 대부분 과거 표본이나 오래된 자료입니다."
OVERRIDE = {
    "늑대": (None, [], None, EXTIRPATED),
    "대륙사슴": ("-", [], "-", "토종 아종으로 국내 야생 절멸(추정). 국내 사슴(Cervus nippon) 기록은 대부분 사육하던 꽃사슴이 야생화한 개체라 넣지 않았습니다."),
    "표범": (None, [], None, EXTIRPATED),
    "호랑이": (None, [], None, EXTIRPATED),
    "스라소니": (None, [], None, EXTIRPATED),
    "여우": (None, [], None, "소백산 등에서 복원 사업으로 방사한 개체가 살고 있습니다."),
    "반달가슴곰": (None, [], None, "지리산 등에서 복원 사업이 진행 중입니다."),
    "붉은박쥐": (None, ["Myotis formosus"], None, "‘황금박쥐’로도 불립니다."),
    "토끼박쥐": (None, ["Plecotus auritus"], None, ""),
    "물범": (None, [], None, "점박이물범입니다. 백령도가 대표적인 서식지입니다."),
    "물개": (None, [], None, "북방물개입니다."),
    "담비": (None, [], None, "노란목도리담비입니다."),
    # 학명 표기가 GBIF·iNaturalist와 다른 종 (숫자는 GBIF 키를 직접 지정 — 동의어라 정식 이름으로 바꾸면 다른 종 기록이 섞이는 경우)
    "흰수마자": ("Gobiobotia naktongensis", [], "Gobiobotia naktongensis", ""),
    "큰홍띠점박이푸른부전나비": ("Shijimiaeoides divina", [], "Shijimiaeoides divina", ""),
    "쌍꼬리부전나비": ("Spindasis takanonis", [], "Cigaritis takanonis", ""),
    "여름어리표범나비": ("Melitaea ambigua", [], "Melitaea ambigua", ""),
    "섬개야광나무": (3025628, [], None, "울릉도 고유종. GBIF에서는 Cotoneaster wilsonii 이름으로 올라온 기록만 모았습니다."),
    "한라장구채": (5588134, [], "Silene argentea", "GBIF에서는 Silene fasciculata 이름으로 올라온 기록만 모았습니다."),
    "윤조롱박딱정벌레": (None, [], "Carabus leechi yooni", ""),
    "창언조롱박딱정벌레": (None, [], "Carabus changeonleei", ""),
    "칠성장어": (None, [], "Lethenteron camtschaticum", ""),
    # 변종이 GBIF에서 모종(母種)의 동의어로 묶여 있어, 정식 이름으로 조회하면 모종 기록이 섞이는 경우
    "한라솜다리": (9617312, [], None, "GBIF에서는 이 변종 이름으로 올라온 기록만 모았습니다(솜다리 기록 제외)."),
    "각시수련": (3697384, [], None, "GBIF에서는 이 변종 이름으로 올라온 기록만 모았습니다(수련 기록 제외)."),
    "단양쑥부쟁이": (6301942, [], None, "GBIF에서는 이 변종 이름으로 올라온 기록만 모았습니다(쑥부쟁이류 기록 제외)."),
}


def get(url):
    for a in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return json.load(r)
        except Exception:
            time.sleep(2 + 2 * a)
    return {}


def lookup_name(group, sci):
    """조회에 쓸 학명: 아속 괄호는 빼고, 동물은 아종을 빼서 종 단위로(국내 기록은 사실상 그 아종)."""
    s = re.sub(r"\s*\([^)]*\)", "", sci).strip()
    if group in ("plant", "algae", "fungi"):
        return s
    return " ".join(s.split()[:2])


def gbif_match(name, group):
    q = {"name": name, "strict": "true", "verbose": "false"}
    if KINGDOM.get(group):
        q["kingdom"] = KINGDOM[group]
    elif group not in ("algae",):
        q["kingdom"] = "Animalia"
    m = get("https://api.gbif.org/v1/species/match?" + urllib.parse.urlencode(q))
    # 속(屬) 같은 상위 분류로만 맞으면 다른 종 기록이 섞이므로 버림
    if m.get("matchType") in (None, "NONE", "HIGHERRANK"):
        return None
    return {
        # 정식 이름 키로 조회해야 동의어로 올라간 기록까지 함께 나옴
        "key": m.get("acceptedUsageKey") or m.get("usageKey"),
        "matched": m.get("canonicalName", ""), "rank": m.get("rank", ""), "type": m.get("matchType"),
        "family": m.get("family", ""),
    }


def gbif_iucn(key):
    d = get(f"https://api.gbif.org/v1/species/{key}/iucnRedListCategory")
    return d.get("code", "") if d else ""


def inat_id(name):
    q = name.replace(" var. ", " ").replace(" subsp. ", " ")
    d = get("https://api.inaturalist.org/v1/taxa?" + urllib.parse.urlencode({"q": q, "per_page": 30, "is_active": "true"}))
    for t in d.get("results", []):
        if t["name"].lower() == q.lower() or (t.get("matched_term") or "").lower() == q.lower():
            return t["id"]
    return None


def load_list():
    rows = []
    for line in (ROOT / "tools" / "endangered_2022.tsv").read_text(encoding="utf-8").splitlines():
        if line.startswith("#") or not line.strip():
            continue
        group, grade, no, name, sci = line.split("\t")
        rows.append((group, grade, int(no), name, sci))
    return rows


def resolve(row):
    group, grade, no, name, sci = row
    gname, alts, iname, note = OVERRIDE.get(name, (None, [], None, ""))
    look = lookup_name(group, sci)
    if isinstance(gname, int):
        sp = get(f"https://api.gbif.org/v1/species/{gname}")
        g = {"key": gname, "matched": sp.get("canonicalName", ""), "rank": sp.get("rank", ""), "type": "EXACT", "family": sp.get("family", "")}
    else:
        g = None if gname == "-" else gbif_match(gname or look, group)
    alt_keys = []
    for a in alts:
        x = gbif_match(a, group)
        if x and x["key"] and (not g or x["key"] != g["key"]):
            alt_keys.append(x["key"])
    iucn = gbif_iucn(g["key"]) if g and g["key"] else ""
    return {"row": row, "g": g, "alts": alt_keys, "iucn": iucn, "iname": None if iname == "-" else (iname or look), "note": note}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    rows = load_list()
    with ThreadPoolExecutor(max_workers=6) as ex:
        res = list(ex.map(resolve, rows))
    # iNaturalist는 초당 1회 정도로 천천히
    for r in res:
        r["inat"] = inat_id(r["iname"]) if r["iname"] else None
        time.sleep(0.9)

    lines, warn, seen = [], [], set()
    for r in res:
        group, grade, no, name, sci = r["row"]
        g = r["g"]
        sid = re.sub(r"[^a-z0-9]+", "-", re.sub(r"\([^)]*\)", "", sci).lower()).strip("-")
        if sid in seen:
            sid += "-" + grade
        seen.add(sid)
        if OVERRIDE.get(name, (None,))[0] != "-" and not isinstance(OVERRIDE.get(name, (None,))[0], int):
            if not g:
                warn.append(f"GBIF 없음: {name} {sci}")
            elif g["type"] != "EXACT" or g["matched"].lower() != r["row"][4].lower() and g["matched"].lower() != lookup_name(group, sci).lower():
                warn.append(f"GBIF 확인: {name} {sci} → {g['matched']} ({g['rank']}, {g['type']})")
        if r["iname"] and not r["inat"]:
            warn.append(f"iNat 없음: {name} {r['iname']}")
        fields = [
            f'id: "{sid}"', f'name: "{name}"', f'sci: "{sci}"', f'group: "{group}"', f'grade: "{grade}"',
            f'family: "{(g or {}).get("family", "")}"', f'iucn: "{r["iucn"]}"', f'gbif: {(g or {}).get("key") or "null"}',
        ]
        if r["alts"]:
            fields.append(f"gbifAlt: [{', '.join(map(str, r['alts']))}]")
        fields.append(f'inat: {r["inat"] or "null"}')
        if r["note"]:
            fields.append(f'note: {json.dumps(r["note"], ensure_ascii=False)}')
        lines.append("  { " + ", ".join(fields) + " },")
        print(f"{name:12} {sci:40} gbif={(g or {}).get('key')} {(g or {}).get('matched', '')} inat={r['inat']} iucn={r['iucn']}", flush=True)

    head = '''// 멸종위기 야생생물 목록 — tools/build_species.py 가 만든 파일입니다. 직접 고치지 말고 그 스크립트나 endangered_2022.tsv를 고치세요.
// 기준: 야생생물 보호 및 관리에 관한 법률 시행규칙 [별표 1] (2022. 12. 9. 개정, 2026. 5. 12. 시행본과 같음)
// gbif: GBIF 분류 키, gbifAlt: 같은 종이 다른 학명으로 올라간 GBIF 키들, inat: iNaturalist 분류 ID.
// 모든 종이 보호 대상이라 지도·내려받기는 시·군·구 단위로만 공개합니다.

window.TAXON_GROUPS = {
  mammal: { label: "포유류",       color: "#c2255c" },
  bird:   { label: "조류",         color: "#1c7ed6" },
  herp:   { label: "양서·파충류",  color: "#2b8a3e" },
  fish:   { label: "어류",         color: "#0c8599" },
  insect: { label: "곤충",         color: "#e8590c" },
  invert: { label: "무척추동물",   color: "#7048e8" },
  plant:  { label: "육상식물",     color: "#5c940d" },
  algae:  { label: "해조류",       color: "#087f5b" },
  fungi:  { label: "고등균류",     color: "#a0522d" },
};

window.STATUS = {
  en1: { label: "멸종위기 Ⅰ급", short: "Ⅰ급", color: "#c92a2a" },
  en2: { label: "멸종위기 Ⅱ급", short: "Ⅱ급", color: "#e8590c" },
};

window.SPECIES_CATALOG = [
'''
    (ROOT / "js" / "data-species.js").write_text(head + "\n".join(lines) + "\n];\n", encoding="utf-8")
    print(f"\n{len(lines)}종 저장")
    for m in warn:
        print("  ", m)


if __name__ == "__main__":
    main()
