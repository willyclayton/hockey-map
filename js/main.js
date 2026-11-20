import { buildModel, fold, orgOf, pipelineLabel, RATING_WEIGHTS, seasonLabel } from './model.js';
import { HockeyMap, ratingColor, RATING_RAMP } from './map.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;
const isMobile = () => window.innerWidth < 760;

let M, map;
const state = { team: null, player: null, stack: [], tab: 'roster', showAllConn: false };

init().catch((e) => {
  console.error(e);
  $('#loading p').textContent = 'Could not load the data. Try refreshing.';
});

async function init() {
  const [data, topo] = await Promise.all([
    fetch('data/hockey.json').then((r) => r.json()),
    fetch('data/na.topo.json').then((r) => r.json()),
  ]);
  M = buildModel(data);
  map = new HockeyMap($('#map'), M, topo, {
    onTeam: (i) => selectTeam(i, { from: 'map' }),
    onBackground: () => clearSelection(),
    onHover: teamTooltip,
    onLinkHover: linkTooltip,
  });
  buildFilters();
  buildLegend();
  wireSearch();
  wireChrome();
  $('#tagline').textContent = `${M.teams.length} teams · ${M.players.length.toLocaleString()} players · ${M.season}`;
  routeFromHash();
  window.addEventListener('hashchange', routeFromHash);
  requestAnimationFrame(() => $('#loading').classList.add('done'));
  setTimeout(() => $('#loading').remove(), 700);
}

// ------------------------------------------------------------------ helpers
function logoHTML(t, cls = '') {
  const inner = t.logo ? `<img src="${esc(t.logo)}" alt="" loading="lazy">` : `<b>${esc((t.abbr || t.short).slice(0, 4))}</b>`;
  return `<span class="mini-logo ${cls}" style="--c:${t.color}">${inner}</span>`;
}
function leaguePill(lg) {
  const L = M.leagueById.get(lg);
  return `<span class="lg-pill"><i style="background:${L.color}"></i>${esc(L.id)}</span>`;
}
function avatarHTML(p) {
  const ini = p.n.split(' ').map((w) => w[0]).slice(0, 2).join('');
  return p.img ? `<span class="avatar"><img src="${esc(p.img)}" alt="" loading="lazy" onerror="this.parentNode.textContent='${esc(ini)}'"></span>` : `<span class="avatar">${esc(ini)}</span>`;
}
function teamName(ref, override) {
  if (override != null) return M.strings[override];
  return ref >= 0 ? M.teams[ref].name : M.off[-ref - 1].name;
}
function refLeague(ref) { return ref >= 0 ? M.teams[ref].lg : M.off[-ref - 1].lg; }
function placeTooltip(el, ev) {
  const pad = 14;
  const r = el.getBoundingClientRect();
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
  el.style.left = `${Math.max(8, x)}px`;
  el.style.top = `${Math.max(8, y)}px`;
}

// ------------------------------------------------------------------ filters + legend
function buildFilters() {
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

function buildLegend() {
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

// ------------------------------------------------------------------ tooltips
function teamTooltip(t, ev) {
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

function linkTooltip(d, ev) {
  const tt = $('#tooltip');
  if (!d) { tt.hidden = true; return; }
  const a = M.teams[d.from], b = M.teams[d.to];
  const names = [...d.e.players].slice(0, 8).map((i) => M.players[i].n);
  const more = d.e.n - names.length;
  tt.innerHTML = `<div class="tt-name">${esc(a.short)} ↔ ${esc(b.short)}</div><div class="tt-sub">${plural(d.e.n, 'shared player')}${d.e.aff ? ' · affiliates' : ''}</div><div class="tt-list">${names.map(esc).join(', ')}${more > 0 ? ` +${more} more` : ''}</div>`;
  tt.hidden = false;
  placeTooltip(tt, ev);
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

// ------------------------------------------------------------------ panel
function openPanel(html, color) {
  const panel = $('#panel');
  panel.hidden = false;
  panel.style.setProperty('--team-c', color || '#3987e5');
  $('#panel-body').innerHTML = html;
  $('#panel-body').scrollTop = 0;
  $('#panel-back').hidden = state.stack.length === 0;
  document.body.classList.add('panel-open');
  $('#tooltip').hidden = true;
}
function closePanel() {
  $('#panel').hidden = true;
  $('#panel').classList.remove('expanded');
  document.body.classList.remove('panel-open');
}

function gauge(value, color) {
  const R = 46, C = 2 * Math.PI * R;
  return `<div class="gauge"><svg viewBox="0 0 112 112"><circle class="g-bg" cx="56" cy="56" r="${R}"/><circle class="g-fg" cx="56" cy="56" r="${R}" stroke="${color}" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-target="${C * (1 - value / 100)}"/></svg><div class="g-val"><div><b>${value}</b><span>of 100</span></div></div></div>`;
}

function animateGauges() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelectorAll('.g-fg[data-target]').forEach((c) => { c.style.strokeDashoffset = c.dataset.target; });
    document.querySelectorAll('.bar i[data-w]').forEach((b) => { b.style.width = b.dataset.w; });
  }));
}

