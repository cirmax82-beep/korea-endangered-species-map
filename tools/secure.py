"""정밀 좌표 자료 암호화(관리자 전용 내려받기).

비밀번호는 코드나 저장소에 두지 않고 환경 변수 DATA_PASSWORD로만 받습니다(GitHub Actions에서는 저장소 비밀값).
비밀번호가 없으면 암호화 파일을 만들지 않고 기존 파일을 그대로 둡니다.

방식: 비밀번호 → PBKDF2-SHA256(60만 회, 무작위 salt) → AES-256-GCM. 내용은 gzip으로 줄인 JSON.
앱(js/secure.js)이 브라우저에서 같은 방식으로 풉니다. 비밀번호가 틀리면 GCM 인증에 실패해 풀리지 않습니다.
"""
import base64
import gzip
import hashlib
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ITER = 600_000


def password():
    return os.environ.get("DATA_PASSWORD") or None


def _key(pw, salt, it):
    return hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, it, 32)


def write_encrypted(path, obj, pw):
    salt, iv = os.urandom(16), os.urandom(12)
    raw = gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 9)
    ct = AESGCM(_key(pw, salt, ITER)).encrypt(iv, raw, None)
    b64 = lambda b: base64.b64encode(b).decode("ascii")  # noqa: E731
    path.write_text(json.dumps({"v": 1, "kdf": "PBKDF2-SHA256", "iter": ITER, "cipher": "AES-256-GCM", "gzip": True,
                                "salt": b64(salt), "iv": b64(iv), "data": b64(ct)}), encoding="utf-8")


def read_encrypted(path, pw):
    box = json.loads(path.read_text(encoding="utf-8"))
    d = base64.b64decode
    raw = AESGCM(_key(pw, d(box["salt"]), box["iter"])).decrypt(d(box["iv"]), d(box["data"]), None)
    return json.loads(gzip.decompress(raw).decode("utf-8"))
