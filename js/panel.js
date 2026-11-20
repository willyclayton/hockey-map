import { M, state, actions } from './app.js';
import { orgOf, pipelineLabel, seasonLabel } from './model.js';
import { ratingColor } from './map.js';
import { $, esc, plural, logoHTML, leaguePill, avatarHTML, teamName, refLeague, animateGauges } from './util.js';
import { openAbout } from './chrome.js';

const selectTeam = (...a) => actions.selectTeam(...a);
const selectPlayer = (...a) => actions.selectPlayer(...a);
const clearSelection = (...a) => actions.clearSelection(...a);
const goBack = (...a) => actions.goBack(...a);

export function openPanel(html, color) {
  const panel = $('#panel');
  panel.hidden = false;
  panel.style.setProperty('--team-c', color || '#3987e5');
  $('#panel-body').innerHTML = html;
  $('#panel-body').scrollTop = 0;
  $('#panel-back').hidden = state.stack.length === 0;
  document.body.classList.add('panel-open');
  $('#tooltip').hidden = true;
}

export function closePanel() {
  $('#panel').hidden = true;
  $('#panel').classList.remove('expanded');
  document.body.classList.remove('panel-open');
}

function gauge(value, color) {
  const R = 46, C = 2 * Math.PI * R;
  return `<div class="gauge"><svg viewBox="0 0 112 112"><circle class="g-bg" cx="56" cy="56" r="${R}"/><circle class="g-fg" cx="56" cy="56" r="${R}" stroke="${color}" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-target="${C * (1 - value / 100)}"/></svg><div class="g-val"><div><b>${value}</b><span>of 100</span></div></div></div>`;
}

export function renderTeamPanel(t) {
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

export function tabHTML(t) {
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

export function renderPlayerPanel(p) {
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

export function wirePanel() {
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
}
