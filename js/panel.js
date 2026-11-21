// panel.js: the side panel (desktop) / bottom sheet (mobile) with team and player views.
// Owns: view rendering, view-to-view transitions, the sticky header + breadcrumb, tabs,
// per-view UI state (tab, scroll, filters) that main.js stores in history entries, and sheet drag.
import { M, map, state, actions } from './app.js?v=202611210429';
import { orgOf, pipelineLabel, seasonLabel, fold, ensurePlayerScores } from './model.js?v=202611210429';
import { ratingColor } from './map.js?v=202611210429';
import { $, esc, plural, logoHTML, leaguePill, avatarHTML, teamName, refLeague } from './util.js?v=202611210429';
import { openAbout } from './chrome.js?v=202611210429';

const selectTeam = (...a) => actions.selectTeam(...a);
const selectPlayer = (...a) => actions.selectPlayer(...a);
const clearSelection = (...a) => actions.clearSelection(...a);
const goBack = (...a) => actions.goBack(...a);

const sheetMQ = matchMedia('(max-width: 760px)');
const motionMQ = matchMedia('(prefers-reduced-motion: reduce)');
/** True when the panel is a bottom sheet (phone layout). */
export const isSheet = () => sheetMQ.matches;
const calm = () => motionMQ.matches;
const EASE = 'cubic-bezier(.2, .8, .2, 1)';
const EASE_IN = 'cubic-bezier(.4, 0, 1, 1)';

const TABS = ['over', 'roster', 'conn', 'reun'];
const SORTS = [['pos', 'Position'], ['score', 'Connection score'], ['num', 'Number'], ['name', 'Name'], ['age', 'Age'], ['travel', 'Most traveled']];
const POS_GROUP = { C: 'F', LW: 'F', RW: 'F', F: 'F', W: 'F', D: 'D', LD: 'D', RD: 'D', G: 'G' };
const POS_NAME = { C: 'Center', LW: 'Left wing', RW: 'Right wing', F: 'Forward', W: 'Wing', D: 'Defense', LD: 'Defense', RD: 'Defense', G: 'Goalie' };

const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${d}</svg>`;
const ICON = {
  back: svg('<path d="M14.5 5.5 8 12l6.5 6.5" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
  close: svg('<path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-4.2-4.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  chev: svg('<path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
  down: svg('<path d="m7 10 5 5 5-5" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
  play: svg('<path d="M8 5.5v13l10.5-6.5L8 5.5Z" fill="currentColor"/>'),
  share: svg('<path d="M12 3.5v11M7.5 8 12 3.5 16.5 8M5 12.5v6.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-6.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
  people: svg('<circle cx="9" cy="8.5" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.3c1.6.6 2.7 2.1 3 4.7" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>'),
  link: svg('<circle cx="6" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="6.5" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="17.5" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m8.4 10.8 7.2-3.4M8.4 13.2l7.2 3.4" stroke="currentColor" stroke-width="1.8"/>'),
  filter: svg('<path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
};

// What the panel shows, plus the per-view UI state that history entries remember.
const view = { kind: null, id: null, tab: 'over', scroll: {}, q: '', sort: 'pos', lg: 'ALL', all: false, allRooms: false };
const els = {};
let heroH = 0, stickY = Infinity, hl = null, viewHook = null, closeAnim = null, closeTimer = null;
let keyboardNav = false; // was the last interaction a key press (vs pointer)?

/** main.js registers a callback that runs when the view state changes (tab, filters, scroll end). */
export const onPanelView = (fn) => { viewHook = fn; };
const viewChanged = () => viewHook?.();
const curView = () => els.body?.querySelector(':scope > .view');
const headH = () => parseFloat(getComputedStyle(els.panel).getPropertyValue('--head-h')) || 56;

/** Snapshot of the current view's UI state (for history entries and the back stack). */
export function getView() {
  if (!view.kind) return null;
  const key = view.kind === 'team' ? view.tab : 'main';
  return { tab: view.tab, scroll: { ...view.scroll, [key]: Math.round(els.body.scrollTop) }, q: view.q, sort: view.sort, lg: view.lg, all: view.all };
}

function syncState() {
  state.tab = view.tab;
  state.showAllConn = view.all;
}

// ------------------------------------------------------------------ open / close

function openPanel(o) {
  const { panel, body } = els;
  const wasOpen = !panel.hidden && !panel.classList.contains('closing');
  cancelClose();
  setHl(null);
  // keep keyboard users in context: follow them into the new view
  const ae = document.activeElement;
  const takeFocus = panel.contains(ae) || (keyboardNav && (!ae || ae === document.body));
  const motion = wasOpen && !calm() && o.dir !== 'none';

  panel.querySelectorAll('.panel-ghost').forEach((g) => g.remove());
  const old = curView();
  if (old) { if (motion) ghost(old, o.dir); else old.remove(); }

  const v = document.createElement('div');
  v.className = 'view';
  v.style.setProperty('--team-c', o.color);
  v.innerHTML = o.html;
  body.appendChild(v);

  panel.style.setProperty('--team-c', o.color);
  panel.setAttribute('aria-label', o.label);
  if (!isSheet()) { panel.style.transform = ''; body.style.paddingBottom = ''; body.style.scrollPaddingBottom = ''; }
  panel.hidden = false;
  document.body.classList.add('panel-open');
  const tt = $('#tooltip');
  if (tt) tt.hidden = true;
  updateHeader(o);
  if (!wasOpen && isSheet()) sheetEnter(o.snap);
  measure();
  body.scrollTop = o.scroll || 0;
  onScroll();
  animateMeters(v, o.instant || calm());

  if (motion) {
    const dx = o.dir === 'back' ? -1 : o.dir === 'forward' ? 1 : 0;
    v.animate([{ opacity: 0, transform: `translateX(${dx * 22}px)` }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE });
  }
  if (takeFocus) v.querySelector('.hero-name')?.focus({ preventScroll: true });
  els.live.textContent = o.label;
}

// Keep the outgoing view on screen, frozen at its scroll position, while it fades out.
function ghost(old, dir) {
  const { panel, body } = els;
  const st = body.scrollTop;
  const tabs = old.querySelector('.tabs');
  const tabsTop = tabs ? tabs.getBoundingClientRect().top : 0;
  const g = document.createElement('div');
  g.className = 'panel-ghost';
  g.setAttribute('aria-hidden', 'true');
  g.inert = true;
  g.style.width = `${body.clientWidth}px`;
  old.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
  old.style.transform = `translateY(${-st}px)`;
  g.appendChild(old);
  body.after(g);
  if (tabs) {
    tabs.style.position = 'relative';
    tabs.style.top = '0px';
    tabs.style.top = `${tabsTop - tabs.getBoundingClientRect().top}px`;
  }
  const dx = dir === 'back' ? 1 : dir === 'forward' ? -1 : 0;
  g.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${dx * 18}px)` }], { duration: 190, easing: EASE_IN, fill: 'forwards' })
    .onfinish = () => g.remove();
}

