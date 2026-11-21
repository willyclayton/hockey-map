// App chrome: top bar + search, league filters, map settings dock, zoom, coach mark, tooltips, hints,
// global shortcuts and the Rankings / About modals.
import { M, map, state, actions } from './app.js?v=202611210441';
import { fold, RATING_WEIGHTS, PLAYER_WEIGHTS, seasonLabel, ensurePlayerScores } from './model.js?v=202611210441';
import { ratingColor, RATING_RAMP } from './map.js?v=202611210441';
import { openTour, maybeTour } from './tour.js?v=202611210441';
import { $, esc, plural, logoHTML, leaguePill, avatarHTML, animateGauges } from './util.js?v=202611210441';

const selectTeam = (...a) => actions.selectTeam(...a);
const selectPlayer = (...a) => actions.selectPlayer(...a);
const clearSelection = (...a) => actions.clearSelection(...a);
const goBack = (...a) => actions.goBack(...a);

const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const mqMobile = matchMedia('(max-width: 760px)');
const mqTouch = matchMedia('(hover: none) and (pointer: coarse)');
const mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
const isMobileView = () => mqMobile.matches;
const panelOpen = () => document.body.classList.contains('panel-open');
const hasSelection = () => state.team != null || state.player != null;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// map.highlightTeam / flyTo are being added by the map module; always call optionally.
const highlight = (i) => map?.highlightTeam?.(i ?? null);

// localStorage is optional: private mode, blocked storage, etc. must all fall back silently.
const STORE = 'hockey-atlas:';
const store = {
  get(k, d) { try { const v = localStorage.getItem(STORE + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(STORE + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// Rating colors run from deep to pale blue; lift the dark end so numbers stay legible on glass.
const legible = (c) => { const h = d3.hsl(c); h.l = Math.max(h.l, 0.64); return h.formatHex(); };
const lgOrder = () => new Map(M.leagues.map((l, i) => [l.id, i]));

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5L8 5.5Z" fill="currentColor"/></svg>',
  reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v4.5l3 2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  arrow: '<svg class="arr" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.5v7M2 5.5l3 3 3-3" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  web: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="7" r="2.4" fill="currentColor"/><circle cx="18" cy="6" r="2.4" fill="currentColor"/><circle cx="12" cy="18" r="2.4" fill="currentColor"/><path d="M6 7q6 3 12-1M6 7q1 7 6 11M18 6q0 8-6 12" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
  route: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="18" r="2.4" fill="currentColor"/><circle cx="19" cy="6" r="2.4" fill="currentColor"/><path d="M5 18c0-6 4-4 7-7s2-5 7-5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-dasharray="3 2.5" stroke-linecap="round"/></svg>',
  gauge: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16a8 8 0 1 1 16 0" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><path d="m12 16 4-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="16" r="1.8" fill="currentColor"/></svg>',
};

// ================================================================== league filters + map settings
export function buildFilters() {
  const nav = $('#filters'), wrap = $('#league-filters');
  const counts = d3.rollup(M.teams, (v) => v.length, (t) => t.lg);
  wrap.innerHTML = `<button class="chip chip-all" type="button" data-all aria-label="Show all leagues" data-tip="Show every league">${ICON.reset}All</button>`
    + M.leagues.map((l) => `<button class="chip lg-chip" type="button" data-lg="${esc(l.id)}" aria-pressed="true" style="--lc:${l.color}" aria-label="${esc(l.id)}: ${esc(l.name)}, ${counts.get(l.id) || 0} teams"><span class="dot"></span><span class="lbl">${esc(l.id)}</span><span class="n">${counts.get(l.id) || 0}</span></button>`).join('');
  const chips = () => $$('.lg-chip', wrap);
  const onChips = () => chips().filter((c) => c.getAttribute('aria-pressed') === 'true');
  const vis = map.visibleLeagues;
  if (vis) chips().forEach((c) => c.setAttribute('aria-pressed', String(vis.has(c.dataset.lg))));

  const updateFade = () => {
    const max = nav.scrollWidth - nav.clientWidth;
    nav.classList.toggle('fade-l', nav.scrollLeft > 2);
    nav.classList.toggle('fade-r', max > 2 && nav.scrollLeft < max - 2);
  };
  const apply = () => {
    const set = new Set(onChips().map((c) => c.dataset.lg));
    nav.classList.toggle('filtered', set.size !== M.leagues.length);
    map.setVisibleLeagues(set);
    hideHint();
    requestAnimationFrame(updateFade);
  };
  const flash = (b) => { b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); };
  const solo = (b, wasSolo) => {
    chips().forEach((c) => c.setAttribute('aria-pressed', String(wasSolo || c === b)));
    flash(b);
    apply();
  };
  const showAll = () => { chips().forEach((c) => c.setAttribute('aria-pressed', 'true')); apply(); };

  let soloBefore = null;        // was the chip already solo before the first click of a double-click?
  let suppressUntil = 0;        // swallow the click that follows a long-press
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    if (performance.now() < suppressUntil) { suppressUntil = 0; return; }
    if (b.matches('[data-all]')) {
      const kb = e.detail === 0;
      showAll();
      if (kb) chips()[0]?.focus();
      return;
    }
    if (e.detail === 2) return; // second click of a double-click: the dblclick handler solos
    const on = onChips();
    const isSolo = on.length === 1 && on[0] === b;
    if (e.shiftKey || e.altKey) return solo(b, isSolo);
    soloBefore = { b, isSolo, t: performance.now() };
    b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    apply();
  });
  wrap.addEventListener('dblclick', (e) => {
    const b = e.target.closest('.lg-chip');
    if (!b) return;
    e.preventDefault();
    const was = soloBefore && soloBefore.b === b && performance.now() - soloBefore.t < 800 ? soloBefore.isSolo : false;
    solo(b, was);
  });

  // long-press (touch / pen) solos a league
  let lp = null;
  const cancelLp = () => { if (lp) { clearTimeout(lp.t); lp = null; } };
  wrap.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.lg-chip');
    if (!b || e.pointerType === 'mouse') return;
    const on = onChips();
    const isSolo = on.length === 1 && on[0] === b;
    lp = { x: e.clientX, y: e.clientY, t: setTimeout(() => { lp = null; suppressUntil = Infinity; navigator.vibrate?.(10); solo(b, isSolo); }, 480) };
  });
  wrap.addEventListener('pointermove', (e) => { if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 8) cancelLp(); });
  wrap.addEventListener('pointerup', () => { cancelLp(); if (suppressUntil === Infinity) suppressUntil = performance.now() + 450; });
  wrap.addEventListener('pointercancel', cancelLp);
  wrap.addEventListener('contextmenu', (e) => { if (e.target.closest('.lg-chip') && e.pointerType !== 'mouse' && mqTouch.matches) e.preventDefault(); });

  // horizontal row: fade masks + vertical wheel scrolls sideways
  nav.addEventListener('scroll', () => { cancelLp(); updateFade(); }, { passive: true });
  nav.addEventListener('wheel', (e) => {
    if (nav.scrollWidth <= nav.clientWidth + 1 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    nav.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
  if ('ResizeObserver' in window) new ResizeObserver(updateFade).observe(nav);
  window.addEventListener('resize', updateFade);
  nav.classList.toggle('filtered', onChips().length !== M.leagues.length);
  updateFade();

  // ---- map settings: layers, color mode, min shared
  $$('.chip.layer').forEach((b) => {
    if (map.layers && b.dataset.layer in map.layers) b.setAttribute('aria-pressed', String(!!map.layers[b.dataset.layer]));
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      map.setLayer(b.dataset.layer, on);
      buildLegend();
    });
  });
  const seg = $('#color-mode');
  seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.mode === (map.colorMode || 'league'))));
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.getAttribute('aria-pressed') === 'true') return;
    seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    map.setColorMode(b.dataset.mode);
    buildLegend();
  });
  const sl = $('#min-shared');
  if (map.minShared) sl.value = map.minShared;
  const syncSlider = () => {
    const f = (sl.value - sl.min) / (sl.max - sl.min || 1);
    sl.style.setProperty('--p', `calc(7px + (100% - 14px) * ${f.toFixed(3)})`);
    $('#min-shared-out').textContent = plural(+sl.value, 'player');
  };
  sl.addEventListener('input', () => { syncSlider(); map.setMinShared(+sl.value); updateCtlDot(); });
  syncSlider();
}

