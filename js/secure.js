// 관리자 전용 정밀 좌표: 비밀번호로 암호화된 파일을 브라우저 안에서 풂(tools/secure.py 와 같은 방식)
// PBKDF2-SHA256(파일에 적힌 횟수) → AES-256-GCM → gzip 풀기 → JSON. 비밀번호는 어디에도 저장하지 않음.
App.secure = (() => {
  const FILES = { gbif: "data/precise-gbif.enc.json", inat: "data/precise-inat.enc.json" };
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  const decryptBox = async (box, password) => {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: b64(box.salt), iterations: box.iter },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(box.iv) }, key, b64(box.data));
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  };

  // 성공하면 App.state.precise = { gbif, inat } 를 채우고 true, 비밀번호가 틀리면 false
  const unlock = async (password) => {
    if (!window.crypto || !crypto.subtle || !window.DecompressionStream) throw new Error("이 브라우저는 암호 풀기를 지원하지 않습니다.");
    const boxes = {};
    for (const [k, url] of Object.entries(FILES)) {
      const res = await fetch(url, { cache: "no-cache" });
      if (res.status === 404) { boxes[k] = null; continue; }
      if (!res.ok) throw new Error(`정밀 좌표 파일을 받지 못했습니다(HTTP ${res.status}).`);
      boxes[k] = await res.json();
    }
    if (!boxes.gbif && !boxes.inat) throw new Error("아직 정밀 좌표 파일이 없습니다. 비밀번호를 등록한 뒤 자동 갱신이 한 번 돌아야 생깁니다.");
    const out = {};
    try {
      for (const k of Object.keys(boxes)) out[k] = boxes[k] ? await decryptBox(boxes[k], password) : null;
    } catch (e) {
      if (e && e.name === "OperationError") return false;   // GCM 인증 실패 = 비밀번호 틀림
      throw e;
    }
    App.state.precise = out;
    return true;
  };

  const lock = () => { App.state.precise = null; };

  return { unlock, lock };
})();
