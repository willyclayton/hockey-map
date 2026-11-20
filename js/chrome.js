import { M, map, state, actions } from './app.js';
import { fold, RATING_WEIGHTS, seasonLabel } from './model.js';
import { ratingColor, RATING_RAMP } from './map.js';
import { $, esc, plural, logoHTML, leaguePill, avatarHTML, placeTooltip, animateGauges } from './util.js';

const selectTeam = (...a) => actions.selectTeam(...a);
const selectPlayer = (...a) => actions.selectPlayer(...a);
const clearSelection = (...a) => actions.clearSelection(...a);
const goBack = (...a) => actions.goBack(...a);

export function buildFilters() {
  const wrap = $('#league-filters');
  const counts = d3.rollup(M.teams, (v) => v.length, (t) => t.lg);
  wrap.innerHTML = M.leagues.map((l) => `<button class="chip" type="button" data-lg="${l.id}" aria-pressed="true" title="${esc(l.name)} — ${esc(l.tier)}"><span class="dot" style="border-color:${l.color};background:${l.color}"></span>${l.id}<span class="n">${counts.get(l.id) || 0}</span></button>`).join('');
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const on = b.getAttribute('aria-pressed') !== 'true';
    if (e.shiftKey || e.altKey) {
      // solo this league
      wrap.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
    } else b.setAttribute('aria-pressed', String(on));
    const set = new Set([...wrap.querySelectorAll('.chip[aria-pressed="true"]')].map((c) => c.dataset.lg));
    map.setVisibleLeagues(set);
  });
  wrap.addEventListener('dblclick', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    wrap.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
    map.setVisibleLeagues(new Set([b.dataset.lg]));
  });
  document.querySelectorAll('.chip.layer').forEach((b) => b.addEventListener('click', () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    map.setLayer(b.dataset.layer, on);
    buildLegend();
  }));
  $('#color-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $('#color-mode').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    map.setColorMode(b.dataset.mode);
    buildLegend();
  });
  const sl = $('#min-shared');
  sl.addEventListener('input', () => {
    $('#min-shared-out').textContent = plural(+sl.value, 'player');
    map.setMinShared(+sl.value);
  });
}

export function buildLegend() {
  const el = $('#legend');
  const rating = map.colorMode === 'rating';
  let h = '';
  if (rating) {
    h += `<div class="lg-title">Connection rating</div><div class="ramp" style="background:linear-gradient(90deg,${RATING_RAMP.join(',')})"></div><div class="ramp-labels"><span>0 · least</span><span>100 · most</span></div>`;
  } else {
    h += `<div class="lg-title">Badge size = level · ring = league</div><div class="lg-row"><span class="sz"><i style="width:18px;height:18px"></i>NHL</span><span class="sz"><i style="width:14px;height:14px"></i>AHL</span><span class="sz"><i style="width:11px;height:11px"></i>Minor pro / junior</span></div>`;
  }
  h += `<div class="lg-row" style="margin-top:6px"><span class="swatch-line aff"></span>Affiliation (NHL · AHL · ECHL)</div>`;
  h += `<div class="lg-row"><span class="swatch-line web"></span>Shared players (thicker = more)</div>`;
  h += `<div class="meta">Data updated ${esc(M.generated.slice(0, 10))} · Rosters ${esc(M.season)}</div>`;
  el.innerHTML = h;
}

