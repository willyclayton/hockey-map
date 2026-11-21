import { buildModel, ensurePlayerScores } from './model.js?v=202611210334';
import { HockeyMap } from './map.js?v=202611210334';
import { M, map, state, actions, setModel, setMap } from './app.js?v=202611210334';
import { $ } from './util.js?v=202611210334';
import { renderTeamPanel, renderPlayerPanel, closePanel, wirePanel, getView, onPanelView, refreshHeader, switchTab, sheetInset, panelInsetRight, isSheet } from './panel.js?v=202611210334';
import { buildFilters, buildLegend, teamTooltip, linkTooltip, wireSearch, wireChrome } from './chrome.js?v=202611210334';

Object.assign(actions, { selectTeam, selectPlayer, clearSelection, goBack, setTab, replayRoute });

init().catch((e) => {
  console.error(e);
  $('#loading p').textContent = 'Could not load the data. Try refreshing.';
});

async function init() {
  const [data, topo] = await Promise.all([
    fetch('data/hockey.json').then((r) => r.json()),
    fetch('data/na.topo.json').then((r) => r.json()),
  ]);
  setModel(buildModel(data));
  setMap(new HockeyMap($('#map'), M, topo, {
    onTeam: (i) => selectTeam(i, { from: 'map' }),
    onBackground: () => { if (hasSel()) clearSelection(); },
    onHover: teamTooltip,
    onLinkHover: linkTooltip,
  }));
  buildFilters();
  buildLegend();
  wireSearch();
  wirePanel();
  wireChrome();
  $('#tagline').textContent = `${M.teams.length} teams · ${M.players.length.toLocaleString()} players · ${M.season}`;
  baseTitle = document.title;
  try { history.scrollRestoration = 'manual'; } catch { /* not supported */ }
  routeInitial();
  window.addEventListener('popstate', onPopState);
  onPanelView(saveViewSoon);
  requestAnimationFrame(() => $('#loading').classList.add('done'));
  setTimeout(() => $('#loading')?.remove(), 700);
  // Player connection scores take ~100ms; compute them once the map is on screen (panels call
  // ensurePlayerScores too, so an early click still gets them).
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 300));
  idle(() => ensurePlayerScores(M), { timeout: 2000 });
}

// ------------------------------------------------------------------ navigation model
//
// Every selection is one browser history entry (#t=<team id> or #p=<player id>; no selection is the
// bare URL), so Back/Forward walk through selections. Each entry carries the in-app back stack and
// the view's UI state (tab, per-tab scroll, roster filter/sort, league filter), so returning to an
// entry restores it exactly. Entries store ids, never array indices, so they survive data refreshes.
// state.stack mirrors the entries behind the current one; the panel's breadcrumb names its top.

const STACK_MAX = 40;
let baseTitle = 'Hockey Atlas';
let seq = 0; // position of the current entry, to tell Back from Forward on popstate

const hasSel = () => state.team != null || state.player != null;
const cur = () => (hasSel() ? { team: state.team, player: state.player } : null);
const sameSel = (a, b) => (a?.team ?? null) === (b?.team ?? null) && (a?.player ?? null) === (b?.player ?? null);
const toIds = (s) => (s.player != null ? { p: M.players[s.player].id, view: s.view || null } : { t: M.teams[s.team].id, view: s.view || null });
function fromIds(s) {
  const p = s?.p != null ? M.playerById.get(s.p) : null;
  if (p) return { team: null, player: p.i, view: s.view || null };
  const t = s?.t != null ? M.teamById.get(s.t) : null;
  return t ? { team: t.i, player: null, view: s.view || null } : null;
}
function parseHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  return fromIds({ t: h.get('t'), p: h.get('p') });
}
function urlFor() {
  if (state.player != null) return `#p=${M.players[state.player].id}`;
  if (state.team != null) return `#t=${M.teams[state.team].id}`;
  return location.pathname + location.search;
}
function titleFor() {
  const name = state.player != null ? M.players[state.player].n : state.team != null ? M.teams[state.team].name : null;
  return name ? `${name} · ${baseTitle}` : baseTitle;
}
function entry(fromBare) {
  const sel = cur();
  return { ha: 1, seq, fromBare: !!fromBare, ...(sel ? toIds({ ...sel, view: getView() }) : {}), stack: state.stack.map(toIds) };
}
function commit(mode, fromBare) {
  document.title = titleFor();
  try {
    if (mode === 'push') { seq += 1; history.pushState(entry(fromBare), '', urlFor()); }
    else history.replaceState(entry(fromBare ?? history.state?.fromBare), '', urlFor());
  } catch { /* Safari rate-limits history calls; the URL just won't update */ }
}
// Write the live view state (tab, scroll, filters) into the current entry.
function saveView() {
  clearTimeout(saveTimer);
  if (!hasSel() || !history.state?.ha) return;
  try { history.replaceState({ ...history.state, ...toIds({ ...cur(), view: getView() }) }, ''); } catch { /* rate-limited */ }
}
let saveTimer = 0;
function saveViewSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveView, 250); }
function pushStack() {
  saveView();
  const prev = cur();
  if (prev) state.stack = [...state.stack, { ...prev, view: getView() }].slice(-STACK_MAX);
  return prev;
}

// ------------------------------------------------------------------ actions

/**
 * Select a team. opts:
 *   from: 'map' | 'ui'   map clicks keep the camera (it only pans if the team would sit under the sheet)
 *   push: true           false replaces the current history entry instead of adding one
 *   tab:  'roster' | 'conn' | 'reun'   tab to open on
 *   snap: 'peek' | 'half' | 'full'     phone sheet height if the sheet was closed
 * Re-selecting the team already shown adds no history entry (it switches tab / re-frames instead).
 */
