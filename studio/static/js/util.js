// Small DOM and formatting helpers shared by the views.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function fmtTime(t, precise = true) {
  if (!isFinite(t)) t = 0;
  const sign = t < 0 ? "-" : "";
  t = Math.abs(t);
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  const ss = precise ? s.toFixed(2).padStart(5, "0") : String(Math.floor(s)).padStart(2, "0");
  return sign + (h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`);
}

export function fmtBytes(n) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function fmtAgo(ts) {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

// Deterministic pleasant gradient for avatars.
export function hueOf(str) {
  let x = 0;
  for (const c of str) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x % 360;
}
export function avatarStyle(name) {
  const a = hueOf(name);
  return `background: linear-gradient(135deg, hsl(${a} 70% 55%), hsl(${(a + 50) % 360} 75% 45%))`;
}

export function toast(msg, kind = "") {
  const el = h("div", { class: `toast ${kind}` }, msg);
  $("#toasts").append(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; }, kind === "err" ? 6000 : 3200);
  setTimeout(() => el.remove(), kind === "err" ? 6400 : 3600);
}

// ---------------------------------------------------------------- context menu
const ctx = () => $("#ctxMenu");

export function openMenu(x, y, head, items) {
  const menu = ctx();
  menu.innerHTML = "";
  if (head) menu.append(h("div", { class: "ctx-head" }, head));
  for (const it of items) {
    if (it === "-") { menu.append(h("hr")); continue; }
    if (it.hidden) continue;
    const b = h("button", { class: it.cls || "", disabled: it.disabled, role: "menuitem" });
    b.innerHTML = `${it.icon || ""}<span>${esc(it.label)}</span>${it.key ? `<span class="k">${esc(it.key)}</span>` : ""}`;
    b.addEventListener("click", () => { closeMenu(); it.run(); });
    menu.append(b);
  }
  menu.classList.remove("hidden");
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
}
export function closeMenu() { ctx().classList.add("hidden"); }
document.addEventListener("mousedown", e => { if (!ctx().contains(e.target)) closeMenu(); });
window.addEventListener("blur", closeMenu);

// ---------------------------------------------------------------- modal
let modalClose = null;
export function openModal(node, onClose) {
  const back = $("#modalBack"), modal = $("#modal");
  modal.innerHTML = "";
  modal.append(node);
  back.classList.remove("hidden");
  modalClose = onClose || null;
  setTimeout(() => modal.querySelector("[autofocus]")?.focus(), 30);
}
export function closeModal() {
  $("#modalBack").classList.add("hidden");
  $("#modal").innerHTML = "";
  const fn = modalClose;
  modalClose = null;
  fn?.();
}
export const modalOpen = () => !$("#modalBack").classList.contains("hidden");
$("#modalBack").addEventListener("mousedown", e => { if (e.target.id === "modalBack") closeModal(); });

export const icons = {
  sparkle: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  dna: '<svg viewBox="0 0 24 24"><path d="M7 3c0 6 10 6 10 12s-10 6-10 6M17 3c0 6-10 6-10 12M8 7h8M8 17h8"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  zoom: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M11 8v6M8 11h6"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  unlock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  ear: '<svg viewBox="0 0 24 24"><path d="M6 9a6 6 0 1 1 12 0c0 4-4 5-4 9a3 3 0 0 1-6 0M10 9a2 2 0 1 1 4 0"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>',
  film: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
  wave: '<svg viewBox="0 0 24 24"><path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 10v4"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4zM17 9l4 6M21 9l-4 6"/></svg>',
  speaker: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4zM16 9a4 4 0 0 1 0 6"/></svg>',
};