function renderTeamPanel(t) {
  const pl = pipelineLabel(t.lg);
  const comps = [
    ['reach', 'Reach', `${t.m.reach} teams`, 'Teams on the map linked to this roster through shared players (either direction).'],
    ['strength', 'Web strength', `${t.m.strength} links`, 'Total player links across all of those teams.'],
    ['reunions', 'Reunions', plural(t.m.reunions, 'pair'), 'Pairs of current teammates who played together somewhere else before.'],
    ['pipeline', pl.name, `${Math.round(t.m.pipeline * 100)}%`, `The ${pl.desc}.`],
  ];
  const facts = [];
  if (t.arena) facts.push(`<span><b>${esc(t.arena)}</b></span>`);
  if (t.loc || t.city) facts.push(`<span>${esc(t.loc || t.city)}</span>`);
  if (t.rec) facts.push(`<span><b>${esc(t.rec)}</b> · ${t.pts} pts</span>`);
  facts.push(`<span><b>${t.roster.length}</b> on roster</span>`);

  let h = `<div class="hero"><div class="hero-row"><div class="hero-logo">${t.logo ? `<img src="${esc(t.logo)}" alt="${esc(t.name)} logo">` : `<b>${esc(t.abbr)}</b>`}</div>
    <div><h2 class="hero-name">${esc(t.name)}</h2><div class="hero-sub">${leaguePill(t.lg)} ${t.div ? `<span style="margin-left:6px">${esc(t.div)}</span>` : ''}</div></div></div>
    <div class="facts">${facts.join('')}</div></div>`;

  h += `<div class="section"><h3>Connection rating <button class="info" type="button" data-about>How it works</button></h3><div class="rating">${gauge(t.rating, ratingColor(t.rating))}
    <div class="rating-side"><div class="rating-rank">#${t.leagueRank} <span>of ${t.leagueSize} in the ${esc(t.lg)}</span></div>
    ${comps.map(([k, name, val, tip]) => `<div class="comp" title="${esc(tip)}"><div class="comp-top"><span>${name}</span><b>${val}</b></div><div class="bar"><i style="width:0;background:${ratingColor(t.pct[k] * 100)}" data-w="${Math.max(3, t.pct[k] * 100)}%"></i></div></div>`).join('')}
    </div></div></div>`;

  // organization
  const org = orgOf(M, t);
  if (org.nhl.length + org.ahl.length + org.echl.length > 1) {
    const row = (label, list) => (list.length ? `<div class="org-row"><span class="org-label">${label}</span><div class="org-teams">${list.map((x) => `<button class="team-chip ${x.i === t.i ? 'self' : ''}" style="--team-c:${x.color}" data-team="${x.i}" type="button">${logoHTML(x, 'sm')}<span>${esc(x.name)}</span></button>`).join('')}</div></div>` : '');
    h += `<div class="section"><h3>Organization</h3><div class="org">${row('NHL', org.nhl)}${row('AHL', org.ahl)}${row('ECHL', org.echl)}</div></div>`;
  } else if (['NHL', 'AHL', 'ECHL'].includes(t.lg)) {
    h += `<div class="section"><h3>Organization</h3><p class="note">No NHL/AHL affiliate listed for ${esc(M.season)} — an independent club.</p></div>`;
  }
  if (t.lg === 'NHL' && t.prospects.length) {
    const byTeam = d3.groups(t.prospects, (pi) => M.players[pi].t[0]).sort((a, b) => b[1].length - a[1].length);
    h += `<div class="section"><h3>Prospects in junior hockey <span class="count">${t.prospects.length}</span></h3><p class="note">${esc(t.short)} draft picks now playing in the OHL, WHL, QMJHL or USHL.</p><div class="org-teams">${byTeam.slice(0, 14).map(([ti, ps]) => `<button class="team-chip" data-team="${ti}" type="button" title="${esc(ps.map((pi) => M.players[pi].n).join(', '))}">${logoHTML(M.teams[ti], 'sm')}<span>${esc(M.teams[ti].name)} · ${ps.length}</span></button>`).join('')}</div></div>`;
  }

  h += `<div class="tabs" role="tablist">
    <button class="tab" role="tab" data-tab="roster" aria-selected="${state.tab === 'roster'}">Roster ${t.roster.length}</button>
    <button class="tab" role="tab" data-tab="conn" aria-selected="${state.tab === 'conn'}">Connections ${t.links.size}</button>
    <button class="tab" role="tab" data-tab="reun" aria-selected="${state.tab === 'reun'}">Reunions ${t.reunions.length}</button></div>
    <div class="tab-body" id="tab-body">${tabHTML(t)}</div>`;
  openPanel(h, t.color);
  animateGauges();
}

