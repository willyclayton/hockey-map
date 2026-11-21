import { M } from './app.js?v=202611210326';

export const $ = (s, el = document) => el.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const plural = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;
export const isMobile = () => window.innerWidth < 760;

export function logoHTML(t, cls = '') {
  const inner = t.logo ? `<img src="${esc(t.logo)}" alt="" loading="lazy">` : `<b>${esc((t.abbr || t.short).slice(0, 4))}</b>`;
  return `<span class="mini-logo ${cls}" style="--c:${t.color}">${inner}</span>`;
}
export function leaguePill(lg) {
  const L = M.leagueById.get(lg);
  return `<span class="lg-pill"><i style="background:${L.color}"></i>${esc(L.id)}</span>`;
}
export function avatarHTML(p) {
  const ini = p.n.split(' ').map((w) => w[0]).slice(0, 2).join('');
  return p.img ? `<span class="avatar"><img src="${esc(p.img)}" alt="" loading="lazy" onerror="this.parentNode.textContent='${esc(ini)}'"></span>` : `<span class="avatar">${esc(ini)}</span>`;
}
export function teamName(ref, override) {
  if (override != null) return M.strings[override];
  return ref >= 0 ? M.teams[ref].name : M.off[-ref - 1].name;
}
export function refLeague(ref) { return ref >= 0 ? M.teams[ref].lg : M.off[-ref - 1].lg; }
export function placeTooltip(el, ev) {
  const pad = 14;
  const r = el.getBoundingClientRect();
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
  el.style.left = `${Math.max(8, x)}px`;
  el.style.top = `${Math.max(8, y)}px`;
}
export function animateGauges() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelectorAll('.g-fg[data-target]').forEach((c) => { c.style.strokeDashoffset = c.dataset.target; });
    document.querySelectorAll('.bar i[data-w]').forEach((b) => { b.style.width = b.dataset.w; });
  }));
}
