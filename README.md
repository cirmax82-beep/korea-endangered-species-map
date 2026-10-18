# 멸종위기종 종합관리 · 시민 분포지도

국내 **멸종위기 야생생물 282종**이 어디에 사는지, 시민 관찰(집단지성)과 기관 기록을 합쳐 **시·군·구 단위**로 보여 주는 공개 지도입니다. [교란생물 종합관리](https://invasive.biogrideia.com/)와 같은 방식으로 만들었습니다.

- **공개 지도**: https://endangered.biogrideia.com/
- **참여 안내 바로가기**(홍보용): https://endangered.biogrideia.com/#join
- 새 주소는 호스팅케이알 DNS의 CNAME 레코드(`endangered` → `cirmax82-beep.github.io`)로 연결됩니다. 지우면 사이트가 열리지 않습니다. biogrideia.com은 GitHub 도메인 소유 인증이 되어 있습니다(TXT `_github-pages-challenge-cirmax82-beep`, 지우지 마세요).

## 구조

- **참여(제보)**: 시민은 [iNaturalist](https://www.inaturalist.org) 앱으로 사진을 올립니다. 다른 참여자와 전문가가 종을 확인해 의견의 3분의 2 이상이 일치하면 ‘검증됨’이 됩니다.
- **지도(결과)**: 이 앱이 iNaturalist 관찰을 10분마다 실시간으로 받아 반영하고, GBIF에 공개된 기관 조사·표본·타 플랫폼 기록을 시·군·구별로 센 자료와 합쳐 보여 줍니다.

## 위치 공개 원칙

모든 대상 종이 법정 보호종이라, 밀렵·불법 채취와 서식지 교란을 막기 위해 **좌표를 저장하지 않습니다.**

- 기본 자료(스냅샷)를 만들 때 기록마다 시·군·구 코드만 남깁니다. 공개 저장소의 자료 파일에도 좌표가 없습니다(`tools/inat_snapshot.py`, `tools/gbif_snapshot.py`).
- 앱이 실시간으로 받는 iNaturalist 관찰도 좌표로 시·군·구만 판별하고 좌표는 버립니다(`js/sources.js`).
- 연구용 내려받기도 시·군·구 × 기간 집계만 제공합니다.
- 시민 관찰 원본 링크는 iNaturalist가 위치를 흐린 관찰에만 겁니다.

## 대상 종

`tools/endangered_2022.tsv`가 기준입니다. 「야생생물 보호 및 관리에 관한 법률 시행규칙」 [별표 1] 멸종위기 야생생물(2022. 12. 9. 개정, Ⅰ급 68종·Ⅱ급 214종)을 그대로 옮긴 것으로, 2026. 5. 12. 시행본의 별표 1도 같은 내용입니다. 목록이 바뀌면 이 파일을 고친 뒤 다시 만드세요.

```bash
python tools/build_species.py
```

- GBIF 분류 키·iNaturalist ID·IUCN 범주·과는 API에서 찾아 채웁니다(`js/data-species.js`).
- 동물 아종(반달가슴곰 *Ursus thibetanus ussuricus* 등)은 종 단위로 조회합니다. 국내 기록은 사실상 그 아종입니다. 식물 변종·아종은 그 단위 그대로 조회합니다.
- 학명 표기가 다른 종(흰수마자, 쌍꼬리부전나비 등)과 동의어 처리가 필요한 종(섬개야광나무, 한라장구채)은 스크립트의 `OVERRIDE` 표에 적어 두었습니다.
- 대륙사슴은 국내 사슴 기록이 대부분 야생화한 꽃사슴이라 기록을 넣지 않았습니다.

## 시·군·구 경계

통계청 2018 시·군·구 경계([southkorea-maps](https://github.com/southkorea/southkorea-maps) 간소화본)를 GBIF가 기록에 붙이는 GADM 2단계 코드 229곳에 맞췄습니다. 일반구(수원시 장안구 등)는 시 하나로 합쳤고, 군위군은 현재처럼 대구광역시로 넣었습니다.

```bash
python tools/build_regions.py
```

## 실행과 자동 갱신

```bash
python -m http.server 5175
```

`실행.bat`을 더블클릭해도 됩니다. GitHub Actions(`.github/workflows/pages.yml`)가 매일 03:00(한국 시간)에 iNaturalist 자료를, 매주 월요일에 GBIF 자료를 새로 받아 배포합니다. 스냅샷 스크립트는 `shapely`가 필요합니다.

```bash
pip install shapely
```

```bash
python tools/inat_snapshot.py
```

```bash
python tools/gbif_snapshot.py
```

GBIF 기록이 3,000건 이하인 종은 기록을 모두 받아 세고(바다·해안 기록은 25km 이내의 가장 가까운 시·군·구로 배정), 그보다 많은 종은 GBIF 집계(facet) 기능으로 시·군·구별 건수를 바로 받습니다. 그래서 기록이 수만 건인 종도 몇 초면 끝납니다.

## 출처

- 대상 종: 국가법령정보센터 — 야생생물 보호 및 관리에 관한 법률 시행규칙 [별표 1]
- 시민 관찰: iNaturalist (각 관찰·사진의 저작권은 관찰자에게 있음)
- 기관·타 플랫폼 기록: GBIF.org
- 종 설명: 위키백과(CC BY-SA), iNaturalist를 통해 가져옴
- 배경지도: © OpenStreetMap contributors, 위성 영상 © Esri
- 행정구역 경계: 통계청 2018 시·군·구 경계(southkorea-maps 간소화본)