function tabHTML(t) {
  if (state.tab === 'conn') return connectionsHTML(t);
  if (state.tab === 'reun') return reunionsHTML(t);
  return rosterHTML(t);
}

function trailHTML(p, exclude) {
  const seen = [];
  for (let k = p.c.length - 1; k >= 0; k--) {
    const ref = p.c[k][1];
    if (ref >= 0 && ref !== exclude && !seen.includes(ref)) seen.push(ref);
  }
  const shown = seen.slice(0, 4);
  return `<span class="trail" title="${esc(seen.map((i) => M.teams[i].name).join(' · '))}">${shown.map((i) => logoHTML(M.teams[i], 'sm')).join('')}${seen.length > 4 ? `<span class="more">+${seen.length - 4}</span>` : ''}</span>`;
}

function rosterHTML(t) {
  const groups = [['Forwards', ['C', 'LW', 'RW', 'F', 'W']], ['Defense', ['D']], ['Goalies', ['G']]];
  let h = '';
  for (const [label, pos] of groups) {
    const ps = t.roster.map((i) => M.players[i]).filter((p) => pos.includes(p.p));
    if (!ps.length) continue;
    h += `<div class="pos-head">${label} · ${ps.length}</div>`;
    h += ps.map((p) => {
      const sub = [p.p, p.age ? `${p.age} yrs` : null, p.fr].filter(Boolean).join(' · ');
      return `<button class="prow" data-player="${p.i}" type="button">${avatarHTML(p)}<span class="pmain"><span class="pname">${p.no != null ? `<span class="num">#${p.no}</span>` : ''}${esc(p.n)}</span><span class="psub">${esc(sub)}</span></span>${trailHTML(p, t.i)}</button>`;
    }).join('');
  }
  const other = t.roster.map((i) => M.players[i]).filter((p) => !['C', 'LW', 'RW', 'F', 'W', 'D', 'G'].includes(p.p));
  if (other.length) h += `<div class="pos-head">Other · ${other.length}</div>` + other.map((p) => `<button class="prow" data-player="${p.i}" type="button">${avatarHTML(p)}<span class="pmain"><span class="pname">${esc(p.n)}</span></span>${trailHTML(p, t.i)}</button>`).join('');
  return h || '<div class="empty">No roster listed yet.</div>';
}