function updateCtlDot() {
  const dot = $('#ctl-sum');
  if (!dot || !map) return;
  const L = map.layers || {};
  const custom = L.aff === false || L.web === false || (map.colorMode && map.colorMode !== 'league') || map.minShared > 1;
  dot.classList.toggle('on', !!custom);
  const btn = $('#btn-controls');
  if (custom) btn?.setAttribute('aria-description', 'Custom settings active'); else btn?.removeAttribute('aria-description');
}

export function buildLegend() {
  const el = $('#legend');
  if (!el) return;
  const rating = map.colorMode === 'rating';
  const L = map.layers || { aff: true, web: true };
  const badge = (s, label) => `<span class="sz"><i style="width:${s}px;height:${s}px"></i>${label}</span>`;
  const webSw = '<svg width="24" height="12" viewBox="0 0 24 12" aria-hidden="true"><path d="M2 11Q12 -2 22 11" stroke="#7cc4ff" stroke-width="3" fill="none" stroke-linecap="round" opacity=".85"/><path d="M2 11Q12 5 22 11" stroke="#7cc4ff" stroke-width="1.1" fill="none" stroke-linecap="round" opacity=".55"/></svg>';
  let h = `<div class="lg-row"><span class="ctl-label">Badge size</span><span class="sizes">${badge(17, 'NHL')}${badge(13, 'AHL')}${badge(10, 'Other')}</span></div>`;
  if (rating) {
    h += `<div class="lg-row"><span class="ctl-label">Ring</span><span class="ramp-wrap"><span class="ramp" style="background:linear-gradient(90deg,${RATING_RAMP.join(',')})" role="img" aria-label="Connection rating from 0, least connected, to 100, most connected"></span><span class="ramp-labels"><span>0 · least</span><span>most · 100</span></span></span></div>`;
  } else {
    h += `<div class="lg-row"><span class="ctl-label">Ring</span><span class="rings">${M.leagues.map((l) => `<i style="--lc:${l.color}" title="${esc(l.id)}"></i>`).join('')}</span><small>league</small></div>`;
  }
  const affSw = '<svg width="24" height="10" viewBox="0 0 24 10" aria-hidden="true"><path d="M2 5h20" stroke="#e6eef9" stroke-width="1.8" stroke-linecap="round" opacity=".9"/></svg>';
  h += `<div class="lg-row"><span class="ctl-label">Lines</span><span class="lg-item ${L.aff === false ? 'off' : ''}"><span class="lg-k">${affSw}</span>Affiliates</span><span class="lg-item ${L.web === false ? 'off' : ''}"><span class="lg-k">${webSw}</span>Player web</span></div>
    <div class="lg-row lg-note"><span class="ctl-label"></span>Thicker = more shared players</div>`;
  el.innerHTML = h;
  updateCtlDot();
}