export function closePanel() {
  const { panel } = els;
  setHl(null);
  document.body.classList.remove('panel-open');
  setSheetVar(0);
  if (panel.hidden || panel.classList.contains('closing')) return;
  view.kind = null;
  const done = () => {
    clearTimeout(closeTimer);
    closeTimer = null;
    panel.hidden = true;
    panel.classList.remove('closing');
    panel.style.transition = '';
    closeAnim?.cancel();
    closeAnim = null;
    panel.querySelectorAll('.panel-ghost').forEach((g) => g.remove());
    curView()?.remove();
    sheet.snap = null;
  };
  if (calm()) return done();
  panel.classList.add('closing');
  if (isSheet()) {
    panel.style.transition = `transform .26s ${EASE_IN}`;
    setY(panel.offsetHeight + 20);
    closeTimer = setTimeout(done, 270);
  } else {
    closeAnim = panel.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(20px)' }], { duration: 170, easing: EASE_IN, fill: 'forwards' });
    closeAnim.onfinish = done;
  }
}

function cancelClose() {
  const { panel } = els;
  if (!panel.classList.contains('closing')) return;
  clearTimeout(closeTimer);
  closeTimer = null;
  closeAnim?.cancel();
  closeAnim = null;
  panel.classList.remove('closing');
  panel.style.transition = '';
}

// ------------------------------------------------------------------ header (breadcrumb + compact title)

function updateHeader(o) {
  if (els.play) els.play.hidden = view.kind !== 'player';
  if (els.share) {
    const lbl = view.kind === 'player' ? 'Share this route' : 'Share this team';
    els.share.setAttribute('aria-label', lbl);
    els.share.title = lbl;
  }
  const prev = state.stack[state.stack.length - 1];
  let crumb = null;
  if (prev?.player != null && M.players[prev.player]) crumb = { short: M.players[prev.player].n, full: M.players[prev.player].n };
  else if (prev?.team != null && M.teams[prev.team]) crumb = { short: M.teams[prev.team].short, full: M.teams[prev.team].name };
  els.back.hidden = !crumb;
  if (crumb) {
    if (els.backLabel.textContent !== crumb.short && !calm()) els.backLabel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220 });
    els.backLabel.textContent = crumb.short;
    els.back.setAttribute('aria-label', `Back to ${crumb.full}`);
    els.back.title = `Back to ${crumb.full}`;
  }
  if (o?.title != null) els.title.innerHTML = o.title;
}

/** Re-read state.stack for the breadcrumb without re-rendering the view. */
export function refreshHeader() { if (!els.panel.hidden) updateHeader(); }

function measure() {
  const v = curView();
  if (!v) return;
  const hero = v.querySelector('.hero');
  heroH = hero ? hero.offsetHeight : 0;
  const tabs = v.querySelector('.tabs'), anchor = v.querySelector('.tabs-anchor'), tb = v.querySelector('.tab-body');
  if (tabs && anchor && tb) {
    const H = headH();
    stickY = anchor.getBoundingClientRect().top - els.body.getBoundingClientRect().top + els.body.scrollTop - H;
    const pb = parseFloat(getComputedStyle(els.body).paddingBottom) || 0;
    // tall enough that the tabs can always reach their sticky spot: switching tabs never jumps
    tb.style.minHeight = `${Math.max(0, els.body.clientHeight - pb - H - tabs.offsetHeight)}px`;
  } else stickY = Infinity;
}

function onScroll() {
  const y = els.body.scrollTop;
  els.panel.classList.toggle('compact', heroH > 0 && y > heroH - headH() - 10);
  els.panel.classList.toggle('stuck', y >= stickY - 1);
}

// ------------------------------------------------------------------ meters (gauge, bars)

function gauge(value, color, what = 'Connection rating') {
  const R = 46, C = 2 * Math.PI * R;
  return `<div class="gauge" role="img" aria-label="${what} ${value} out of 100"><svg viewBox="0 0 112 112" aria-hidden="true"><circle class="g-bg" cx="56" cy="56" r="${R}"/><circle class="g-fg" cx="56" cy="56" r="${R}" stroke="${color}" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-target="${C * (1 - value / 100)}"/></svg><div class="g-val" aria-hidden="true"><div><b data-count="${value}">${value}</b><span>of 100</span></div></div></div>`;
}

