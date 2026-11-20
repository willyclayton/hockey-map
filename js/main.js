import { buildModel } from './model.js';
import { HockeyMap } from './map.js';
import { M, map, state, actions, setModel, setMap } from './app.js';
import { $, isMobile } from './util.js';
import { renderTeamPanel, renderPlayerPanel, closePanel, wirePanel } from './panel.js';
import { buildFilters, buildLegend, teamTooltip, linkTooltip, wireSearch, wireChrome } from './chrome.js';

Object.assign(actions, { selectTeam, selectPlayer, clearSelection, goBack });

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
    onBackground: () => clearSelection(),
    onHover: teamTooltip,
    onLinkHover: linkTooltip,
  }));
  buildFilters();
  buildLegend();
  wireSearch();
  wirePanel();
  wireChrome();
  $('#tagline').textContent = `${M.teams.length} teams · ${M.players.length.toLocaleString()} players · ${M.season}`;
  routeFromHash();
  window.addEventListener('hashchange', routeFromHash);
  requestAnimationFrame(() => $('#loading').classList.add('done'));
  setTimeout(() => $('#loading').remove(), 700);
}

// ------------------------------------------------------------------ selection + routing
function selectTeam(i, { from = 'ui', push = true } = {}) {
  if (push && (state.team != null || state.player != null)) state.stack.push({ team: state.team, player: state.player });
  state.team = i;
  state.player = null;
  state.tab = 'roster';
  state.showAllConn = false;
  map.setSelection({ team: i });
  renderTeamPanel(M.teams[i]);
  setHash(`t=${M.teams[i].id}`);
  if (from !== 'map') {
    const t = M.teams[i];
    const top = [...t.links.entries()].filter(([, e]) => e.n >= 2).sort((a, b) => b[1].n - a[1].n).slice(0, 6).map(([o]) => o);
    map.fitTeams([i, ...t.affs, ...top], { maxK: 5, padRight: isMobile() ? 0 : 450 });
  }
}

function selectPlayer(i, { push = true } = {}) {
  if (push && (state.team != null || state.player != null)) state.stack.push({ team: state.team, player: state.player });
  state.player = i;
  map.setSelection({ team: null, player: i });
  renderPlayerPanel(M.players[i]);
  setHash(`p=${M.players[i].id}`);
  const p = M.players[i];
  map.fitTeams([...p.nodes, ...p.t], { maxK: 5, padRight: isMobile() ? 0 : 450 });
}

function clearSelection() {
  state.team = null;
  state.player = null;
  state.stack = [];
  map.setSelection({});
  closePanel();
  setHash('');
}

function goBack() {
  const prev = state.stack.pop();
  if (!prev) return clearSelection();
  if (prev.player != null) {
    state.player = prev.player; state.team = prev.team;
    map.setSelection({ player: prev.player });
    renderPlayerPanel(M.players[prev.player]);
    setHash(`p=${M.players[prev.player].id}`);
  } else if (prev.team != null) {
    selectTeam(prev.team, { push: false, from: 'map' });
  }
}

function setHash(h) {
  const target = h ? `#${h}` : '';
  if (location.hash === target) return;
  history.replaceState(null, '', target || location.pathname + location.search);
}

function routeFromHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('t') && M.teamById.has(h.get('t'))) selectTeam(M.teamById.get(h.get('t')).i, { push: false });
  else if (h.get('p') && M.playerById.has(h.get('p'))) selectPlayer(M.playerById.get(h.get('p')).i, { push: false });
}