function selectTeam(i, opts = {}) {
  const { from = 'ui', push = true, tab, snap } = opts;
  if (!M.teams[i]) return;
  if (state.team === i && state.player == null) {
    if (tab) setTab(tab);
    if (from !== 'map') fitTeam(i);
    return;
  }
  const prev = push ? pushStack() : null;
  showTeam(i, { dir: push ? 'forward' : 'fade', tab, snap: snap || (from === 'map' ? 'peek' : 'half') });
  commit(push ? 'push' : 'replace', push ? !prev : undefined);
  if (from === 'map') keepVisible(i);
  else fitTeam(i);
}

/** Select a player (draws their route). opts: { push, snap } as for selectTeam. Re-selecting replays the route. */
function selectPlayer(i, opts = {}) {
  const { push = true, snap } = opts;
  if (!M.players[i]) return;
  if (state.player === i) { replayRoute(); return; }
  const prev = push ? pushStack() : null;
  showPlayer(i, { dir: push ? 'forward' : 'fade', snap: snap || 'peek' });
  commit(push ? 'push' : 'replace', push ? !prev : undefined);
  fitPlayer(i);
}

/** Close the panel and return to the bare map (a new history entry, or Back when the map was the previous entry). */
function clearSelection() {
  if (!hasSel()) { closePanel(); return; }
  if (history.state?.ha && history.state.fromBare && !state.stack.length) { history.back(); return; }
  saveView();
  hideAll();
  commit('push');
}

/** The breadcrumb: back to the previous selection (browser Back when that's our entry), else close. */
function goBack() {
  if (!hasSel()) return;
  if (history.state?.ha && (state.stack.length || history.state.fromBare)) { history.back(); return; }
  const prev = state.stack.pop();
  if (!prev) { clearSelection(); return; }
  show(prev, 'back');
  commit('replace');
  fit(prev);
}

/** Switch the open team's tab ('roster' | 'conn' | 'reun') without a new history entry. */
function setTab(tab) {
  if (state.team == null || state.player != null) return;
  switchTab(tab);
}

/** Re-run the selected player's route animation and re-frame it. */
function replayRoute() {
  if (state.player == null) return;
  if (typeof map.replayRoute === 'function') map.replayRoute();
  else { map.setSelection({}); map.setSelection({ player: state.player }); }
  fitPlayer(state.player);
}

// ------------------------------------------------------------------ rendering + camera

function showTeam(i, o) {
  state.team = i;
  state.player = null;
  map.setSelection({ team: i });
  renderTeamPanel(M.teams[i], o);
}
function showPlayer(i, o) {
  state.team = null;
  state.player = i;
  map.setSelection({ team: null, player: i });
  renderPlayerPanel(M.players[i], o);
}
function show(sel, dir) {
  if (sel.player != null) showPlayer(sel.player, { dir, view: sel.view, snap: 'peek' });
  else showTeam(sel.team, { dir, view: sel.view, snap: 'half' });
}
function hideAll() {
  state.team = null;
  state.player = null;
  state.stack = [];
  map.setSelection({});
  closePanel();
}

const fitOpts = (maxK = 5) => ({ maxK, padRight: panelInsetRight(), padBottom: sheetInset() });
function fitTeam(i) {
  const t = M.teams[i];
  const top = [...t.links.entries()].filter(([, e]) => e.n >= 2).sort((a, b) => b[1].n - a[1].n).slice(0, 6).map(([o]) => o);
  map.fitTeams([i, ...t.affs, ...top], fitOpts());
}
function fitPlayer(i) {
  const p = M.players[i];
  map.fitTeams([...p.nodes, ...p.t], fitOpts());
}
const fit = (sel) => (sel.player != null ? fitPlayer(sel.player) : fitTeam(sel.team));

// A team tapped on the map stays where it is, unless the phone sheet now covers it.
function keepVisible(i) {
  if (!isSheet()) return;
  const p = map.pos?.get?.(i);
  if (!p) return;
  const bottom = window.innerHeight - sheetInset() - 28;
  if (p.y <= bottom && p.y >= 110) return;
  if (typeof map.flyTo === 'function') map.flyTo(i, { padRight: 0, padBottom: sheetInset() });
  else map.fitTeams([i], fitOpts(Math.max(1, map.transform?.k || 1)));
}

// ------------------------------------------------------------------ history

function routeInitial() {
  const hs = history.state;
  const sel = parseHash();
  if (hs?.ha) seq = hs.seq || 0;
  if (hs?.ha && sel && sameSel(fromIds(hs), sel)) { applyEntry(hs, 'none'); return; }
  if (sel) {
    state.stack = [];
    show({ ...sel, view: null }, 'none');
    fit(sel);
  }
  commit('replace', false);
}

function onPopState(e) {
  const s = e.state;
  if (s?.ha) {
    const dir = (s.seq ?? 0) < seq ? 'back' : 'forward';
    seq = s.seq ?? 0;
    applyEntry(s, dir);
    return;
  }
  // a hash typed into the address bar or followed from a plain link: a new step from here
  const sel = parseHash();
  const prev = cur();
  if (sel && !sameSel(sel, prev)) {
    if (prev) state.stack = [...state.stack, { ...prev, view: getView() }].slice(-STACK_MAX);
    show(sel, 'forward');
    fit(sel);
  } else if (!sel) hideAll();
  seq += 1;
  commit('replace', !prev);
}

function applyEntry(s, dir) {
  const sel = fromIds(s);
  state.stack = (s.stack || []).map(fromIds).filter(Boolean);
  if (!sel) { if (hasSel() || !$('#panel').hidden) hideAll(); }
  else if (sameSel(sel, cur())) refreshHeader();
  else { show(sel, dir); fit(sel); }
  document.title = titleFor();
}