function connectionsHTML(t) {
  const list = [...t.links.entries()].sort((a, b) => b[1].n - a[1].n);
  if (!list.length) return '<div class="empty">No shared players with other teams on the map yet.</div>';
  const max = list[0][1].n;
  const shown = state.showAllConn ? list : list.slice(0, 40);
  let h = `<p class="note" style="padding:0 8px">Teams linked by players: current ${esc(t.short)} players who played there, plus that team's current players who played here.</p>`;
  h += shown.map(([o, e]) => {
    const ot = M.teams[o];
    let here = 0, there = 0;
    for (const [, cur] of e.dir) cur === t.i ? here++ : there++;
    const desc = [here ? `${here} now here` : null, there ? `${there} now there` : null].filter(Boolean).join(' · ');
    const names = [...e.players].slice(0, 4).map((pi) => M.players[pi].n.split(' ').slice(-1)[0]).join(', ');
    return `<button class="crow" data-team="${o}" type="button">${logoHTML(ot)}<span class="cmain"><span class="cname">${esc(ot.name)} <span class="tag">${ot.lg}</span>${t.affs.has(o) ? '<span class="tag">AFFILIATE</span>' : ''}</span><span class="cdesc">${desc} · ${esc(names)}${e.n > 4 ? '…' : ''}</span><span class="cbar"><i style="width:${(e.n / max) * 100}%;background:${ot.color}"></i></span></span><span class="cnum">${e.n}</span></button>`;
  }).join('');
  if (!state.showAllConn && list.length > shown.length) h += `<button class="pchip" style="margin:10px 8px" data-more-conn type="button">Show all ${list.length}</button>`;
  return h;
}

function reunionsHTML(t) {
  if (!t.reunions.length) return '<div class="empty">No current teammates have played together elsewhere.</div>';
  return `<p class="note" style="padding:0 8px">Groups of current ${esc(t.short)} who were teammates before, somewhere else.</p>` + t.reunions.slice(0, 50).map((r) => {
    const seasons = [...r.seasons].sort();
    const span = seasons.length > 1 ? `${seasonLabel(seasons[0])} – ${seasonLabel(seasons[seasons.length - 1])}` : seasonLabel(seasons[0]);
    const lg = refLeague(r.ref);
    const logo = r.ref >= 0 ? logoHTML(M.teams[r.ref]) : `<span class="off-logo">${esc(lg.slice(0, 4))}</span>`;
    const players = [...r.players].map((pi) => M.players[pi]);
    return `<div class="reunion"><div class="reunion-head">${logo}<span class="rh-name">${r.ref >= 0 ? `<a href="#t=${M.teams[r.ref].id}" data-team="${r.ref}" style="color:inherit;text-decoration:none">${esc(teamName(r.ref))}</a>` : esc(teamName(r.ref))}<div class="rh-sub">${esc(lg)} · ${span} · ${plural(r.pairs.size, 'pair')}</div></span></div>
      <div class="reunion-players">${players.map((p) => `<button class="pchip" data-player="${p.i}" type="button">${esc(p.n)}</button>`).join('')}</div></div>`;
  }).join('');
}

