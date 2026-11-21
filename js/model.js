// Data model: indexes, the shared-player graph and the Connection Rating.

export const RATING_WEIGHTS = { reach: 0.35, strength: 0.25, reunions: 0.25, pipeline: 0.15 };
// Player connection score: active players they've played with, other locker rooms with a former
// teammate in them now, teams on the map, and leagues on the map. Each ranked within the player's league.
export const PLAYER_WEIGHTS = { mates: 0.4, rooms: 0.3, teams: 0.2, leagues: 0.1 };
const AFFILIATED = new Set(['NHL', 'AHL', 'ECHL']);
const JUNIOR = new Set(['OHL', 'WHL', 'QMJHL', 'USHL']);
const BASE_R = { NHL: 15, AHL: 12, ECHL: 10, SPHL: 9, PWHL: 10, OHL: 9, WHL: 9, QMJHL: 9, USHL: 8 };

export function pipelineLabel(lg) {
  if (AFFILIATED.has(lg)) return { name: 'Pipeline', desc: 'share of roster that has played for this team’s NHL/AHL/ECHL affiliates' };
  if (JUNIOR.has(lg)) return { name: 'NHL pipeline', desc: 'share of roster that is NHL-drafted or has played on an NHL/AHL/ECHL team' };
  return { name: 'Map mileage', desc: 'share of roster that has played for another team on the map' };
}

export function buildModel(data) {
  const { teams, players, strings, leagues, affiliations } = data;
  const leagueById = new Map(leagues.map((l) => [l.id, l]));
  const off = strings.map((s) => {
    const i = s.indexOf('|');
    return i > 0 ? { lg: s.slice(0, i), name: s.slice(i + 1) } : { lg: '', name: s };
  });

  teams.forEach((t, i) => {
    t.i = i;
    t.league = leagueById.get(t.lg);
    t.color = t.league.color;
    t.baseR = BASE_R[t.lg] || 9;
    t.affs = new Set();
    t.links = new Map();
    t.prospects = [];
    t.short = t.nick || t.name;
  });
  for (const [a, b] of affiliations) {
    teams[a].affs.add(b);
    teams[b].affs.add(a);
  }

  players.forEach((p, i) => {
    p.i = i;
    p.nodes = new Set();
    for (const c of p.c) if (c[1] >= 0) p.nodes.add(c[1]);
    p.curTeams = p.t;
    const t0 = teams[p.t[0]];
    p.lg = t0 ? t0.lg : '';
    p.age = age(p.dob);
    if (p.rt != null && teams[p.rt] && JUNIOR.has(p.lg)) teams[p.rt].prospects.push(i);
  });

  // ---- shared-player graph: pair (A,B) is linked by every current player of A who played for B, and vice versa
  const pairKey = (a, b) => (a < b ? a * 1000 + b : b * 1000 + a);
  const pairs = new Map();
  for (const t of teams) {
    for (const pi of t.roster) {
      const p = players[pi];
      for (const o of p.nodes) {
        if (o === t.i) continue;
        const k = pairKey(t.i, o);
        let e = pairs.get(k);
        if (!e) {
          e = { a: Math.min(t.i, o), b: Math.max(t.i, o), players: new Set(), dir: new Map() };
          pairs.set(k, e);
        }
        e.players.add(pi);
        // direction: player currently on t, has history at o
        if (!e.dir.has(pi)) e.dir.set(pi, t.i);
      }
    }
  }
  const pairList = [...pairs.values()];
  for (const e of pairList) {
    e.n = e.players.size;
    e.aff = teams[e.a].affs.has(e.b);
    teams[e.a].links.set(e.b, e);
    teams[e.b].links.set(e.a, e);
  }
  pairList.sort((x, y) => y.n - x.n);

  // ---- per-team metrics
  for (const t of teams) {
    const m = { roster: t.roster.length };
    m.reach = t.links.size;
    let s = 0;
    for (const e of t.links.values()) s += e.n;
    m.strength = s;

    // reunions: roster pairs who shared a team-season somewhere other than this team
    const groups = new Map();
    for (const pi of t.roster) {
      for (const c of players[pi].c) {
        if (c[1] === t.i) continue;
        const k = c[0] * 100000 + (c[1] + 50000);
        let g = groups.get(k);
        if (!g) groups.set(k, (g = { season: c[0], ref: c[1], players: new Set() }));
        g.players.add(pi);
      }
    }
    const pairSet = new Set();
    const byRef = new Map();
    for (const g of groups.values()) {
      if (g.players.size < 2) continue;
      const arr = [...g.players].sort((a, b) => a - b);
      for (let x = 0; x < arr.length; x++) for (let y = x + 1; y < arr.length; y++) pairSet.add(arr[x] * 100000 + arr[y]);
      let r = byRef.get(g.ref);
      if (!r) byRef.set(g.ref, (r = { ref: g.ref, players: new Set(), seasons: new Set(), pairs: new Set() }));
      for (const p of arr) r.players.add(p);
      r.seasons.add(g.season);
      r.pairSeasons ||= new Map(); // pair key -> seasons that pair shared on this team
      for (let x = 0; x < arr.length; x++) for (let y = x + 1; y < arr.length; y++) {
        const pk = arr[x] * 100000 + arr[y];
        r.pairs.add(pk);
        let ss = r.pairSeasons.get(pk);
        if (!ss) r.pairSeasons.set(pk, (ss = []));
        ss.push(g.season);
      }
    }
    m.reunions = pairSet.size;
    t.reunions = [...byRef.values()].sort((a, b) => b.players.size - a.players.size || b.pairs.size - a.pairs.size);

    // pipeline
    const n = t.roster.length || 1;
    let hits = 0;
    if (AFFILIATED.has(t.lg)) {
      for (const pi of t.roster) if ([...players[pi].nodes].some((o) => t.affs.has(o))) hits++;
    } else if (JUNIOR.has(t.lg)) {
      for (const pi of t.roster) {
        const p = players[pi];
        if (p.dr || [...p.nodes].some((o) => AFFILIATED.has(teams[o].lg) && o !== t.i)) hits++;
      }
    } else {
      for (const pi of t.roster) if ([...players[pi].nodes].some((o) => o !== t.i)) hits++;
    }
    m.pipeline = hits / n;
    m.pipelineN = hits;
    t.m = m;
  }

  // ---- rating: weighted blend of within-league percentiles
  const byLeague = d3.group(teams, (t) => t.lg);
  for (const [, ts] of byLeague) {
    for (const key of Object.keys(RATING_WEIGHTS)) {
      const vals = ts.map((t) => t.m[key]).sort((a, b) => a - b);
      for (const t of ts) {
        const v = t.m[key];
        const lo = d3.bisectLeft(vals, v), hi = d3.bisectRight(vals, v);
        const pct = ts.length > 1 ? (lo + (hi - lo - 1) / 2) / (ts.length - 1) : 0.5;
        (t.pct ||= {})[key] = pct;
      }
    }
    for (const t of ts) {
      let r = 0;
      for (const [k, w] of Object.entries(RATING_WEIGHTS)) r += w * t.pct[k];
      t.rating = Math.round(r * 100);
    }
    const sorted = [...ts].sort((a, b) => b.rating - a.rating || b.m.strength - a.m.strength);
    sorted.forEach((t, i) => { t.leagueRank = i + 1; t.leagueSize = ts.length; });
  }

  // ---- search index
  const searchTeams = teams.map((t) => ({ kind: 'team', i: t.i, key: fold(`${t.name} ${t.abbr} ${t.city} ${t.lg}`) }));
  const searchPlayers = players.map((p) => ({ kind: 'player', i: p.i, key: fold(p.n) }));

  return { ...data, leagueById, off, pairs: pairList, pairKey, pairMap: pairs, searchTeams, searchPlayers, teamById: new Map(teams.map((t) => [t.id, t])), playerById: new Map(players.map((p) => [p.id, p])) };
}