function animateMeters(v, instant) {
  const fg = v.querySelectorAll('.g-fg[data-target]');
  const bars = v.querySelectorAll('.bar i[data-w]');
  const apply = () => {
    fg.forEach((c) => { c.style.strokeDashoffset = c.dataset.target; });
    bars.forEach((b) => { b.style.width = b.dataset.w; });
  };
  if (instant) { v.classList.add('instant'); apply(); return; }
  v.querySelectorAll('[data-count]').forEach((n) => {
    const to = +n.dataset.count;
    n.textContent = '0';
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 950);
      n.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1 && n.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  requestAnimationFrame(() => requestAnimationFrame(apply));
}

// ------------------------------------------------------------------ team view

/**
 * Render a team. opts: { dir: 'forward'|'back'|'fade'|'none', view: saved getView() to restore,
 * tab: initial tab, snap: initial sheet snap ('peek'|'half'|'full') if the sheet was closed }.
 */
export function renderTeamPanel(t, o = {}) {
  ensurePlayerScores(M);
  const v = o.view || {};
  view.kind = 'team';
  view.id = t.i;
  view.tab = TABS.includes(v.tab) ? v.tab : TABS.includes(o.tab) ? o.tab : 'over';
  view.scroll = { ...(v.scroll || {}) };
  view.q = v.q || '';
  view.sort = SORTS.some(([k]) => k === v.sort) ? v.sort : view.sort || 'pos';
  view.lg = v.lg || 'ALL';
  view.all = !!v.all;
  syncState();
  openPanel({
    html: teamHTML(t), color: t.color, label: t.name, dir: o.dir, snap: o.snap, instant: !!o.view,
    scroll: view.scroll[view.tab] || 0,
    title: `${logoHTML(t, 'sm')}<span>${esc(t.name)}</span>`,
  });
}

function teamHTML(t) {
  const facts = [];
  if (t.arena) facts.push(`<span><b>${esc(t.arena)}</b></span>`);
  if (t.loc || t.city) facts.push(`<span>${esc(t.loc || t.city)}</span>`);
  if (t.rec) facts.push(`<span><b>${esc(t.rec)}</b> · ${t.pts} pts</span>`);
  const rc = ratingColor(t.rating);
  let h = `<header class="hero"><div class="hero-row"><div class="hero-logo">${t.logo ? `<img src="${esc(t.logo)}" alt="">` : `<b>${esc(t.abbr || t.short)}</b>`}</div>
    <div class="hero-text"><h2 class="hero-name" tabindex="-1">${esc(t.name)}</h2><div class="hero-sub">${leaguePill(t.lg)}${t.div ? `<span>${esc(t.div)}</span>` : ''}</div></div>
    <button class="score-pill" type="button" data-goto-tab="over" style="--c:${rc}" title="Connection rating: #${t.leagueRank} of ${t.leagueSize} in the ${esc(t.lg)}"><b>${t.rating}</b><span>rating</span></button></div>
    ${facts.length ? `<div class="facts">${facts.join('')}</div>` : ''}</header>`;
  const k = TABS.indexOf(view.tab);
  const tab = (id, label, n) => `<button class="tab" role="tab" id="tab-${id}" data-tab="${id}" aria-controls="tab-body" aria-selected="${view.tab === id}" tabindex="${view.tab === id ? 0 : -1}" type="button">${label}${n != null ? `<span class="tab-n">${n}</span>` : ''}</button>`;
  h += `<div class="tabs-anchor"></div><div class="tabs" role="tablist" aria-label="Team details" style="--i:${k}"><span class="tab-ind" aria-hidden="true"></span>
    ${tab('over', 'Overview')}${tab('roster', 'Roster', t.roster.length)}${tab('conn', 'Links', t.links.size)}${tab('reun', 'Reunions', t.reunions.length)}</div>
    <div class="tab-body" id="tab-body" role="tabpanel" aria-labelledby="tab-${view.tab}">${tabHTML(t)}</div>`;
  return h;
}

function overviewHTML(t) {
  const pl = pipelineLabel(t.lg);
  const comps = [
    ['reach', 'Reach', `${t.m.reach} teams`, 'Teams on the map linked to this roster through shared players (either direction).'],
    ['strength', 'Web strength', `${t.m.strength} links`, 'Total player links across all of those teams.'],
    ['reunions', 'Reunions', plural(t.m.reunions, 'pair'), 'Pairs of current teammates who played together somewhere else before.'],
    ['pipeline', pl.name, `${Math.round(t.m.pipeline * 100)}%`, `The ${pl.desc}.`],
  ];
  let h = `<section class="section first"><h3>Connection rating <button class="info" type="button" data-about>How it works</button></h3><div class="rating">${gauge(t.rating, ratingColor(t.rating))}
    <div class="rating-side"><div class="rating-rank"><b>#${t.leagueRank}</b> <span>of ${t.leagueSize} in the ${esc(t.lg)}</span></div>
    ${comps.map(([k, name, val, tip]) => `<div class="comp" title="${esc(tip)}"><div class="comp-top"><span>${name}</span><b>${val}</b></div><div class="bar"><i style="width:0;background:${ratingColor(t.pct[k] * 100)}" data-w="${Math.max(3, t.pct[k] * 100)}%"></i></div></div>`).join('')}
    <div class="comp-note">Bars rank each measure within the ${esc(t.lg)}</div>
    </div></div></section>`;

  // most-connected players on this roster
  const top = t.roster.map((i) => M.players[i]).filter((p) => p.score != null).sort((a, b) => b.score - a.score).slice(0, 3);
  if (top.length) {
    h += `<section class="section"><h3>Most connected players <button class="info" type="button" data-goto-tab="roster" data-sort="score">See all</button></h3>
      <div class="mates">${top.map((p) => `<button class="prow" data-player="${p.i}" type="button">${avatarHTML(p)}<span class="pmain"><span class="pname">${esc(p.n)}</span><span class="psub">${esc(`Played with ${p.sm.mates} active players · ${p.sm.teams} map teams`)}</span></span>${scoreChip(p)}</button>`).join('')}</div></section>`;
  }

  const org = orgOf(M, t);
  if (org.nhl.length + org.ahl.length + org.echl.length > 1) {
    const row = (label, list) => (list.length ? `<div class="org-row"><span class="org-label">${label}</span><div class="org-teams">${list.map((x) => `<button class="team-chip ${x.i === t.i ? 'self' : ''}" style="--team-c:${x.color}" ${x.i === t.i ? 'aria-current="true" disabled' : `data-team="${x.i}" data-hl="${x.i}"`} type="button">${logoHTML(x, 'sm')}<span>${esc(x.name)}</span></button>`).join('')}</div></div>` : '');
    h += `<section class="section"><h3>Organization</h3><div class="org">${row('NHL', org.nhl)}${row('AHL', org.ahl)}${row('ECHL', org.echl)}</div></section>`;
  } else if (['NHL', 'AHL', 'ECHL'].includes(t.lg)) {
    h += `<section class="section"><h3>Organization</h3><p class="note">No NHL/AHL affiliate listed for ${esc(M.season)}. An independent club.</p></section>`;
  }
  if (t.lg === 'NHL' && t.prospects.length) {
    const byTeam = d3.groups(t.prospects, (pi) => M.players[pi].t[0]).sort((a, b) => b[1].length - a[1].length);
    h += `<section class="section"><h3>Prospects in junior <span class="count">${t.prospects.length}</span></h3><p class="note">${esc(t.short)} draft picks now playing in the OHL, WHL, QMJHL or USHL.</p><div class="org-teams">${byTeam.slice(0, 14).map(([ti, ps]) => `<button class="team-chip" data-team="${ti}" data-hl="${ti}" type="button" title="${esc(ps.map((pi) => M.players[pi].n).join(', '))}">${logoHTML(M.teams[ti], 'sm')}<span>${esc(M.teams[ti].name)}</span><em>${ps.length}</em></button>`).join('')}</div></section>`;
  }
  return h;
}

function scoreChip(p) {
  if (p.score == null) return '';
  return `<span class="pscore" style="--c:${ratingColor(p.score)}" title="Connection score ${p.score}: #${p.leagueRank} of ${p.leagueSize} in the ${esc(p.lg)}">${p.score}</span>`;
}

export function tabHTML(t) {
  if (view.tab === 'over') return overviewHTML(t);
  if (view.tab === 'conn') return connHTML(t);
  if (view.tab === 'reun') return reunionsHTML(t);
  return rosterHTML(t);
}

/** Switch the team view's tab (keeps per-tab scroll). Used by tab clicks, arrow keys and actions.setTab. */
export function switchTab(tab) {
  if (!TABS.includes(tab) || view.kind !== 'team' || tab === view.tab) return;
  const v = curView(), tabs = v?.querySelector('.tabs'), tb = v?.querySelector('.tab-body');
  if (!tabs || !tb) return;
  const body = els.body, y = body.scrollTop;
  const from = TABS.indexOf(view.tab), to = TABS.indexOf(tab);
  view.scroll[view.tab] = Math.round(y);
  view.tab = tab;
  syncState();
  tabs.style.setProperty('--i', to);
  tabs.querySelectorAll('[role="tab"]').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  tb.setAttribute('aria-labelledby', `tab-${tab}`);
  tb.innerHTML = tabHTML(M.teams[view.id]);
  animateMeters(tb, true);
  // tabs pinned: bring the new tab to where it was left (or its top). Not pinned: stay put, unless the
  // tab bar sits low in the visible panel, then glide it up so the new tab's content is in view.
  const visible = isSheet() && sheet.snap ? geom().vis[sheet.snap] : body.clientHeight;
  if (y >= stickY - 1) body.scrollTop = Math.max(stickY, view.scroll[tab] ?? stickY);
  else if (stickY + headH() - y > visible * 0.6) body.scrollTo({ top: stickY, behavior: calm() ? 'auto' : 'smooth' });
  onScroll();
  if (!calm()) tb.animate([{ opacity: 0, transform: `translateX(${(to > from ? 1 : -1) * 14}px)` }, { opacity: 1, transform: 'none' }], { duration: 240, easing: EASE });
  viewChanged();
}

// ---- roster

function trailHTML(p, exclude) {
  const seen = [];
  for (let k = p.c.length - 1; k >= 0; k--) {
    const ref = p.c[k][1];
    if (ref >= 0 && ref !== exclude && !seen.includes(ref)) seen.push(ref);
  }
  if (!seen.length) return '';
  const shown = seen.slice(0, 4);
  return `<span class="trail" title="Past teams: ${esc(seen.map((i) => M.teams[i].name).join(' · '))}">${shown.map((i) => logoHTML(M.teams[i], 'sm')).join('')}${seen.length > 4 ? `<span class="more">+${seen.length - 4}</span>` : ''}</span>`;
}

function rosterHTML(t) {
  if (!t.roster.length) return empty(ICON.people, 'No roster listed yet.');
  return `<div class="tools">
    <label class="filter">${ICON.search}<input class="roster-q" type="search" value="${esc(view.q)}" placeholder="Filter ${t.roster.length} players" aria-label="Filter roster by name or number" autocomplete="off" spellcheck="false" enterkeyhint="search"></label>
    <label class="sort"><span class="sort-k">Sort</span><select class="roster-sort" aria-label="Sort roster">${SORTS.map(([k, l]) => `<option value="${k}"${view.sort === k ? ' selected' : ''}>${l}</option>`).join('')}</select>${ICON.down}</label>
  </div><div class="roster-list">${rosterList(t)}</div>`;
}

const lastFirst = (p) => { const w = p.n.split(' '); return `${w.slice(1).join(' ')} ${w[0]}`; };
const mapTeams = (p) => new Set([...p.nodes, ...p.t]).size;

function rosterList(t) {
  const all = t.roster.map((i) => M.players[i]);
  const raw = view.q.trim();
  const q = fold(raw).replace(/^#/, '');
  const ps = q ? all.filter((p) => fold(p.n).includes(q) || (p.no != null && String(p.no) === q)) : all;
  if (!ps.length) return empty(ICON.search, `No players match “${esc(raw)}”.`, '<button class="pchip" type="button" data-clear-q>Clear filter</button>');
  const base = (p) => [p.p, p.age ? `${p.age} yrs` : null, p.fr].filter(Boolean).join(' · ');
  const row = (p, sub) => `<button class="prow" data-player="${p.i}" type="button">${avatarHTML(p)}<span class="pmain"><span class="pname">${p.no != null ? `<span class="num">${p.no}</span>` : ''}${esc(p.n)}</span><span class="psub">${esc(sub)}</span></span>${trailHTML(p, t.i)}${scoreChip(p)}</button>`;
  let h = q ? `<div class="list-meta">${ps.length} of ${plural(all.length, 'player')}</div>` : '';
  if (view.sort === 'pos') {
    for (const [label, g] of [['Forwards', 'F'], ['Defense', 'D'], ['Goalies', 'G'], ['Other', undefined]]) {
      const gs = ps.filter((p) => POS_GROUP[p.p] === g);
      if (gs.length) h += `<div class="pos-head">${label}<span>${gs.length}</span></div>${gs.map((p) => row(p, base(p))).join('')}`;
    }
    return h;
  }
  const cmp = {
    num: (a, b) => (a.no ?? 1e9) - (b.no ?? 1e9),
    name: (a, b) => lastFirst(a).localeCompare(lastFirst(b)),
    age: (a, b) => (a.age ?? 1e9) - (b.age ?? 1e9) || (b.dob || '').localeCompare(a.dob || ''),
    travel: (a, b) => mapTeams(b) - mapTeams(a) || b.c.length - a.c.length,
    score: (a, b) => (b.score ?? -1) - (a.score ?? -1) || b.sm.mates - a.sm.mates,
  }[view.sort];
  const sub = view.sort === 'travel' ? (p) => [`${plural(mapTeams(p), 'team')} on the map`, p.p].filter(Boolean).join(' · ')
    : view.sort === 'score' ? (p) => [`Played with ${p.sm.mates} active players`, `${plural(p.sm.rooms, 'other team')}`].join(' · ') : base;
  return h + [...ps].sort(cmp).map((p) => row(p, sub(p))).join('');
}

function updateRoster() {
  const box = curView()?.querySelector('.roster-list');
  if (box) box.innerHTML = rosterList(M.teams[view.id]);
}

// ---- connections

const connEntries = (t) => [...t.links.entries()].sort((a, b) => b[1].n - a[1].n);

function connHTML(t) {
  const list = connEntries(t);
  if (!list.length) return empty(ICON.link, 'No shared players with other teams on the map yet.');
  const counts = d3.rollup(list, (v) => v.length, ([o]) => M.teams[o].lg);
  const lgs = M.leagues.filter((l) => counts.has(l.id));
  if (view.lg !== 'ALL' && !counts.has(view.lg)) view.lg = 'ALL';
  const chip = (id, label, n, color) => `<button class="lgc" type="button" data-conn-lg="${id}" aria-pressed="${view.lg === id}">${color ? `<i style="background:${color}"></i>` : ''}${label}<span>${n}</span></button>`;
  return `${lgs.length > 1 ? `<div class="lg-chips" role="group" aria-label="Filter connections by league">${chip('ALL', 'All', list.length)}${lgs.map((l) => chip(l.id, l.id, counts.get(l.id), l.color)).join('')}</div>` : ''}
    <p class="note tab-note">Teams linked to the ${esc(t.short)} by players who have played for both.</p>
    <div class="conn-list">${connList(t, list)}</div>`;
}

function connList(t, list = connEntries(t)) {
  const rows = view.lg === 'ALL' ? list : list.filter(([o]) => M.teams[o].lg === view.lg);
  const max = list[0][1].n;
  const shown = view.all ? rows : rows.slice(0, 40);
  let h = shown.map(([o, e]) => {
    const ot = M.teams[o];
    let came = 0, went = 0;
    for (const [, cur] of e.dir) (cur === t.i ? came++ : went++);
    const desc = [came ? `${came} came from there` : null, went ? `${went} went there` : null].filter(Boolean).join(' · ');
    const ps = [...e.players].map((pi) => M.players[pi]);
    const names = ps.slice(0, 4).map((p) => p.n.split(' ').slice(-1)[0]).join(', ') + (ps.length > 4 ? ` +${ps.length - 4}` : '');
    return `<button class="crow" data-team="${o}" data-hl="${o}" type="button" title="${esc(ps.map((p) => p.n).join(', '))}">${logoHTML(ot)}<span class="cmain"><span class="cname"><span class="cn">${esc(ot.name)}</span><span class="tag">${ot.lg}</span>${t.affs.has(o) ? '<span class="tag aff">Affiliate</span>' : ''}</span><span class="cdesc">${desc}</span><span class="cnames">${esc(names)}</span></span><span class="cside"><span class="cnum">${e.n}</span><span class="cbar"><i style="width:${Math.max(6, (e.n / max) * 100)}%;background:${ot.color}"></i></span></span></button>`;
  }).join('');
  if (rows.length > shown.length) h += `<button class="more-btn" data-more-conn type="button">Show all ${rows.length}</button>`;
  return h;
}

function updateConn() {
  const v = curView();
  const box = v?.querySelector('.conn-list');
  if (!box) return;
  box.innerHTML = connList(M.teams[view.id]);
  v.querySelectorAll('[data-conn-lg]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.connLg === view.lg)));
}

// ---- reunions

function reunionsHTML(t) {
  if (!t.reunions.length) return empty(ICON.people, 'No current teammates have played together elsewhere.');
  const span = (ys) => {
    ys = [...ys].sort((a, b) => a - b);
    // consecutive seasons collapse into ranges: 2021-22 – 2023-24, 2025-26
    const runs = [];
    for (const y of ys) { const r = runs[runs.length - 1]; if (r && y === r[1] + 1) r[1] = y; else runs.push([y, y]); }
    return runs.map(([a, b]) => (a === b ? seasonLabel(a) : `${seasonLabel(a)} – ${seasonLabel(b)}`)).join(', ');
  };
  const last = (n) => n.split(' ').slice(1).join(' ') || n;
  return `<p class="note tab-note">Current ${esc(t.short)} who were on the same team in the same season somewhere else.</p>` + t.reunions.slice(0, 50).map((r) => {
    const lg = refLeague(r.ref);
    const on = r.ref >= 0;
    const logo = on ? logoHTML(M.teams[r.ref]) : `<span class="off-logo">${esc(lg.slice(0, 4))}</span>`;
    const name = on ? `<button class="rh-link" type="button" data-team="${r.ref}" data-hl="${r.ref}">${esc(teamName(r.ref))}</button>` : `<span>${esc(teamName(r.ref))}</span>`;
    const pairs = [...r.pairSeasons.entries()].map(([pk, ys]) => ({ a: M.players[Math.floor(pk / 100000)], b: M.players[pk % 100000], ys }))
      .sort((x, y) => Math.max(...y.ys) - Math.max(...x.ys) || y.ys.length - x.ys.length);
    return `<div class="reunion"><div class="reunion-head">${logo}<span class="rh-name">${name}<span class="rh-sub">${esc(lg)} · ${plural(pairs.length, 'pair')}</span></span></div>
      <ul class="pair-list">${pairs.map((q) => `<li><span class="pr-names"><button class="pr-p" type="button" data-player="${q.a.i}">${esc(last(q.a.n))}</button><span class="pr-amp">&amp;</span><button class="pr-p" type="button" data-player="${q.b.i}">${esc(last(q.b.n))}</button></span><span class="pr-yrs">${span(q.ys)}</span></li>`).join('')}</ul></div>`;
  }).join('');
}

// ------------------------------------------------------------------ player view

/** Render a player. opts: { dir, view, snap } as for renderTeamPanel. */
export function renderPlayerPanel(p, o = {}) {
  ensurePlayerScores(M);
  view.kind = 'player';
  view.allRooms = false;
  view.id = p.i;
  view.scroll = { ...(o.view?.scroll || {}) };
  const t0 = M.teams[p.t[0]];
  openPanel({
    html: playerHTML(p), color: t0 ? t0.color : '#3987e5', label: p.n, dir: o.dir, snap: o.snap, instant: !!o.view,
    scroll: view.scroll.main || 0,
    title: `${avatarHTML(p)}<span>${esc(p.n)}</span>`,
  });
}

function playerHTML(p) {
  const cur = p.t.map((i) => M.teams[i]).filter(Boolean);
  const facts = [];
  if (p.age) facts.push(`<span><b>${p.age}</b> yrs${p.dob ? ` · ${esc(p.dob)}` : ''}</span>`);
  if (p.fr) facts.push(`<span>${esc(p.fr)}</span>`);
  if (p.ht || p.wt) facts.push(`<span>${[p.ht, p.wt ? `${p.wt} lb` : null].filter(Boolean).map(esc).join(' · ')}</span>`);
  if (p.sh) facts.push(`<span>${p.p === 'G' ? 'Catches' : 'Shoots'} <b>${esc(p.sh)}</b></span>`);
  if (p.dr) facts.push(`<span>Draft <b>${esc(p.dr)}</b></span>`);
  const ini = esc(p.n.split(' ').map((w) => w[0]).slice(0, 2).join(''));
  const sub = [p.no != null ? `#${p.no}` : null, POS_NAME[p.p] || p.p].filter(Boolean).join(' · ');

  let h = `<header class="hero"><div class="hero-row"><div class="hero-logo headshot">${p.img ? `<img src="${esc(p.img)}" alt="" onerror="this.remove()">` : ''}<b>${ini}</b></div>
    <div class="hero-text"><h2 class="hero-name" tabindex="-1">${esc(p.n)}</h2><div class="hero-sub">${esc(sub)}</div></div></div>
    ${cur.map((x) => `<button class="now-team" type="button" data-team="${x.i}" data-hl="${x.i}" style="--c:${x.color}">${logoHTML(x)}<span class="nt-text"><span class="nt-k">Plays for</span><span class="nt-name">${esc(x.name)}</span></span>${leaguePill(x.lg)}${ICON.chev}</button>`).join('')}
    ${facts.length ? `<div class="facts">${facts.join('')}</div>` : ''}</header>`;

  const seasons = new Set(p.c.map((c) => c[0]));
  const ys = [...seasons];
  h += scoreSectionHTML(p);
  h += roomsSectionHTML(p);

  const mates = matesOf(p);
  if (mates.length) {
    h += `<section class="section"><h3>Reunited with <span class="count">${mates.length}</span></h3><p class="note">Current teammates who already played with ${esc(p.n.split(' ')[0])} somewhere else.</p>
      <div class="mates">${mates.map((m) => `<button class="prow mate" data-player="${m.p.i}" type="button">${avatarHTML(m.p)}<span class="pmain"><span class="pname">${esc(m.p.n)}</span><span class="psub">${esc(m.where)}</span></span></button>`).join('')}</div></section>`;
  }

  const maxY = ys.length ? Math.max(...ys) : null;
  h += `<section class="section"><h3>Career <button class="mini-btn" type="button" data-replay>${ICON.play}Replay route</button></h3><div class="tl">${stints(p).map((r) => {
    const lg = refLeague(r.ref);
    const on = r.ref >= 0;
    const color = M.leagueById.get(lg)?.color || 'var(--faint)';
    const span = r.from === r.to ? seasonLabel(r.from) : `${seasonLabel(r.from)} – ${seasonLabel(r.to)}`;
    const sub = [span, lg, r.ys.size > 1 ? `${r.ys.size} seasons` : null].filter(Boolean).join(' · ');
    const now = on && r.to === maxY && p.t.includes(r.ref);
    const logo = on ? logoHTML(M.teams[r.ref]) : `<span class="off-logo">${esc(lg.slice(0, 4))}</span>`;
    const inner = `<span class="tl-dot"></span>${logo}<span class="tl-main"><span class="tl-team"><span class="tl-tn">${esc(teamName(r.ref, r.nm))}</span>${now ? '<span class="now-badge">Now</span>' : ''}</span><span class="tl-sub">${esc(sub)}${on && r.nm != null ? ` · now ${esc(M.teams[r.ref].name)}` : ''}</span></span>${r.gp ? `<span class="tl-gp">${r.gp}<small>GP</small></span>` : ''}`;
    return on ? `<button class="tl-row${now ? ' now' : ''}" type="button" data-team="${r.ref}" data-hl="${r.ref}" style="--dot:${color}">${inner}</button>` : `<div class="tl-row off" style="--dot:${color}">${inner}</div>`;
  }).join('')}</div>
  <p class="note tl-note">${p.id.startsWith('n') ? 'Full career from NHL.com.' : `Seasons since ${seasonLabel(M.firstSeason)}, matched across league rosters by name and birth date.`}</p></section>`;
  return h;
}

function scoreSectionHTML(p) {
  if (p.score == null) return '';
  const first = esc(p.n.split(' ')[0]);
  const comps = [
    ['mates', 'Teammates', `${p.sm.mates} players`, `Active players ${first} has shared a locker room with, before or elsewhere.`],
    ['rooms', 'Locker rooms', `${p.sm.rooms} teams`, `Other teams on the map that have at least one of ${first}'s former teammates right now.`],
    ['teams', 'Map teams', `${p.sm.teams}`, `Teams on the map ${first} has played for.`],
    ['leagues', 'Leagues', `${p.sm.leagues}`, `Leagues on the map ${first} has played in.`],
  ];
  return `<section class="section"><h3>Connection score <button class="info" type="button" data-about>How it works</button></h3><div class="rating">${gauge(p.score, ratingColor(p.score), 'Connection score')}
    <div class="rating-side"><div class="rating-rank"><b>#${p.leagueRank}</b> <span>of ${p.leagueSize.toLocaleString()} ${esc(p.lg)} players</span></div>
    ${comps.map(([k, name, val, tip]) => `<div class="comp" title="${esc(tip)}"><div class="comp-top"><span>${name}</span><b>${val}</b></div><div class="bar"><i style="width:0;background:${ratingColor(p.spct[k] * 100)}" data-w="${Math.max(3, p.spct[k] * 100)}%"></i></div></div>`).join('')}
    <div class="comp-note">Bars rank each measure among ${esc(p.lg)} players</div>
    </div></div></section>`;
}

// Teams that have one of p's former teammates on them right now.
function roomsSectionHTML(p) {
  if (!p.rooms || !p.rooms.size) return '';
  const list = [...p.rooms.entries()].sort((a, b) => b[1] - a[1] || M.teams[a[0]].baseR - M.teams[b[0]].baseR);
  const max = list[0][1];
  const shown = view.allRooms ? list : list.slice(0, 6);
  const rows = shown.map(([ti, n]) => {
    const t = M.teams[ti];
    const names = [];
    for (const qi of t.roster) if (p.mates.has(qi)) names.push(M.players[qi].n.split(' ').slice(-1)[0]);
    const label = names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4}` : '');
    return `<button class="crow" data-team="${ti}" data-hl="${ti}" type="button">${logoHTML(t)}<span class="cmain"><span class="cname"><span class="cn">${esc(t.name)}</span><span class="tag">${t.lg}</span></span><span class="cdesc">${plural(n, 'former teammate')}</span><span class="cnames">${esc(label)}</span></span><span class="cside"><span class="cnum">${n}</span><span class="cbar"><i style="width:${Math.max(6, (n / max) * 100)}%;background:${t.color}"></i></span></span></button>`;
  }).join('');
  const more = list.length > shown.length ? `<button class="more-btn" data-more-rooms type="button">Show all ${list.length}</button>` : '';
  return `<section class="section rooms"><h3>Former teammates around the map <span class="count">${list.length}</span></h3><p class="note">Teams with someone who has played alongside ${esc(p.n.split(' ')[0])}.</p><div class="conn-list">${rows}${more}</div></section>`;
}

// Share links: the native share sheet where there is one (phones), else copy the message + link.
function shareRoute(p, btn) {
  const stops = new Set([...p.nodes, ...p.t]).size;
  const now = M.teams[p.t[0]];
  share(btn, `#p=${encodeURIComponent(p.id)}`, `${p.n} · Hockey Atlas`,
    `${p.n}'s hockey journey: ${stops} ${stops === 1 ? 'team' : 'teams'} on the map${now ? `, now with the ${now.name}` : ''}. Connection score ${p.score ?? '–'}.`);
}
function shareTeam(t, btn) {
  share(btn, `#t=${encodeURIComponent(t.id)}`, `${t.name} · Hockey Atlas`,
    `The ${t.name}' player web: linked to ${t.m.reach} teams on the map. Connection rating ${t.rating} (#${t.leagueRank} in the ${t.lg}).`);
}
async function share(btn, hash, title, text) {
  const url = `${location.origin}${location.pathname}${hash}`;
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  let ok = false;
  try { await navigator.clipboard.writeText(`${text} ${url}`); ok = true; } catch {
    const ta = document.createElement('textarea');
    ta.value = `${text} ${url}`; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  btn.querySelector('.share-tip').textContent = ok ? 'Link copied' : 'Copy failed';
  btn.classList.add('done');
  els.live.textContent = ok ? 'Link copied' : 'Could not copy the link';
  clearTimeout(btn.__t);
  btn.__t = setTimeout(() => btn.classList.remove('done'), 1600);
}

// Consecutive seasons with the same team become one stint, even when a player shuttles between two clubs.
function stints(p) {
  const runs = [], open = new Map();
  p.c.forEach(([y, ref, gp, nm], k) => {
    const key = `${ref}|${nm ?? ''}`;
    let r = open.get(key);
    if (r && y - r.to <= 1) { r.to = y; r.ys.add(y); r.gp += gp || 0; r.last = k; return; }
    r = { ref, nm: nm ?? null, from: y, to: y, ys: new Set([y]), gp: gp || 0, last: k };
    open.set(key, r);
    runs.push(r);
  });
  const now = (r) => (r.ref >= 0 && p.t.includes(r.ref) ? 1 : 0);
  return runs.sort((a, b) => b.to - a.to || now(b) - now(a) || b.last - a.last);
}

// Current teammates who shared a team-season with p somewhere else, and where.
function matesOf(p) {
  const by = new Map();
  for (const ti of p.t) {
    for (const r of M.teams[ti]?.reunions || []) {
      if (!r.players.has(p.i)) continue;
      const mine = new Set(p.c.filter((c) => c[1] === r.ref).map((c) => c[0]));
      for (const qi of r.players) {
        if (qi === p.i) continue;
        const together = M.players[qi].c.filter((c) => c[1] === r.ref && mine.has(c[0])).map((c) => c[0]);
        if (!together.length) continue;
        let m = by.get(qi);
        if (!m) by.set(qi, (m = { p: M.players[qi], refs: new Map() }));
        const s = m.refs.get(r.ref) || new Set();
        together.forEach((y) => s.add(y));
        m.refs.set(r.ref, s);
      }
    }
  }
  return [...by.values()].map((m) => {
    const parts = [...m.refs.entries()].map(([ref, s]) => {
      const ys = [...s].sort();
      const span = ys.length > 1 ? `${seasonLabel(ys[0])} – ${seasonLabel(ys[ys.length - 1])}` : seasonLabel(ys[0]);
      return { name: teamName(ref), span, last: ys[ys.length - 1] };
    }).sort((a, b) => b.last - a.last);
    m.where = parts.length === 1 ? `Together at ${parts[0].name} · ${parts[0].span}` : `Together at ${parts.map((x) => x.name).join(', ')}`;
    m.last = parts[0].last;
    return m;
  }).sort((a, b) => b.last - a.last || a.p.n.localeCompare(b.p.n));
}

// ------------------------------------------------------------------ helpers

function empty(icon, text, action = '') {
  return `<div class="empty">${icon}<p>${text}</p>${action}</div>`;
}

function setHl(i) {
  if (i === hl) return;
  hl = i;
  map.highlightTeam?.(i);
}

// ------------------------------------------------------------------ bottom sheet (phone)

const SHEET_EXTRA = 60;       // panel extends this far below the screen so the spring overshoot never shows a gap
const sheet = { snap: null, y: 0 };

function geom() {
  const H = Math.max(0, els.panel.offsetHeight - SHEET_EXTRA);   // visible height when fully open
  const vh = window.innerHeight;
  const vis = { full: H, half: Math.min(H, Math.round(vh * 0.6)), peek: Math.min(H, Math.max(150, Math.round(vh * 0.3))) };
  return { H, vis };
}
const yFor = (snap, g = geom()) => g.H - g.vis[snap];
function setY(y) {
  sheet.y = y;
  els.panel.style.transform = `translate3d(0, ${Math.round(y)}px, 0)`;
}
function setSheetVar(px) { document.documentElement.style.setProperty('--sheet-h', `${Math.round(px)}px`); }

/** Height in px of the map covered by the panel at the bottom of the screen (0 on desktop). */
export function sheetInset() {
  if (!isSheet() || els.panel.hidden) return 0;
  const g = geom();
  return g.vis[sheet.snap === 'peek' ? 'peek' : 'half'];
}
/** Width in px of the map covered by the panel on the right (0 on phones). */
export function panelInsetRight() {
  if (isSheet()) return 0;
  const left = els.panel.offsetLeft; // layout position, unaffected by the slide-in animation
  return left ? Math.round(window.innerWidth - left + 16) : 450;
}

/** Move the sheet to a snap point: 'peek' | 'half' | 'full'. */
export function snapSheet(snap, { animate = true } = {}) {
  if (!isSheet() || els.panel.hidden) return;
  const g = geom();
  if (!g.vis[snap]) snap = 'half';
  sheet.snap = snap;
  els.panel.dataset.snap = snap;
  els.panel.classList.toggle('dragging', !animate);
  const y = yFor(snap, g);
  setY(y);
  els.body.style.paddingBottom = `calc(${y + SHEET_EXTRA + 24}px + var(--safe-b, 0px))`;
  els.body.style.scrollPaddingBottom = `${y + SHEET_EXTRA}px`;
  setSheetVar(g.vis[snap]);
  measure();
  onScroll();
  if (!animate) { els.panel.offsetHeight; els.panel.classList.remove('dragging'); }
}

function sheetEnter(snap) {
  const { panel } = els;
  panel.classList.add('dragging');
  setY(panel.offsetHeight + 20);
  panel.offsetHeight; // commit the off-screen start so the slide-up transitions
  panel.classList.remove('dragging');
  snapSheet(snap || 'half');
}

function wireSheet() {
  const { panel, body } = els;
  let d = null;
  panel.addEventListener('touchstart', (e) => {
    d = null;
    if (!isSheet() || panel.hidden || panel.classList.contains('closing') || e.touches.length !== 1) return;
    if (e.target.closest('input, select, textarea, .lg-chips')) return;
    const t = e.touches[0];
    const handle = !!e.target.closest('.panel-top, .panel-grab');
    d = { x0: t.clientX, y0: t.clientY, base: sheet.y, decided: handle, active: false, from: sheet.snap, pts: [[e.timeStamp, t.clientY]] };
  }, { passive: true });

  panel.addEventListener('touchmove', (e) => {
    if (!d) return;
    const t = e.touches[0];
    const dx = t.clientX - d.x0, dy = t.clientY - d.y0;
    if (!d.decided) {
      if (!dx && !dy) return;
      if (Math.abs(dx) > Math.abs(dy)) { d = null; return; }
      // content: pulling down at the top collapses; pushing up below "full" expands; otherwise it scrolls
      const want = (dy > 0 && body.scrollTop <= 0) || (dy < 0 && sheet.snap !== 'full');
      if (!want) { d = null; return; }
      d.decided = true;
    }
    if (e.cancelable) e.preventDefault();
    if (!d.active) {
      if (Math.abs(dy) < 6) return;
      d.active = true;
      d.y0 = t.clientY;
      panel.classList.add('dragging');
    }
    let y = d.base + (t.clientY - d.y0);
    if (y < 0) y = -Math.min(SHEET_EXTRA - 10, Math.pow(-y, 0.7));   // resist past fully open
    setY(y);
    d.pts.push([e.timeStamp, t.clientY]);
    if (d.pts.length > 5) d.pts.shift();
  }, { passive: false });

  const end = (e) => {
    const was = d;
    d = null;
    if (!was?.active) return;
    if (e.cancelable) e.preventDefault(); // no click after a drag
    panel.classList.remove('dragging');
    const [t0, y0] = was.pts[0], [t1, y1] = was.pts[was.pts.length - 1];
    const v = e.type === 'touchend' && t1 > t0 ? (y1 - y0) / (t1 - t0) : 0; // px/ms, + = down
    release(sheet.y, v, was.from);
  };
  panel.addEventListener('touchend', end);
  panel.addEventListener('touchcancel', end);

  // tap the handle / header background: step peek → half → full → half
  const tap = (e) => {
    if (!isSheet() || e.target.closest('button, a, .pt-title')) return;
    snapSheet(sheet.snap === 'peek' ? 'half' : sheet.snap === 'half' ? 'full' : 'half');
  };
  els.grab.addEventListener('click', tap);
  els.top.addEventListener('click', tap);
}

function release(y, v, from) {
  const g = geom();
  const order = ['full', 'half', 'peek'];
  const ys = Object.fromEntries(order.map((k) => [k, yFor(k, g)]));
  const proj = y + v * 220;
  if (proj > ys.peek + 70 && (from === 'peek' || y > ys.peek + 24)) { clearSelection(); return; }
  let best = from || 'half', bd = Infinity;
  for (const k of order) { const dd = Math.abs(proj - ys[k]); if (dd < bd) { bd = dd; best = k; } }
  if (Math.abs(v) > 0.45 && best === from) {   // a clear flick always moves at least one stop
    const next = order[order.indexOf(from) + (v > 0 ? 1 : -1)];
    if (next) best = next;
    else if (v > 0) { clearSelection(); return; }
  }
  snapSheet(best);
}

// ------------------------------------------------------------------ wiring

export function wirePanel() {
  const panel = $('#panel');
  const body = $('#panel-body');
  Object.assign(els, { panel, body });
  panel.removeAttribute('aria-live'); // announce the title through a small live region instead of the whole panel

  // header: breadcrumb, compact title, close. Reuse the page's buttons when present.
  const top = document.createElement('div');
  top.className = 'panel-top';
  const back = $('#panel-back') || Object.assign(document.createElement('button'), { id: 'panel-back', type: 'button' });
  back.className = 'panel-back';
  back.innerHTML = `${ICON.back}<span class="crumb-label"></span>`;
  back.hidden = true;
  const close = $('#panel-close') || Object.assign(document.createElement('button'), { id: 'panel-close', type: 'button' });
  close.className = 'panel-close';
  close.innerHTML = ICON.close;
  close.setAttribute('aria-label', 'Close panel');
  close.title = 'Close';
  const share = Object.assign(document.createElement('button'), { type: 'button', className: 'panel-share' });
  share.innerHTML = `${ICON.share}<span class="share-tip" aria-hidden="true"></span>`;
  share.addEventListener('click', () => {
    if (view.kind === 'player') shareRoute(M.players[view.id], share);
    else if (view.kind === 'team') shareTeam(M.teams[view.id], share);
  });
  const play = Object.assign(document.createElement('button'), { type: 'button', className: 'panel-share panel-play' });
  play.innerHTML = ICON.play;
  play.setAttribute('aria-label', 'Replay route');
  play.title = 'Replay route';
  play.addEventListener('click', () => {
    if (isSheet() && sheet.snap !== 'peek') snapSheet('peek'); // lower the sheet so the route is in view
    actions.replayRoute?.();
  });
  const title = document.createElement('div');
  title.className = 'pt-title';
  title.setAttribute('aria-hidden', 'true');
  title.title = 'Back to top';
  top.append(back, title, play, share, close);
  let grab = panel.querySelector('.panel-grab');
  if (!grab) { grab = document.createElement('div'); grab.className = 'panel-grab'; grab.setAttribute('aria-hidden', 'true'); }
  panel.insertBefore(grab, body);
  panel.insertBefore(top, body);
  const live = document.createElement('div');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');
  panel.append(live);
  Object.assign(els, { top, back, backLabel: back.querySelector('.crumb-label'), close, share, play, title, grab, live });

  close.addEventListener('click', () => clearSelection());
  back.addEventListener('click', () => goBack());
  title.addEventListener('click', () => body.scrollTo({ top: 0, behavior: calm() ? 'auto' : 'smooth' }));
  top.addEventListener('wheel', (e) => { if (!isSheet()) body.scrollBy({ top: e.deltaY }); }, { passive: true });

  body.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) { switchTab(tab.dataset.tab); return; }
    if (e.target.closest('[data-more-conn]')) { view.all = true; syncState(); updateConn(); viewChanged(); return; }
    if (e.target.closest('[data-more-rooms]')) {
      view.allRooms = true;
      const sec = curView()?.querySelector('.section.rooms');
      if (sec && view.kind === 'player') sec.outerHTML = roomsSectionHTML(M.players[view.id]);
      return;
    }
    const goto = e.target.closest('[data-goto-tab]');
    if (goto) {
      if (goto.dataset.sort) { view.sort = goto.dataset.sort; view.q = ''; }
      if (view.tab === goto.dataset.gotoTab) { if (goto.dataset.sort) updateRoster(); }
      else switchTab(goto.dataset.gotoTab);
      viewChanged();
      return;
    }
    const lg = e.target.closest('[data-conn-lg]');
    if (lg) { view.lg = lg.dataset.connLg; updateConn(); viewChanged(); return; }
    if (e.target.closest('[data-clear-q]')) {
      view.q = '';
      const inp = curView()?.querySelector('.roster-q');
      if (inp) { inp.value = ''; inp.focus(); }
      updateRoster();
      return;
    }
    if (e.target.closest('[data-about]')) { openAbout(); return; }
    if (e.target.closest('[data-replay]')) {
      if (isSheet() && sheet.snap !== 'peek') snapSheet('peek'); // lower the sheet so the route is in view
      actions.replayRoute?.();
      return;
    }
    const pl = e.target.closest('[data-player]');
    if (pl) { e.preventDefault(); selectPlayer(+pl.dataset.player); return; }
    const tm = e.target.closest('[data-team]');
    if (tm) { e.preventDefault(); selectTeam(+tm.dataset.team); }
  });
  body.addEventListener('input', (e) => {
    if (!e.target.matches('.roster-q')) return;
    view.q = e.target.value;
    updateRoster();
  });
  body.addEventListener('change', (e) => {
    if (e.target.matches('.roster-q')) viewChanged();
    if (!e.target.matches('.roster-sort')) return;
    view.sort = e.target.value;
    updateRoster();
    viewChanged();
  });
  body.addEventListener('keydown', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const list = [...tab.parentNode.querySelectorAll('[role="tab"]')];
      let k = list.indexOf(tab);
      k = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (k + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
      list[k].focus();
      switchTab(list[k].dataset.tab);
      return;
    }
    if (e.key === 'Escape' && e.target.matches('.roster-q')) {
      // first Escape clears the filter, the next leaves the field; neither closes the panel
      e.stopPropagation();
      if (e.target.value) { e.target.value = ''; view.q = ''; updateRoster(); } else e.target.blur();
    }
  });

  // hovering or focusing a team row/chip lights that team up on the map
  body.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = e.target.closest('[data-hl]');
    setHl(el ? +el.dataset.hl : null);
  });
  body.addEventListener('pointerleave', () => { if (!body.contains(document.activeElement)) setHl(null); else setHl(hlOf(document.activeElement)); });
  body.addEventListener('focusin', (e) => setHl(hlOf(e.target)));
  body.addEventListener('focusout', (e) => { if (!body.contains(e.relatedTarget)) setHl(null); });

  let raf = 0, idle = 0;
  body.addEventListener('scroll', () => {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; onScroll(); });
    clearTimeout(idle);
    idle = setTimeout(viewChanged, 400);
  }, { passive: true });

  wireSheet();
  const relayout = () => {
    if (panel.hidden) return;
    if (isSheet()) snapSheet(sheet.snap || 'half', { animate: false });
    else { panel.style.transform = ''; body.style.paddingBottom = ''; body.style.scrollPaddingBottom = ''; setSheetVar(0); }
    measure();
    onScroll();
  };
  sheetMQ.addEventListener('change', relayout);
  window.addEventListener('keydown', (e) => { if (!e.metaKey && !e.ctrlKey && !e.altKey) keyboardNav = true; }, true);
  window.addEventListener('pointerdown', () => { keyboardNav = false; }, true);
  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(relayout, 90); });
}

const hlOf = (el) => { const x = el?.closest?.('[data-hl]'); return x ? +x.dataset.hl : null; };