// ================================================================== tooltips (map hover callbacks)
let tipPt = null;
function placeTip(el, ev) {
  let pt = null;
  if (ev && ev.clientX != null) pt = { x: ev.clientX, y: ev.clientY };
  else if (ev?.target?.getBoundingClientRect) { const r = ev.target.getBoundingClientRect(); pt = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  pt = pt || tipPt;
  if (!pt) return;
  tipPt = pt;
  const m = 10, off = 16;
  const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  let right = vw - m;
  if (panelOpen() && !isMobileView()) {
    const p = $('#panel')?.getBoundingClientRect();
    if (p && p.width && pt.x < p.left) right = p.left - m;
  }
  let x = pt.x + off, y = pt.y + off;
  if (x + w > right) x = pt.x - w - off;
  if (y + h > vh - m) y = pt.y - h - off;
  x = clamp(x, m, Math.max(m, right - w));
  y = clamp(y, m, Math.max(m, vh - h - m));
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
}

export function teamTooltip(t, ev) {
  const tt = $('#tooltip');
  if (!t) { tt.hidden = true; return; }
  const key = `t${t.i}:${state.team}:${state.player}:${map.colorMode}`;
  if (tt.dataset.key !== key) {
    let rel = '';
    if (state.team != null && state.team !== t.i) {
      const sel = M.teams[state.team];
      const e = sel.links.get(t.i), aff = sel.affs.has(t.i);
      if (e || aff) rel = `<div class="tt-rel">${aff ? `<b>Affiliate</b> of ${esc(sel.short)}` : `Linked to ${esc(sel.short)}`}${e ? ` · ${plural(e.n, 'shared player')}` : ''}</div>`;
    }
    const isOpen = state.team === t.i && state.player == null;
    tt.innerHTML = `<div class="tt-head">${logoHTML(t)}<div class="tt-id"><div class="tt-name">${esc(t.name)}</div><div class="tt-sub">${leaguePill(t.lg)}<span>${esc(t.loc || t.city)}</span></div></div></div>
      <div class="tt-stats"><div class="tt-stat"><b style="color:${legible(ratingColor(t.rating))}">${t.rating}</b><span>Rating</span></div><div class="tt-stat"><b>${t.m.reach}</b><span>Teams linked</span></div><div class="tt-stat"><b>${t.roster.length}</b><span>Roster</span></div></div>
      ${rel}${isOpen ? '' : `<div class="tt-foot">${mqTouch.matches ? 'Tap' : 'Click'} for roster &amp; connections</div>`}`;
    tt.dataset.key = key;
  }
  tt.hidden = false;
  placeTip(tt, ev);
}

export function linkTooltip(d, ev) {
  const tt = $('#tooltip');
  if (!d) { tt.hidden = true; return; }
  const key = `l${d.from}-${d.to}`;
  if (tt.dataset.key !== key) {
    const a = M.teams[d.from], b = M.teams[d.to];
    const names = [...d.e.players].slice(0, 8).map((i) => M.players[i].n);
    const more = d.e.n - names.length;
    tt.innerHTML = `<div class="tt-head"><span class="tt-pair">${logoHTML(a)}${logoHTML(b)}</span><div class="tt-id"><div class="tt-name">${esc(a.short)} ↔ ${esc(b.short)}</div><div class="tt-sub">${plural(d.e.n, 'shared player')}${d.e.aff ? ' · affiliates' : ''}</div></div></div>
      <div class="tt-list">${names.map(esc).join(', ')}${more > 0 ? ` <span style="color:var(--muted)">+${more} more</span>` : ''}</div>
      <div class="tt-foot">Click the line to open ${esc(b.short)}</div>`;
    tt.dataset.key = key;
  }
  tt.hidden = false;
  placeTip(tt, ev);
}

// ================================================================== UI hints ([data-tip])
let hideHint = () => {};
function wireHints() {
  const hint = $('#hint');
  let cur = null, pending = null, timer = 0, warmUntil = 0;
  const content = (el) => {
    if (el.matches('.lg-chip')) {
      const L = M.leagueById.get(el.dataset.lg);
      const on = el.getAttribute('aria-pressed') === 'true';
      const n = M.teams.filter((t) => t.lg === L.id).length;
      const how = mqTouch.matches ? 'Long-press' : 'Double-click';
      return `${esc(L.name)}<span class="sub">${esc(L.tier)} · ${n} teams</span><span class="sub">${on ? 'Click to hide' : 'Click to show'} · ${how} to show only ${esc(L.id)}</span>`;
    }
    const k = el.dataset.tipKey;
    return `${esc(el.dataset.tip)}${k ? `<kbd>${esc(k)}</kbd>` : ''}${el.dataset.tipSub ? `<span class="sub">${esc(el.dataset.tipSub)}</span>` : ''}`;
  };
  const show = (el) => {
    if (!el.isConnected) return;
    cur = el; pending = null;
    hint.innerHTML = content(el);
    hint.hidden = false;
    const r = el.getBoundingClientRect();
    const w = hint.offsetWidth, h = hint.offsetHeight, m = 8;
    let x, y;
    if (el.closest('.zoom-ctl')) {
      x = r.left - w - 10; y = r.top + r.height / 2 - h / 2;
    } else {
      x = r.left + r.width / 2 - w / 2;
      const preferAbove = r.top > window.innerHeight / 2;
      y = preferAbove ? r.top - h - 8 : r.bottom + 8;
      if (y < m) y = r.bottom + 8;
      if (y + h > window.innerHeight - m) y = r.top - h - 8;
    }
    hint.style.left = `${Math.round(clamp(x, m, window.innerWidth - w - m))}px`;
    hint.style.top = `${Math.round(clamp(y, m, window.innerHeight - h - m))}px`;
  };
  hideHint = () => {
    clearTimeout(timer);
    if (cur) warmUntil = performance.now() + 450;
    cur = pending = null;
    hint.hidden = true;
  };
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest?.('[data-tip], .lg-chip');
    if (el === cur || el === pending) return;
    const warm = cur != null || performance.now() < warmUntil;
    hideHint();
    if (!el) return;
    pending = el;
    timer = setTimeout(() => show(el), warm ? 40 : 520);
  });
  document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) hideHint(); });
  document.addEventListener('pointerdown', () => hideHint(), true);
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest?.('[data-tip], .lg-chip');
    if (el && el.matches(':focus-visible')) { clearTimeout(timer); show(el); }
  });
  document.addEventListener('focusout', () => hideHint());
  document.addEventListener('scroll', () => hideHint(), true);
  window.addEventListener('blur', () => hideHint());
}

// ================================================================== search
const RECENT = 'recent';
const getRecent = () => { const r = store.get(RECENT, []); return Array.isArray(r) ? r : []; };
function pushRecent(k, id) {
  const r = getRecent().filter((x) => !(x && x.k === k && x.id === id));
  r.unshift({ k, id });
  store.set(RECENT, r.slice(0, 8));
}
function resolveRef(x) {
  if (!x) return null;
  if (x.k === 't' && M.teamById.has(x.id)) return { kind: 'team', i: M.teamById.get(x.id).i };
  if (x.k === 'p' && M.playerById.has(x.id)) return { kind: 'player', i: M.playerById.get(x.id).i };
  return null;
}
function suggestions() {
  const pNames = ['Connor McDavid', 'Sidney Crosby', 'Marie-Philip Poulin', 'Macklin Celebrini'];
  const tNames = ['Montréal Canadiens', 'London Knights', 'Minnesota Frost', 'Toronto Maple Leafs'];
  const ps = pNames.map((n) => M.players.find((p) => p.n === n)).filter(Boolean).slice(0, 3).map((p) => ({ kind: 'player', i: p.i }));
  const ts = tNames.map((n) => M.teams.find((t) => t.name === n)).filter(Boolean).slice(0, 3).map((t) => ({ kind: 'team', i: t.i }));
  const out = [];
  for (let k = 0; k < 3; k++) { if (ps[k]) out.push(ps[k]); if (ts[k]) out.push(ts[k]); }
  return out;
}