export function teamTooltip(t, ev) {
  const tt = $('#tooltip');
  if (!t) { tt.hidden = true; return; }
  let extra = '';
  if (state.team != null && state.team !== t.i) {
    const e = M.teams[state.team].links.get(t.i);
    const aff = M.teams[state.team].affs.has(t.i);
    if (e || aff) extra = `<div class="tt-list">${aff ? '<b>Affiliate</b> · ' : ''}${e ? plural(e.n, 'shared player') : ''}</div>`;
  }
  tt.innerHTML = `<div class="tt-head">${logoHTML(t)}<div><div class="tt-name">${esc(t.name)}</div><div class="tt-sub">${esc(t.lg)} · ${esc(t.loc || t.city)}</div></div></div>
    <div class="tt-stats"><div class="tt-stat"><b style="color:${ratingColor(t.rating)}">${t.rating}</b><span>Rating</span></div><div class="tt-stat"><b>${t.m.reach}</b><span>Teams linked</span></div><div class="tt-stat"><b>${t.roster.length}</b><span>Roster</span></div></div>${extra}`;
  tt.hidden = false;
  placeTooltip(tt, ev);
}

export function linkTooltip(d, ev) {
  const tt = $('#tooltip');
  if (!d) { tt.hidden = true; return; }
  const a = M.teams[d.from], b = M.teams[d.to];
  const names = [...d.e.players].slice(0, 8).map((i) => M.players[i].n);
  const more = d.e.n - names.length;
  tt.innerHTML = `<div class="tt-name">${esc(a.short)} ↔ ${esc(b.short)}</div><div class="tt-sub">${plural(d.e.n, 'shared player')}${d.e.aff ? ' · affiliates' : ''}</div><div class="tt-list">${names.map(esc).join(', ')}${more > 0 ? ` +${more} more` : ''}</div>`;
  tt.hidden = false;
  placeTooltip(tt, ev);
}

export function wireSearch() {
  const input = $('#search'), box = $('#search-results');
  let items = [], active = -1;
  const render = () => {
    const q = fold(input.value.trim());
    if (q.length < 2) { box.hidden = true; return; }
    const toks = q.split(/\s+/);
    const score = (key) => (key.startsWith(q) ? 0 : key.includes(` ${toks[0]}`) ? 1 : 2);
    const teams = M.searchTeams.filter((s) => toks.every((k) => s.key.includes(k))).sort((a, b) => score(a.key) - score(b.key)).slice(0, 6);
    const players = M.searchPlayers.filter((s) => toks.every((k) => s.key.includes(k))).sort((a, b) => score(a.key) - score(b.key) || M.players[a.i].lg.localeCompare(M.players[b.i].lg)).slice(0, 12);
    items = [...teams, ...players];
    active = items.length ? 0 : -1;
    let h = '';
    if (teams.length) h += '<div class="sr-head">Teams</div>' + teams.map((s, k) => { const t = M.teams[s.i]; return `<button class="sr-item" data-k="${k}" type="button">${logoHTML(t)}<span class="sr-main"><div class="sr-name">${esc(t.name)}</div><div class="sr-sub">${esc(t.lg)} · ${esc(t.loc || t.city)}</div></span></button>`; }).join('');
    if (players.length) h += '<div class="sr-head">Players</div>' + players.map((s, k) => { const p = M.players[s.i]; const t = M.teams[p.t[0]]; return `<button class="sr-item" data-k="${teams.length + k}" type="button">${avatarHTML(p)}<span class="sr-main"><div class="sr-name">${esc(p.n)}</div><div class="sr-sub">${esc(p.p || '')} · ${esc(t.name)} (${t.lg})</div></span></button>`; }).join('');
    if (!h) h = '<div class="sr-empty">No teams or players match.</div>';
    box.innerHTML = h;
    box.hidden = false;
    mark();
  };
  const mark = () => box.querySelectorAll('.sr-item').forEach((b) => b.classList.toggle('active', +b.dataset.k === active));
  const pick = (k) => {
    const it = items[k];
    if (!it) return;
    box.hidden = true;
    input.value = '';
    input.blur();
    if (it.kind === 'team') selectTeam(it.i);
    else selectPlayer(it.i);
  };
  input.addEventListener('input', render);
  input.addEventListener('focus', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); mark(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); mark(); e.preventDefault(); }
    else if (e.key === 'Enter') { pick(active); e.preventDefault(); }
    else if (e.key === 'Escape') { box.hidden = true; input.blur(); }
  });
  box.addEventListener('mousedown', (e) => {
    const b = e.target.closest('.sr-item');
    if (b) { e.preventDefault(); pick(+b.dataset.k); }
  });
  input.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 120));
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input && !e.target.closest('input')) { e.preventDefault(); input.focus(); }
    if (e.key === 'Escape' && document.activeElement !== input) {
      if (!$('#modal').hidden) $('#modal').hidden = true;
      else if (state.team != null || state.player != null) clearSelection();
    }
  });
}