function renderPlayerPanel(p) {
  const cur = p.t.map((i) => M.teams[i]);
  const t0 = cur[0];
  const facts = [];
  if (p.age) facts.push(`<span><b>${p.age}</b> yrs${p.dob ? ` · ${esc(p.dob)}` : ''}</span>`);
  if (p.fr) facts.push(`<span>${esc(p.fr)}</span>`);
  if (p.ht || p.wt) facts.push(`<span>${[p.ht, p.wt ? `${p.wt} lb` : null].filter(Boolean).map(esc).join(' · ')}</span>`);
  if (p.sh) facts.push(`<span>${p.p === 'G' ? 'Catches' : 'Shoots'} <b>${esc(p.sh)}</b></span>`);
  if (p.dr) facts.push(`<span>Draft <b>${esc(p.dr)}</b></span>`);

  let h = `<div class="hero"><div class="hero-row"><div class="hero-logo headshot" style="${p.img ? '' : 'display:grid;place-items:center'}">${p.img ? `<img src="${esc(p.img)}" alt="" onerror="this.remove()">` : `<b style="font:700 26px var(--display);color:#0b1627">${esc(p.n.split(' ').map((w) => w[0]).slice(0, 2).join(''))}</b>`}</div>
    <div><h2 class="hero-name">${esc(p.n)}</h2><div class="hero-sub">${p.no != null ? `#${p.no} · ` : ''}${esc(p.p || '')}</div></div></div>
    <div class="org-teams" style="margin-top:12px">${cur.map((x) => `<button class="team-chip" data-team="${x.i}" type="button">${logoHTML(x, 'sm')}<span>${esc(x.name)}</span></button>`).join('')}</div>
    <div class="facts">${facts.join('')}</div></div>`;

  const mapTeams = new Set([...p.nodes, ...p.t]);
  const seasons = p.c.map((c) => c[0]);
  h += `<div class="section"><h3>Journey on the map</h3><p class="note" style="margin:0">${plural(mapTeams.size, 'team')} on the map${seasons.length ? ` · ${seasonLabel(Math.min(...seasons))} to ${seasonLabel(Math.max(...seasons))}` : ''}. The numbered route traces the stops in order.</p></div>`;

  // teammates now who played together before
  const mates = [];
  for (const ti of p.t) {
    const t = M.teams[ti];
    for (const r of t.reunions) {
      if (!r.players.has(p.i)) continue;
      for (const q of r.players) if (q !== p.i) mates.push({ q, ref: r.ref, team: ti });
    }
  }
  if (mates.length) {
    const byQ = d3.groups(mates, (m) => m.q);
    h += `<div class="section"><h3>Reunited with <span class="count">${byQ.length}</span></h3><p class="note">Current teammates who played with ${esc(p.n.split(' ')[0])} somewhere else.</p><div class="reunion-players" style="padding:0 0 10px">${byQ.map(([q, ms]) => `<button class="pchip" data-player="${q}" type="button" title="${esc([...new Set(ms.map((m) => teamName(m.ref)))].join(', '))}">${esc(M.players[q].n)}</button>`).join('')}</div></div>`;
  }

  h += `<div class="section"><h3>Career</h3><div class="timeline">${[...p.c].reverse().map((c) => {
    const [y, ref, gp, nm] = c;
    const on = ref >= 0;
    const lg = refLeague(ref);
    const logo = on ? logoHTML(M.teams[ref]) : `<span class="off-logo">${esc(lg.slice(0, 4))}</span>`;
    return `<div class="tl-row ${on ? 'clickable' : 'off'}" ${on ? `data-team="${ref}" role="button" tabindex="0"` : ''}><span class="tl-season">${seasonLabel(y)}</span>${logo}<span class="tl-main"><div class="tl-team">${esc(teamName(ref, nm))}</div><div class="tl-sub">${esc(lg)}${on && nm != null ? ` · now ${esc(M.teams[ref].name)}` : ''}</div></span>${gp ? `<span class="tl-gp">${gp} GP</span>` : ''}</div>`;
  }).join('')}</div>
  <p class="note" style="margin-top:10px">${p.id.startsWith('n') ? 'Full career from NHL.com.' : `Seasons since ${seasonLabel(M.firstSeason)}, matched across league rosters by name and birth date.`}</p></div>`;
  openPanel(h, t0 ? t0.color : '#3987e5');
}

// ------------------------------------------------------------------ search
function wireSearch() {
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

// ------------------------------------------------------------------ chrome: panel clicks, modals, zoom
function wireChrome() {
  $('#panel-close').addEventListener('click', clearSelection);
  $('#panel-back').addEventListener('click', goBack);
  $('#panel-body').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) {
      state.tab = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', String(x === tab)));
      $('#tab-body').innerHTML = tabHTML(M.teams[state.team]);
      return;
    }
    if (e.target.closest('[data-more-conn]')) { state.showAllConn = true; $('#tab-body').innerHTML = tabHTML(M.teams[state.team]); return; }
    if (e.target.closest('[data-about]')) { openAbout(); return; }
    const pl = e.target.closest('[data-player]');
    if (pl) { e.preventDefault(); selectPlayer(+pl.dataset.player); return; }
    const tm = e.target.closest('[data-team]');
    if (tm) { e.preventDefault(); selectTeam(+tm.dataset.team); }
  });
  $('#panel-body').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-team][role="button"]')) selectTeam(+e.target.dataset.team);
  });
  // mobile sheet: tap grab handle to expand
  $('.panel-grab').addEventListener('click', () => $('#panel').classList.toggle('expanded'));
  let y0 = null;
  $('#panel').addEventListener('touchstart', (e) => { if (e.target.closest('.hero, .panel-grab')) y0 = e.touches[0].clientY; }, { passive: true });
  $('#panel').addEventListener('touchend', (e) => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0;
    if (dy < -40) $('#panel').classList.add('expanded');
    if (dy > 60) { if ($('#panel').classList.contains('expanded')) $('#panel').classList.remove('expanded'); else clearSelection(); }
    y0 = null;
  });

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
function openLeaderboard() {
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

function openAbout() {
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