// wrap matched query tokens in <mark>, preferring matches at word starts
function hl(name, toks) {
  const f = fold(name);
  if (!toks.length || f.length !== name.length) return esc(name);
  const on = new Array(name.length).fill(false);
  for (const tk of toks) {
    let idx = -1;
    for (let i = f.indexOf(tk); i >= 0; i = f.indexOf(tk, i + 1)) {
      if (i === 0 || /[\s\-'.(/]/.test(f[i - 1])) { idx = i; break; }
      if (idx < 0) idx = i;
    }
    if (idx >= 0) for (let j = idx; j < idx + tk.length; j++) on[j] = true;
  }
  let out = '', open = false;
  for (let i = 0; i < name.length; i++) {
    if (on[i] && !open) { out += '<mark>'; open = true; }
    if (!on[i] && open) { out += '</mark>'; open = false; }
    out += esc(name[i]);
  }
  return out + (open ? '</mark>' : '');
}

function rowHTML(it, k, toks = []) {
  const base = `class="sr-item" id="sr-${k}" role="option" aria-selected="false" data-k="${k}" tabindex="-1"`;
  if (it.kind === 'team') {
    const t = M.teams[it.i];
    const open = state.team === t.i && state.player == null;
    const sub = [t.loc || t.city, t.arena].filter(Boolean).map(esc).join(' · ');
    return `<div ${base}>${logoHTML(t)}<span class="sr-main"><span class="sr-name">${hl(t.name, toks)}</span><span class="sr-sub">${sub}</span></span><span class="sr-side">${open ? '<span class="sr-tag">Open</span>' : ''}${leaguePill(t.lg)}<kbd class="sr-enter" aria-hidden="true">↵</kbd></span></div>`;
  }
  const p = M.players[it.i];
  const t = M.teams[p.t[0]];
  const sub = [p.p, p.no != null ? `#${p.no}` : null, t?.name].filter(Boolean).map(esc).join(' · ');
  return `<div ${base}>${avatarHTML(p)}<span class="sr-main"><span class="sr-name">${hl(p.n, toks)}</span><span class="sr-sub">${sub}</span></span><span class="sr-side">${t ? logoHTML(t, 'sm') : ''}${t ? leaguePill(t.lg) : ''}<kbd class="sr-enter" aria-hidden="true">↵</kbd></span></div>`;
}
function chipHTML(it, k) {
  const base = `class="sr-chip" id="sr-${k}" role="option" aria-selected="false" data-k="${k}" tabindex="-1"`;
  if (it.kind === 'team') { const t = M.teams[it.i]; return `<div ${base}>${logoHTML(t)}${esc(t.name)}</div>`; }
  const p = M.players[it.i];
  return `<div ${base}>${avatarHTML(p)}${esc(p.n)}</div>`;
}
const footHTML = '<div class="sr-foot" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>';

let focusSearch = () => {};
export function wireSearch() {
  const input = $('#search'), box = $('#search-results'), sbox = $('#search-box'), clearBtn = $('#search-clear');
  let items = [], active = -1;
  const order = lgOrder();

  const close = () => {
    box.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    if (active >= 0) highlight(null);
    active = -1;
  };
  const show = (h) => {
    box.innerHTML = h;
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    mark(false);
  };
  const syncValue = () => {
    sbox.classList.toggle('has-value', !!input.value);
    clearBtn.hidden = !input.value;
  };
  const mark = (scroll) => {
    for (const b of box.querySelectorAll('[data-k]')) {
      const on = +b.dataset.k === active;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
      if (on && scroll) b.scrollIntoView({ block: 'nearest' });
    }
    if (active >= 0) input.setAttribute('aria-activedescendant', `sr-${active}`);
    else input.removeAttribute('aria-activedescendant');
    const it = items[active];
    highlight(it ? (it.kind === 'team' ? it.i : M.players[it.i].t[0]) : null);
  };

  const renderIdle = () => {
    const rec = getRecent().map(resolveRef).filter(Boolean).slice(0, 5);
    const tries = suggestions();
    items = [...rec, ...tries];
    active = -1;
    let h = '';
    if (rec.length) h += `<div class="sr-head">Recent<button type="button" data-clear-recent>Clear</button></div>${rec.map((it, k) => rowHTML(it, k)).join('')}`;
    if (tries.length) h += `<div class="sr-head">Try</div><div class="sr-try">${tries.map((it, k) => chipHTML(it, rec.length + k)).join('')}</div>`;
    show(h + (isMobileView() ? '' : footHTML));
  };

  const render = () => {
    syncValue();
    const q = fold(input.value.trim());
    if (q.length < 2) {
      if (document.activeElement === input) renderIdle(); else close();
      return;
    }
    const toks = q.split(/\s+/).filter(Boolean);
    // exact name > whole-word / prefix match > word-start match > substring; ties go to the higher league
    const score = (key, name) => {
      if (fold(name) === q) return -1;
      const words = key.split(/[\s\-'.]+/);
      if (key.startsWith(q) || toks.every((tk) => words.includes(tk))) return 0;
      if (toks.every((tk) => words.some((w) => w.startsWith(tk)))) return 1;
      return 2;
    };
    const rank = (list, nameOf, lgOf) => list.filter((s) => toks.every((k) => s.key.includes(k)))
      .map((s) => ({ s, sc: score(s.key, nameOf(s.i)), lg: order.get(lgOf(s.i)) ?? 99 }))
      .sort((a, b) => a.sc - b.sc || a.lg - b.lg || nameOf(a.s.i).localeCompare(nameOf(b.s.i)))
      .map((x) => x.s);
    const teams = rank(M.searchTeams, (i) => M.teams[i].name, (i) => M.teams[i].lg).slice(0, 6);
    const players = rank(M.searchPlayers, (i) => M.players[i].n, (i) => M.players[i].lg).slice(0, 10);
    items = [...teams, ...players];
    active = items.length ? 0 : -1;
    let h = '';
    if (teams.length) h += `<div class="sr-head">Teams</div>${teams.map((s, k) => rowHTML(s, k, toks)).join('')}`;
    if (players.length) h += `<div class="sr-head">Players</div>${players.map((s, k) => rowHTML(s, teams.length + k, toks)).join('')}`;
    if (!h) h = `<div class="sr-empty">No teams or players match <b>“${esc(input.value.trim())}”</b>.<br>Try a last name, a city or a league.</div>`;
    else if (!isMobileView()) h += footHTML;
    show(h);
  };

  const pick = (k) => {
    const it = items[k];
    if (!it) return;
    close();
    input.value = '';
    syncValue();
    input.blur();
    if (it.kind === 'team') { pushRecent('t', M.teams[it.i].id); selectTeam(it.i); }
    else { pushRecent('p', M.players[it.i].id); selectPlayer(it.i); }
  };

  input.addEventListener('input', render);
  input.addEventListener('focus', () => {
    document.body.classList.add('searching');
    dismissCoach();
    hideHint();
    render();
  });
  input.addEventListener('blur', () => {
    document.body.classList.remove('searching');
    close();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (box.hidden) render();
      if (!items.length) return;
      const d = e.key === 'ArrowDown' ? 1 : -1;
      active = active < 0 ? (d > 0 ? 0 : items.length - 1) : (active + d + items.length) % items.length;
      mark(true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active < 0 && items.length && input.value.trim().length >= 2) active = 0;
      if (active >= 0) pick(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (input.value) { input.value = ''; render(); } else { close(); input.blur(); }
    }
  });
  // keep focus in the input while interacting with the list
  box.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (e.target.closest('[data-clear-recent]')) { store.set(RECENT, []); renderIdle(); return; }
    const b = e.target.closest('[data-k]');
    if (b && e.button === 0) pick(+b.dataset.k);
  });
  box.addEventListener('mousemove', (e) => {
    const b = e.target.closest('[data-k]');
    if (b && +b.dataset.k !== active) { active = +b.dataset.k; mark(false); }
  });
  clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
  clearBtn.addEventListener('click', () => { input.value = ''; input.focus(); render(); });

  focusSearch = () => { input.focus(); input.select(); };

  // keep the results list above the on-screen keyboard
  const vv = window.visualViewport;
  if (vv) {
    const f = () => document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    vv.addEventListener('resize', f);
    f();
  }
}

// ================================================================== settings dock (collapsible card / mobile sheet)
let ctlOpen = true;
function applyCtl(open) {
  ctlOpen = open;
  const c = $('#controls');
  c.classList.toggle('collapsed', !open);
  $('#btn-controls').setAttribute('aria-expanded', String(open));
  $('#ctl-body').inert = !open;
  const sheet = open && isMobileView();
  $('#scrim').hidden = !sheet;
  document.body.classList.toggle('ctl-sheet', sheet);
}
const ctlDefault = () => (isMobileView() || panelOpen() ? false : store.get('ctl-open', true) !== false);

function wireDock() {
  const dock = $('#dock');
  dock.style.transition = 'none';
  $('#controls').style.transition = 'none';
  $('.ctl-wrap').style.transition = 'none';
  applyCtl(ctlDefault());
  requestAnimationFrame(() => requestAnimationFrame(() => {
    dock.style.transition = ''; $('#controls').style.transition = ''; $('.ctl-wrap').style.transition = '';
  }));
  $('#btn-controls').addEventListener('click', () => {
    const open = !ctlOpen;
    applyCtl(open);
    if (!isMobileView() && !panelOpen()) store.set('ctl-open', open);
    hideHint();
  });
  $('#scrim').addEventListener('click', () => applyCtl(false));
  // mobile sheet: swipe down on the header to close
  let y0 = null;
  $('#btn-controls').addEventListener('touchstart', (e) => { y0 = ctlOpen && isMobileView() ? e.touches[0].clientY : null; }, { passive: true });
  $('#btn-controls').addEventListener('touchend', (e) => {
    if (y0 != null && e.changedTouches[0].clientY - y0 > 50) { e.preventDefault(); applyCtl(false); }
    y0 = null;
  });
  mqMobile.addEventListener?.('change', () => applyCtl(ctlDefault()));

  $('#zoom-in').addEventListener('click', () => map.zoomBy(1.6));
  $('#zoom-out').addEventListener('click', () => map.zoomBy(1 / 1.6));
  $('#zoom-reset').addEventListener('click', () => map.resetView());
}

// ================================================================== coach mark (first visit)
function wireCoach() {
  const el = $('#coach');
  if (store.get('coach-seen', false)) { el.hidden = true; return; }
  el.hidden = false;
  $('#coach-x').addEventListener('click', () => dismissCoach());
}
function dismissCoach() {
  const el = $('#coach');
  if (!el || el.hidden) return;
  store.set('coach-seen', true);
  if (mqReduce.matches) { el.hidden = true; return; }
  el.classList.add('out');
  setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, 260);
}

// ================================================================== panel + selection observers
function watchApp() {
  // panel open/close (body.panel-open, toggled by panel.js)
  let wasOpen = panelOpen();
  new MutationObserver(() => {
    const open = panelOpen();
    if (open === wasOpen) return;
    wasOpen = open;
    applyCtl(ctlDefault());
    hideHint();
    if (open) dismissCoach();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // every rendered selection (map click, search, panel links, deep link) feeds "Recent"
  let last = null, queued = false;
  const check = () => {
    queued = false;
    const key = state.player != null ? `p|${M.players[state.player]?.id}` : state.team != null ? `t|${M.teams[state.team]?.id}` : null;
    if (key && key !== last && !key.endsWith('|undefined')) { const [k, id] = key.split('|'); pushRecent(k, id); dismissCoach(); }
    last = key;
  };
  const panel = $('#panel');
  if (panel) new MutationObserver(() => { if (!queued) { queued = true; queueMicrotask(check); } }).observe(panel, { childList: true, subtree: true });
}

// ================================================================== keyboard
function wireKeys() {
  document.addEventListener('keydown', (e) => {
    const modalOpen = !$('#modal').hidden && !$('#modal').classList.contains('closing');
    const typing = e.target.matches?.('input[type="search"], input[type="text"], textarea, [contenteditable="true"]');
    if (e.key === 'Escape') {
      hideHint();
      if (modalOpen) { e.preventDefault(); closeModal(); return; }
      if (ctlOpen && isMobileView()) { applyCtl(false); return; }
      if (typing) { e.target.blur(); return; }
      if (hasSelection()) { e.preventDefault(); if (state.stack.length) goBack(); else clearSelection(); }
      return;
    }
    if (modalOpen) { if (e.key === 'Tab') trapFocus(e); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); focusSearch(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); focusSearch(); }
    else if (e.target.matches?.('input[type="range"]')) return;
    else if (e.key === '+' || e.key === '=') map.zoomBy(1.6);
    else if (e.key === '-' || e.key === '_') map.zoomBy(1 / 1.6);
    else if (e.key === '0') map.resetView();
  });
}

// ================================================================== modal
let modalReturn = null, closeTimer = 0;
function openModal(html, kind) {
  const modal = $('#modal'), card = $('.modal-card');
  const wasOpen = !modal.hidden && !modal.classList.contains('closing');
  if (!wasOpen && !card.contains(document.activeElement)) modalReturn = document.activeElement;
  clearTimeout(closeTimer);
  modal.classList.remove('closing');
  $('#modal-body').innerHTML = html;
  card.dataset.kind = kind;
  modal.hidden = false;
  hideHint();
  $('#tooltip').hidden = true;
  if (!wasOpen) requestAnimationFrame(() => card.focus({ preventScroll: true }));
}
function closeModal({ restore = true } = {}) {
  const modal = $('#modal');
  if (modal.hidden || modal.classList.contains('closing')) return;
  const done = () => { modal.hidden = true; modal.classList.remove('closing'); };
  if (mqReduce.matches) done();
  else { modal.classList.add('closing'); closeTimer = setTimeout(done, 200); }
  if (restore && modalReturn?.isConnected && modalReturn !== document.body) modalReturn.focus({ preventScroll: true });
  modalReturn = null;
}
function trapFocus(e) {
  const card = $('.modal-card');
  const f = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', card)
    .filter((el) => !el.disabled && el.getClientRects().length);
  if (!f.length) { e.preventDefault(); card.focus(); return; }
  const first = f[0], last = f[f.length - 1], a = document.activeElement;
  if (!card.contains(a)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && (a === first || a === card)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
}
function wireModal() {
  const modal = $('#modal');
  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.closest('[data-close]')) { closeModal(); return; }
    if (e.target.closest('[data-lb-more]')) { lb.limit += 150; renderLb(false); return; }
    const prow = e.target.closest('[data-player]');
    if (prow) { closeModal({ restore: false }); selectPlayer(+prow.dataset.player); return; }
    const row = e.target.closest('[data-team]');
    if (row) { closeModal({ restore: false }); selectTeam(+row.dataset.team); }
  });
  modal.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-team], tr[data-player]')) {
      e.preventDefault();
      closeModal({ restore: false });
      if (e.target.dataset.player != null) selectPlayer(+e.target.dataset.player);
      else selectTeam(+e.target.dataset.team);
    }
  });
  // focus can't wander behind the dialog
  document.addEventListener('focusin', (e) => {
    if (!modal.hidden && !modal.classList.contains('closing') && !modal.contains(e.target)) $('.modal-card').focus({ preventScroll: true });
  });
  // mobile sheet: swipe down from the top to dismiss
  let t0 = null;
  modal.addEventListener('touchstart', (e) => {
    const sc = e.target.closest('.m-scroll');
    t0 = (!sc || sc.scrollTop <= 0) ? e.touches[0].clientY : null;
  }, { passive: true });
  modal.addEventListener('touchend', (e) => {
    if (t0 != null && isMobileView() && e.changedTouches[0].clientY - t0 > 90) closeModal();
    t0 = null;
  });
}