export function wireChrome() {
  $('#btn-controls').addEventListener('click', () => {
    const open = $('#controls').classList.toggle('open');
    $('#btn-controls').setAttribute('aria-expanded', String(open));
  });
  $('#zoom-in').addEventListener('click', () => map.zoomBy(1.6));
  $('#zoom-out').addEventListener('click', () => map.zoomBy(1 / 1.6));
  $('#zoom-reset').addEventListener('click', () => map.resetView());
  $('#btn-leaderboard').addEventListener('click', openLeaderboard);
  $('#btn-about').addEventListener('click', openAbout);
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal' || e.target.closest('[data-close]')) { $('#modal').hidden = true; return; }
    const row = e.target.closest('[data-team]');
    if (row) { $('#modal').hidden = true; selectTeam(+row.dataset.team); }
  });
}

function openModal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
  $('.modal-card').scrollTop = 0;
}

const lb = { lg: 'ALL', sort: 'rating', dir: -1 };
export function openLeaderboard() {
  openModal(leaderboardHTML());
  wireLeaderboard();
  animateGauges();
}

function wireLeaderboard() {
  $('#modal-body').querySelectorAll('[data-lb-lg]').forEach((b) => b.addEventListener('click', () => { lb.lg = b.dataset.lbLg; openLeaderboard(); }));
  $('#modal-body').querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    if (lb.sort === th.dataset.sort) lb.dir *= -1; else { lb.sort = th.dataset.sort; lb.dir = th.dataset.sort === 'name' ? 1 : -1; }
    openLeaderboard();
  }));
}

function leaderboardHTML() {
  let ts = M.teams.filter((t) => lb.lg === 'ALL' || t.lg === lb.lg);
  const val = (t) => ({ rating: t.rating, name: t.name, reach: t.m.reach, strength: t.m.strength, reunions: t.m.reunions, pipeline: t.m.pipeline, lg: t.lg }[lb.sort]);
  ts = [...ts].sort((a, b) => {
    const x = val(a), y = val(b);
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * lb.dir || b.m.strength - a.m.strength;
  });
  const th = (k, label, cls = '') => `<th data-sort="${k}" class="${cls}" ${lb.sort === k ? `aria-sort="${lb.dir < 0 ? 'descending' : 'ascending'}"` : ''}>${label}${lb.sort === k ? (lb.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`;
  const pairs = M.pairs.filter((e) => !e.aff && (lb.lg === 'ALL' || M.teams[e.a].lg === lb.lg || M.teams[e.b].lg === lb.lg)).slice(0, 12);
  return `<h2 id="modal-title">Connection rankings</h2><p class="lead">How tangled is each roster in the web of hockey? Ratings compare each team against its own league, 0–100. ${lb.lg === 'ALL' ? 'Showing every league, so compare ranks within a league.' : ''}</p>
  <div class="lb-controls"><button class="chip" type="button" data-lb-lg="ALL" aria-pressed="${lb.lg === 'ALL'}">All leagues</button>${M.leagues.map((l) => `<button class="chip" type="button" data-lb-lg="${l.id}" aria-pressed="${lb.lg === l.id}"><span class="dot" style="border-color:${l.color};background:${l.color}"></span>${l.id}</button>`).join('')}</div>
  <table class="lb-table"><thead><tr><th class="num">#</th>${th('name', 'Team')}${th('lg', 'League', 'hide-sm')}${th('rating', 'Rating')}${th('reach', 'Reach', 'num hide-sm')}${th('strength', 'Links', 'num hide-sm')}${th('reunions', 'Reunions', 'num')}${th('pipeline', 'Pipeline', 'num hide-sm')}</tr></thead>
  <tbody>${ts.map((t, i) => `<tr class="click" data-team="${t.i}"><td class="num">${i + 1}</td><td><span class="lb-team">${logoHTML(t)}${esc(t.name)}</span></td><td class="hide-sm">${leaguePill(t.lg)}</td><td><span class="lb-rating"><b>${t.rating}</b><span class="bar"><i style="width:0;background:${ratingColor(t.rating)}" data-w="${Math.max(3, t.rating)}%"></i></span></span></td><td class="num hide-sm">${t.m.reach}</td><td class="num hide-sm">${t.m.strength}</td><td class="num">${t.m.reunions}</td><td class="num hide-sm">${Math.round(t.m.pipeline * 100)}%</td></tr>`).join('')}</tbody></table>
  <h4>Strongest non-affiliate links</h4><div class="pairs">${pairs.map((e) => `<button class="pair" data-team="${e.a}" type="button">${logoHTML(M.teams[e.a], 'sm')}${logoHTML(M.teams[e.b], 'sm')}<span class="pn">${esc(M.teams[e.a].short)} ↔ ${esc(M.teams[e.b].short)}</span><span class="pc">${e.n}</span></button>`).join('')}</div>`;
}

