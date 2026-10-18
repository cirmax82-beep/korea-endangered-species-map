// 공용 도우미
window.App = window.App || {};

App.util = (() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));

  const fmt = (n) => (Number(n) || 0).toLocaleString("ko-KR");

  const uid = () => {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (_) { /* 비보안 컨텍스트 */ }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  };

  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const debounce = (fn, ms = 200) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  const download = (filename, content, type = "text/plain") => {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  };

  // 엑셀에서 한글이 깨지지 않도록 BOM 포함
  const toCSV = (rows) => {
    const cell = (v) => {
      const s = String(v ?? "");
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
  };

  let toastTimer;
  const toast = (msg, ms = 2600) => {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  };

  // 0~1 값을 연두→진녹색 단계 색으로
  const SEQ = ["#f1f8ec", "#d3ebc4", "#a9d78f", "#74bd62", "#43a047", "#2b8a3e", "#1b5e2b"];
  const seqColor = (t) => {
    if (!(t > 0)) return null;
    const i = Math.min(SEQ.length - 1, Math.floor(t * (SEQ.length - 1) + 0.5));
    return SEQ[Math.max(1, i)];
  };

  return { $, $$, esc, fmt, uid, today, debounce, download, toCSV, toast, SEQ, seqColor };
})();