export function fold(s) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function age(dob) {
  if (!dob) return null;
  const d = new Date(dob + 'T00:00:00');
  if (isNaN(d)) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a > 10 && a < 60 ? a : null;
}

export function seasonLabel(y) {
  return `${y}-${String(y + 1).slice(2)}`;
}

// ---- player connection score (computed once, on first need; ~100ms, so main.js runs it in idle time)
// Who has each player shared a locker room with? Every (season, team) stint is grouped, then each
// player collects the active players from their groups. The current season on their current team is
// skipped, so "teammates" means people they played with before or elsewhere (current teammates who also
// played with them somewhere else still count, through that other stint).
export function ensurePlayerScores(M) {
  if (M.playerScores) return;
  const { players, teams } = M;
  const CUR = parseInt(M.season, 10);
  const skip = (p, c) => c[0] === CUR && p.t.includes(c[1]);
  const gkey = (c) => c[0] * 100000 + (c[1] + 50000);
  const stintGroups = new Map();
  for (const p of players) {
    for (const c of p.c) {
      const k = gkey(c);
      let g = stintGroups.get(k);
      if (!g) stintGroups.set(k, (g = []));
      g.push(p.i);
    }
  }
  for (const p of players) {
    const mates = new Set();
    for (const c of p.c) {
      if (skip(p, c)) continue;
      for (const q of stintGroups.get(gkey(c))) if (q !== p.i) mates.add(q);
    }
    const rooms = new Map(); // current team -> former teammates there now
    for (const q of mates) for (const ti of players[q].t) if (!p.t.includes(ti)) rooms.set(ti, (rooms.get(ti) || 0) + 1);
    const onMap = new Set([...p.nodes, ...p.t]);
    p.mates = mates;
    p.rooms = rooms;
    p.sm = { mates: mates.size, rooms: rooms.size, teams: onMap.size, leagues: new Set([...onMap].map((i) => teams[i].lg)).size };
  }
  const byPlayerLeague = d3.group(players.filter((p) => p.lg), (p) => p.lg);
  for (const [, ps] of byPlayerLeague) {
    for (const key of Object.keys(PLAYER_WEIGHTS)) {
      const vals = ps.map((p) => p.sm[key]).sort((a, b) => a - b);
      for (const p of ps) {
        const v = p.sm[key];
        const lo = d3.bisectLeft(vals, v), hi = d3.bisectRight(vals, v);
        (p.spct ||= {})[key] = ps.length > 1 ? (lo + (hi - lo - 1) / 2) / (ps.length - 1) : 0.5;
      }
    }
    for (const p of ps) {
      let s = 0;
      for (const [k, w] of Object.entries(PLAYER_WEIGHTS)) s += w * p.spct[k];
      p.score = Math.round(s * 100);
    }
    [...ps].sort((a, b) => b.score - a.score || b.sm.mates - a.sm.mates).forEach((p, i) => { p.leagueRank = i + 1; p.leagueSize = ps.length; });
  }

  M.playerScores = true;
}

// The team's organization: itself plus its direct affiliates, grouped by league.
export function orgOf(model, t) {
  const fam = [t, ...[...t.affs].map((i) => model.teams[i])];
  const by = (lg) => fam.filter((x) => x.lg === lg);
  return { nhl: by('NHL'), ahl: by('AHL'), echl: by('ECHL') };
}