export function openAbout() {
  const w = RATING_WEIGHTS;
  openModal(`<h2 id="modal-title">How the Hockey Atlas works</h2>
  <p class="lead">Every team in the NHL, AHL, ECHL, SPHL, OHL, WHL, QMJHL, USHL and PWHL sits on the map at its home arena. Click one to see its affiliates, its roster, and every team its players connect it to.</p>
  <h4>The player web</h4>
  <p>Two teams are linked when a player currently on one has played for the other. Thicker lines mean more shared players. Click a player to trace their route across the map, stop by stop.</p>
  <h4>Connection rating (0–100)</h4>
  <p>A blend of four measures. Each is ranked against the other teams in the same league, so a 90 means "more connected than almost every team in its league":</p>
  <ul>
    <li><b>Reach (${w.reach * 100}%)</b>: how many teams on the map the roster is linked to.</li>
    <li><b>Web strength (${w.strength * 100}%)</b>: the total number of those player links.</li>
    <li><b>Reunions (${w.reunions * 100}%)</b>: pairs of current teammates who already played together on another team, in the same season.</li>
    <li><b>Pipeline (${w.pipeline * 100}%)</b>: for NHL/AHL/ECHL clubs, the share of the roster that came through the team's affiliates. For junior clubs, the share that's NHL-drafted or has pro experience. For SPHL/PWHL, the share that has played for another team on the map.</li>
  </ul>
  <h4>Data</h4>
  <p>Rosters for ${esc(M.season)} plus every season back to ${seasonLabel(M.firstSeason)} come from NHL.com and the league stat feeds. NHL players carry their full career history. Everyone else is matched across leagues by name and birth date, so careers before ${seasonLabel(M.firstSeason)} or outside these leagues (college, Europe) only show up for NHL players. Arenas and affiliations come from Wikipedia. Last updated ${esc(M.generated.slice(0, 10))}.</p>
  <h4>Tips</h4>
  <ul><li>Press <b>/</b> to search any team or player.</li><li>Double-click a league chip to show only that league.</li><li>Switch <b>Color by → Rating</b> to see the most connected teams at a glance.</li><li>Links are shareable: the URL updates with your selection.</li></ul>
  <p class="note" style="margin-top:18px">An unofficial fan project, not affiliated with any league or team. Team names and logos are trademarks of their respective owners.</p>`);
}