// ------------------------------------------------------------------ rankings
const lb = { kind: 'teams', lg: 'ALL', sort: 'rating', dir: -1, limit: 150 };
const LB_COLS = {
  name: 'Team', lg: 'League', rating: 'Rating', reach: 'Reach', strength: 'Links', reunions: 'Reunions', pipeline: 'Pipeline',
};
const LBP_COLS = { pname: 'Player', lg: 'League', score: 'Score', mates: 'Teammates', stops: 'Stops', rooms: 'Rooms', teams: 'Teams' };
const LBP_TIPS = {
  score: 'Connection score, 0–100 among players in the same league',
  mates: 'Active players they have played with (before or elsewhere)',
  rooms: 'Other teams with one of their former teammates now',
  teams: 'Teams on the map they have played for',
  stops: 'Stops on their route across the map (a return to an old team counts again)',
};
const LB_TIPS = {
  rating: 'Connection rating, 0–100 within the league',
  reach: 'Teams on the map linked through shared players',
  strength: 'Total shared-player links',
  reunions: 'Pairs of current teammates who played together before',
  pipeline: 'Share of the roster that came through the pipeline',
};
const lbHead = () => {
  const cols = lb.kind === 'players' ? LBP_COLS : LB_COLS, tips = lb.kind === 'players' ? LBP_TIPS : LB_TIPS;
  const th = (k, cls = '') => `<th scope="col" class="${cls}" data-col="${k}"><button class="th-sort" type="button" data-sort="${k}"${tips[k] ? ` data-tip="${esc(tips[k])}"` : ''}>${cols[k]}${ICON.arrow}</button></th>`;
  const first = `<th scope="col" class="rank num"><span class="th-plain">#</span></th>`;
  return lb.kind === 'players'
    ? `<tr>${first}${th('pname')}${th('lg', 'hide-sm')}${th('score')}${th('mates', 'num c-mates')}${th('stops', 'num c-stops')}${th('rooms', 'num hide-sm')}${th('teams', 'num hide-sm')}</tr>`
    : `<tr>${first}${th('name')}${th('lg', 'hide-sm')}${th('rating')}${th('reach', 'num hide-sm')}${th('strength', 'num hide-sm')}${th('reunions', 'num')}${th('pipeline', 'num hide-sm')}</tr>`;
};

export function openLeaderboard() {
  ensurePlayerScores(M);
  const counts = d3.rollup(M.teams, (v) => v.length, (t) => t.lg);
  const tab = (id, label, n, color) => `<button class="lb-tab" role="tab" type="button" data-lb-lg="${esc(id)}" aria-selected="false" tabindex="-1" aria-label="${esc(label)}, ${n} teams">${color ? `<span class="dot" style="background:${color}"></span>` : ''}${esc(label)}</button>`;
  openModal(`<div class="m-head">
      <div class="m-eyebrow">Rankings</div>
      <div class="m-title-row"><h2 id="modal-title">Connection rankings</h2>
        <div class="seg lb-kind" role="group" aria-label="Rank"><button type="button" data-lb-kind="teams" aria-pressed="${lb.kind === 'teams'}">Teams</button><button type="button" data-lb-kind="players" aria-pressed="${lb.kind === 'players'}">Players</button></div></div>
      <p class="lead" id="lb-lead"></p>
      <div class="lb-tabs" role="tablist" aria-label="League">${tab('ALL', 'All leagues', M.teams.length)}${M.leagues.map((l) => tab(l.id, l.id, counts.get(l.id) || 0, l.color)).join('')}</div>
    </div>
    <div class="m-scroll" id="lb-scroll">
      <div class="lb-sub" id="lb-sub"></div>
      <table class="lb-table" aria-describedby="lb-sub"><thead id="lb-head">${lbHead()}</thead><tbody id="lb-body"></tbody></table>
      <div class="lb-more-wrap" id="lb-more"></div>
      <section class="lb-pairs"><h4 id="lb-pairs-title">Strongest non-affiliate links</h4><div class="pairs" id="lb-pairs"></div></section>
    </div>`, 'rankings');
  const body = $('#modal-body');
  body.querySelector('.lb-kind').addEventListener('click', (e) => {
    const b = e.target.closest('[data-lb-kind]');
    if (!b || b.dataset.lbKind === lb.kind) return;
    lb.kind = b.dataset.lbKind;
    lb.sort = lb.kind === 'players' ? 'score' : 'rating';
    lb.dir = -1;
    lb.limit = 150;
    body.querySelectorAll('[data-lb-kind]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('#lb-head').innerHTML = lbHead();
    $('#lb-scroll').scrollTop = 0;
    renderLb(true);
  });
  body.querySelector('.lb-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-lb-lg]');
    if (!b || b.dataset.lbLg === lb.lg) return;
    lb.lg = b.dataset.lbLg;
    lb.limit = 150;
    $('#lb-scroll').scrollTop = 0;
    renderLb(true);
  });
  body.querySelector('.lb-tabs').addEventListener('keydown', (e) => {
    const tabs = $$('.lb-tab', body);
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (j == null) return;
    e.preventDefault();
    const b = tabs[(j + tabs.length) % tabs.length];
    b.focus();
    b.click();
    b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  body.querySelector('thead').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    const k = b.dataset.sort;
    if (lb.sort === k) lb.dir *= -1;
    else { lb.sort = k; lb.dir = k === 'name' || k === 'pname' || k === 'lg' ? 1 : -1; }
    renderLb(false);
  });
  const tabsEl = body.querySelector('.lb-tabs');
  const tabFade = () => { const max = tabsEl.scrollWidth - tabsEl.clientWidth; tabsEl.classList.toggle('fade-r', max > 2 && tabsEl.scrollLeft < max - 2); };
  tabsEl.addEventListener('scroll', tabFade, { passive: true });
  renderLb(true);
  requestAnimationFrame(() => { body.querySelector('.lb-tab[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); tabFade(); });
}

function renderLb(animate) {
  const tbody = $('#lb-body');
  if (!tbody) return;
  const order = lgOrder();
  $$('.lb-tab').forEach((b) => { const on = b.dataset.lbLg === lb.lg; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
  $$('.lb-table th[data-col]').forEach((th) => {
    if (th.dataset.col === lb.sort) th.setAttribute('aria-sort', lb.dir < 0 ? 'descending' : 'ascending');
    else th.removeAttribute('aria-sort');
  });
  $('#lb-lead').textContent = lb.kind === 'players'
    ? 'Who has played with the most of today’s players, all over the map? Scores compare each player with the rest of their league, from 0 to 100.'
    : 'How tangled is each roster in the web of hockey? Ratings compare each team with the rest of its own league, from 0 to 100.';
  if (lb.kind === 'players') { renderLbPlayers(tbody, order, animate); return; }
  $('#lb-more').innerHTML = '';
  const val = (t) => ({ rating: t.rating, name: t.name, reach: t.m.reach, strength: t.m.strength, reunions: t.m.reunions, pipeline: t.m.pipeline, lg: order.get(t.lg) }[lb.sort]);
  const ts = M.teams.filter((t) => lb.lg === 'ALL' || t.lg === lb.lg).sort((a, b) => {
    const x = val(a), y = val(b);
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * lb.dir || b.rating - a.rating || b.m.strength - a.m.strength;
  });
  const cur = state.player == null ? state.team : null;
  tbody.innerHTML = ts.map((t, i) => {
    const w = `${Math.max(3, t.rating)}%`;
    return `<tr class="click${t.i === cur ? ' is-current' : ''}" data-team="${t.i}" tabindex="0" aria-label="${esc(t.name)}, rating ${t.rating}">
      <td class="rk num">${i + 1}</td>
      <td><span class="lb-team">${logoHTML(t)}<span class="nm-wrap"><span class="nm">${esc(t.name)}</span>${leaguePill(t.lg).replace('class="lg-pill"', 'class="lg-pill inline"')}</span></span></td>
      <td class="hide-sm">${leaguePill(t.lg)}</td>
      <td><span class="lb-rating"><b style="color:${legible(ratingColor(t.rating))}">${t.rating}</b><span class="bar"><i style="width:${animate ? 0 : w};background:${ratingColor(t.rating)}" data-w="${w}"></i></span></span></td>
      <td class="num hide-sm">${t.m.reach}</td><td class="num hide-sm">${t.m.strength}</td><td class="num">${t.m.reunions}</td><td class="num hide-sm">${Math.round(t.m.pipeline * 100)}%</td></tr>`;
  }).join('');
  const dirLabel = lb.sort === 'name' ? (lb.dir > 0 ? 'A–Z' : 'Z–A') : lb.dir < 0 ? 'highest first' : 'lowest first';
  $('#lb-sub').innerHTML = `<span>${ts.length} teams · ${esc(LB_COLS[lb.sort].toLowerCase())}, ${dirLabel}</span>${lb.lg === 'ALL' ? '<span>Ratings are relative to each league</span>' : ''}`;
  const pairs = M.pairs.filter((e) => !e.aff && (lb.lg === 'ALL' || M.teams[e.a].lg === lb.lg || M.teams[e.b].lg === lb.lg)).slice(0, 12);
  $('#lb-pairs').innerHTML = pairs.map((e) => `<button class="pair" data-team="${e.a}" type="button"><span class="logos">${logoHTML(M.teams[e.a], 'sm')}${logoHTML(M.teams[e.b], 'sm')}</span><span class="pn">${esc(M.teams[e.a].short)} ↔ ${esc(M.teams[e.b].short)}</span><span class="pc">${e.n}<small>shared</small></span></button>`).join('');
  $('#lb-pairs-title').parentElement.hidden = !pairs.length;
  if (animate) animateGauges();
}

function renderLbPlayers(tbody, order, animate) {
  tbody.closest('table').dataset.sort = lb.sort;
  const val = (p) => ({ score: p.score, pname: p.n, mates: p.sm.mates, stops: p.sm.stops, rooms: p.sm.rooms, teams: p.sm.teams, lg: order.get(p.lg) }[lb.sort]);
  const ps = M.players.filter((p) => p.score != null && (lb.lg === 'ALL' || p.lg === lb.lg)).sort((a, b) => {
    const x = val(a), y = val(b);
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * lb.dir || b.score - a.score || b.sm.mates - a.sm.mates;
  });
  const shown = ps.slice(0, lb.limit);
  const cur = state.player;
  tbody.innerHTML = shown.map((p, i) => {
    const t = M.teams[p.t[0]];
    const w = `${Math.max(3, p.score)}%`;
    return `<tr class="click${p.i === cur ? ' is-current' : ''}" data-player="${p.i}" tabindex="0" aria-label="${esc(p.n)}, score ${p.score}">
      <td class="rk num">${i + 1}</td>
      <td><span class="lb-team">${avatarHTML(p)}<span class="nm-wrap"><span class="nm">${esc(p.n)}</span><span class="lb-ptm">${t ? `${logoHTML(t, 'sm')}${esc(t.short)}` : ''}</span></span></span></td>
      <td class="hide-sm">${leaguePill(p.lg)}</td>
      <td><span class="lb-rating"><b style="color:${legible(ratingColor(p.score))}">${p.score}</b><span class="bar"><i style="width:${animate ? 0 : w};background:${ratingColor(p.score)}" data-w="${w}"></i></span></span></td>
      <td class="num c-mates">${p.sm.mates}</td><td class="num c-stops">${p.sm.stops}</td><td class="num hide-sm">${p.sm.rooms}</td><td class="num hide-sm">${p.sm.teams}</td></tr>`;
  }).join('');
  $('#lb-more').innerHTML = ps.length > shown.length ? `<button class="more-btn" type="button" data-lb-more>Show more · ${shown.length.toLocaleString()} of ${ps.length.toLocaleString()}</button>` : '';
  const dirLabel = lb.sort === 'pname' ? (lb.dir > 0 ? 'A–Z' : 'Z–A') : lb.dir < 0 ? 'highest first' : 'lowest first';
  $('#lb-sub').innerHTML = `<span>${ps.length.toLocaleString()} players · ${esc(LBP_COLS[lb.sort].toLowerCase())}, ${dirLabel}</span>${lb.lg === 'ALL' ? '<span>Scores are relative to each league</span>' : ''}`;
  $('#lb-pairs-title').parentElement.hidden = true;
  if (animate) animateGauges();
}

// ------------------------------------------------------------------ about
export function openAbout() {
  const w = RATING_WEIGHTS;
  const maxW = Math.max(...Object.values(w));
  const weight = (name, v, desc) => `<div class="weight"><div class="wk"><div class="wn">${name}<span>${Math.round(v * 100)}%</span></div><div class="bar"><i style="width:${(v / maxW) * 100}%"></i></div></div><p>${desc}</p></div>`;
  const how = mqTouch.matches ? 'Long-press' : 'Double-click';
  openModal(`<div class="m-scroll">
    <div class="m-head">
      <div class="m-eyebrow">About</div>
      <h2 id="modal-title">How the Hockey Atlas works</h2>
      <p class="lead">Every team in the NHL, AHL, ECHL, SPHL, OHL, WHL, QMJHL, USHL and PWHL sits on the map at its home arena. Click one to see its affiliates, its roster, and every team its players connect it to.</p>
    </div>
    <div class="about-grid">
      <section class="about-card"><div class="ab-ico">${ICON.web}</div><h5>The player web</h5><p>Two teams are linked when a player currently on one has played for the other. Thicker lines mean more shared players.</p></section>
      <section class="about-card"><div class="ab-ico">${ICON.route}</div><h5>Player journeys</h5><p>Click a player to trace their route across the map, stop by stop, in the order they played.</p></section>
      <section class="about-card"><div class="ab-ico">${ICON.gauge}</div><h5>Connection rating</h5><p>A 0–100 score ranked within each league, so a 90 means “more connected than almost every team in its league”. Players get one too.</p></section>
    </div>
    <button class="tour-open" type="button" data-tour>${ICON.play}<span>Watch the 15-second tour</span></button>
    <h4>What goes into the rating</h4>
    <div class="weights">
      ${weight('Reach', w.reach, 'How many teams on the map the roster is linked to.')}
      ${weight('Web strength', w.strength, 'The total number of those player links.')}
      ${weight('Reunions', w.reunions, 'Pairs of current teammates who already played together on another team, in the same season.')}
      ${weight('Pipeline', w.pipeline, 'For NHL/AHL/ECHL clubs, the share of the roster that came through the team’s affiliates. For junior clubs, the share that’s NHL-drafted or has pro experience. For SPHL/PWHL, the share that has played for another team on the map.')}
    </div>
    <h4>What goes into a player’s score</h4>
    <div class="weights">
      ${weight('Teammates', PLAYER_WEIGHTS.mates, 'How many of today’s players they have shared a locker room with, on any team, in any season (not counting this season’s current team).')}
      ${weight('Locker rooms', PLAYER_WEIGHTS.rooms, 'How many other teams on the map have one of their former teammates right now.')}
      ${weight('Map teams', PLAYER_WEIGHTS.teams, 'How many teams on the map they have played for.')}
      ${weight('Leagues', PLAYER_WEIGHTS.leagues, 'How many of the map’s leagues they have played in.')}
    </div>
    <p class="note">Each is ranked against players in the same league, so juniors aren’t compared with 12-year veterans.</p>
    <h4>Data</h4>
    <p>Rosters for ${esc(M.season)} plus every season back to ${seasonLabel(M.firstSeason)} come from NHL.com and the league stat feeds. NHL players carry their full career history. Everyone else is matched across leagues by name and birth date, so careers before ${seasonLabel(M.firstSeason)} or outside these leagues (college, Europe) only show up for NHL players. Arenas and affiliations come from Wikipedia. Last updated ${esc(M.generated.slice(0, 10))}.</p>
    <h4>Tips &amp; shortcuts</h4>
    <ul class="shortcuts">
      <li><span>Search any team or player</span><span class="keys"><kbd>/</kbd></span></li>
      <li><span>Move through results, open one</span><span class="keys"><kbd>↑</kbd><kbd>↓</kbd><kbd>↵</kbd></span></li>
      <li><span>Go back, close</span><span class="keys"><kbd>esc</kbd></span></li>
      <li><span>Zoom in, out, reset</span><span class="keys"><kbd>+</kbd><kbd>−</kbd><kbd>0</kbd></span></li>
      <li><span>Show only one league</span><span class="keys" style="color:var(--muted)">${how} a league</span></li>
      <li><span>Most connected at a glance</span><span class="keys" style="color:var(--muted)">Color by → Rating</span></li>
    </ul>
    <p class="note" style="margin-top:12px">Links are shareable: the URL updates with your selection.</p>
    <p class="fine">An unofficial fan project, not affiliated with any league or team. Team names and logos are trademarks of their respective owners.</p>
  </div>`, 'about');
}

// ================================================================== wiring
export function wireChrome() {
  wireHints();
  wireDock();
  wireCoach();
  wireModal();
  wireKeys();
  watchApp();
  $('#btn-leaderboard').addEventListener('click', openLeaderboard);
  $('#modal').addEventListener('click', (e) => { if (e.target.closest('[data-tour]')) { closeModal({ restore: false }); openTour(); } });
  maybeTour(() => $('#modal').hidden && !hasSelection());
  $('#btn-about').addEventListener('click', openAbout);
  $('#brand').addEventListener('click', (e) => {
    e.preventDefault();
    if (hasSelection()) clearSelection();
    map.resetView();
  });
}
