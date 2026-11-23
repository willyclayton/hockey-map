#!/usr/bin/env python3
"""Build data/hockey.json (teams, rosters, player careers, affiliations) + team logos.

    python3 scripts/build_data.py            # uses cache (.cache/), refreshes current-season data after 12h
    python3 scripts/build_data.py --refresh  # re-download all current-season data now

Sources
  * NHL:  api-web.nhle.com  (standings, rosters for every season, full player career histories)
  * AHL, ECHL, OHL, WHL, QMJHL, USHL, SPHL, PWHL: HockeyTech/LeagueStat feeds (rosters for every season)
  * Wikipedia: arena coordinates + NHL/AHL/ECHL affiliations (cached in data/reference.json)

Players are linked across leagues by last name + birth date + compatible first names and within a league by its player id.
"""
import argparse
import concurrent.futures as cf
import datetime
import io
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reference  # noqa: E402
from common import (DATA, HT_LEAGUES, LEAGUES, ROOT, fetch, fetch_json, ht_url, log, norm,  # noqa: E402
                    write_json)

FIRST_SEASON = 2017
DAY = 86400
NHL = "https://api-web.nhle.com/v1"
LOGO_DIR = os.path.join(ROOT, "assets", "logos")

ap = argparse.ArgumentParser()
ap.add_argument("--refresh", action="store_true", help="ignore cached current-season data")
ap.add_argument("--reference", action="store_true", help="re-resolve every team on Wikipedia")
ap.add_argument("--workers", type=int, default=8)
args = ap.parse_args()
CUR_TTL = 60 if args.refresh else DAY / 2

# International / national-team / all-star competitions (not club hockey). Whole league codes only:
# "WC" is the World Championship, but "WCHA" is college hockey and "U20 SM-sarja" a Finnish junior league.
INTL_LEAGUES = re.compile(r"^(WC|WCUP|WCH|WCA|WCQ|WCCC|OG|OGQ|OGQUAL|OGC|OLY|OLYMPICS|WJC|WJ|WJAC|WHC|4N|5N|IIHF|"
                          r"EYOF|YOG|HG|INTL|INT|INTERNATIONAL|FRIENDLY|EUROTOUR|EHT|DCQ|DC|U-1[78]|U1[78]-DEV)"
                          r"(?=$|[-\s\d])", re.I)
INTL_EVENTS = re.compile(r"hlinka|gretzky cup|world (junior|championship|cup)|olympic|four nations|"
                         r"\b(team )?(usa|canada) u-?\d\d\b|\bu-?1[78] (team|wc)|challenge cup|ivan hlinka", re.I)
NHL_ABBR_FIX = {"LA": "LAK", "NJ": "NJD", "SJ": "SJS", "TB": "TBL", "MON": "MTL", "CLB": "CBJ", "NAS": "NSH",
                "VEG": "VGK", "LV": "VGK", "UTAH": "UTA", "UTH": "UTA", "CAL": "CGY", "WAS": "WSH",
                "NYR ": "NYR", "PHX": "ARI", "FLO": "FLA", "STL ": "STL", "WIN": "WPG", "MIN ": "MIN"}
POS = {"L": "LW", "R": "RW", "LW": "LW", "RW": "RW", "C": "C", "D": "D", "G": "G", "F": "F", "W": "W"}


def pool(fn, items, workers=None):
    out = {}
    with cf.ThreadPoolExecutor(max_workers=workers or args.workers) as ex:
        futs = {ex.submit(fn, it): it for it in items}
        for i, f in enumerate(cf.as_completed(futs)):
            it = futs[f]
            try:
                out[it] = f.result()
            except Exception as e:
                log("  !", it, e)
                out[it] = None
            if (i + 1) % 200 == 0:
                log(f"    {i + 1}/{len(items)}")
    return out


def season_start(name):
    m = re.search(r"(20\d\d)\s*[-–]\s*(\d{2,4})", name)
    if m:
        return int(m.group(1))
    m = re.search(r"(20\d\d)", name)
    return int(m.group(1)) - 1 if m else None


def season_label(y):
    return f"{y}-{str(y + 1)[2:]}"


def valid_dob(d):
    return bool(d) and bool(re.match(r"^(19[6-9]\d|20[01]\d)-\d\d-\d\d$", d)) and not d.endswith("-00-00")


# ---------------------------------------------------------------- union-find for player identity
parent = {}


def find(x):
    parent.setdefault(x, x)
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


def union(a, b):
    ra, rb = find(a), find(b)
    if ra != rb:
        parent[rb] = ra


# Cross-league identity: same surname + birth date, AND compatible first names (one a prefix of the
# other, or a common nickname pair). That keeps twins apart (Tyler/Jesse Tucker, Mackie/Madison
# Samoskevich) while still matching "Matt"/"Matthew" or "Jake"/"Jacob". Women's and men's leagues never link.
NICK = {"jake": "jacob", "jakob": "jacob", "mitch": "mitchell", "zach": "zachary", "zack": "zachary", "zak": "zachary",
        "nick": "nicholas", "nic": "nicholas", "nicolas": "nicholas", "alex": "alexander", "aleksander": "alexander",
        "alexandre": "alexander", "matt": "matthew", "mathew": "matthew", "mike": "michael", "mikey": "michael",
        "tony": "anthony", "will": "william", "bill": "william", "billy": "william", "liam": "william", "bob": "robert",
        "rob": "robert", "bobby": "robert", "robbie": "robert", "chris": "christopher", "dan": "daniel",
        "danny": "daniel", "sam": "samuel", "tom": "thomas", "tommy": "thomas", "joe": "joseph", "joey": "joseph",
        "ben": "benjamin", "josh": "joshua", "nate": "nathan", "andy": "andrew", "drew": "andrew",
        "jon": "jonathan", "johnny": "john", "jack": "john", "dave": "david", "steve": "steven", "stephen": "steven",
        "pat": "patrick", "ed": "edward", "eddie": "edward", "ted": "edward", "teddy": "theodore", "theo": "theodore",
        "max": "maxim", "maxime": "maxim", "maximilian": "maxim", "gabe": "gabriel", "vince": "vincent",
        "jim": "james", "jimmy": "james", "jamie": "james", "cam": "cameron", "fred": "frederick", "freddy": "frederick",
        "greg": "gregory", "jeff": "jeffrey", "ken": "kenneth", "kenny": "kenneth", "ron": "ronald", "russ": "russell",
        "zac": "zachary", "tim": "timothy", "timmy": "timothy", "brad": "bradley", "dom": "dominic", "dominik": "dominic"}
WOMEN = {"PWHL"}
name_groups = defaultdict(list)  # (gender, surname, dob) -> [(element, first name)]


def same_first(a, b):
    if not a or not b:
        return False
    if a.startswith(b) or b.startswith(a):
        return True
    return NICK.get(a, a) == NICK.get(b, b)


def note_identity(el, league, first, last, dob):
    if valid_dob(dob) and norm(last) and norm(first):
        name_groups[("W" if league in WOMEN else "M", norm(last), dob)].append((el, norm(first)))


def link_identities():
    for members in name_groups.values():
        for x in range(len(members)):
            for y in range(x + 1, len(members)):
                if members[x][0] != members[y][0] and same_first(members[x][1], members[y][1]):
                    union(members[x][0], members[y][0])


# ---------------------------------------------------------------- NHL
log("NHL: standings")
st_now = fetch_json(f"{NHL}/standings/now", ttl=CUR_TTL)["standings"]
CUR = int(str(st_now[0]["seasonId"])[:4])
log(f"  current season {season_label(CUR)}")
nhl_teams = {}
for r in st_now:
    ab = r["teamAbbrev"]["default"]
    nhl_teams[ab] = {
        "id": f"NHL-{ab}", "league": "NHL", "abbr": ab, "name": r["teamName"]["default"],
        "nickname": r["teamCommonName"]["default"], "city": r["placeName"]["default"],
        "division": r.get("divisionName", ""), "conference": r.get("conferenceName", ""),
        "logo_src": f"https://assets.nhle.com/logos/nhl/svg/{ab}_light.svg",
        "record": f"{r['wins']}-{r['losses']}-{r['otLosses']}", "pts": r["points"], "gp": r["gamesPlayed"],
    }

nhl_season_teams = {}  # season -> {abbr: name}
for y in range(FIRST_SEASON, CUR + 1):
    if y == CUR:
        nhl_season_teams[y] = {a: t["name"] for a, t in nhl_teams.items()}
        continue
    d = fetch_json(f"{NHL}/standings/{y + 1}-03-10")
    nhl_season_teams[y] = {r["teamAbbrev"]["default"]: r["teamName"]["default"] for r in d["standings"]}

log("NHL: rosters")
jobs = [(y, ab) for y, ts in nhl_season_teams.items() for ab in ts]
rosters_nhl = pool(lambda j: fetch_json(f"{NHL}/roster/{j[1]}/{'current' if j[0] == CUR else f'{j[0]}{j[0] + 1}'}",
                                        ttl=CUR_TTL if j[0] == CUR else None), jobs)

# ---------------------------------------------------------------- HockeyTech leagues
ht_seasons = {}  # league -> {year: season_id}
reg_year = defaultdict(dict)  # league -> {regular-season id: year}, every regular season in scope
for L in HT_LEAGUES:
    d = fetch_json(ht_url(L, feed="modulekit", view="seasons"), ttl=DAY)
    reg, pre = {}, {}
    for s in d["SiteKit"]["Seasons"]:
        nm = s["season_name"]
        if s.get("playoff") == "1":
            continue
        y = season_start(nm)
        if y is None or y < FIRST_SEASON or y > CUR:
            continue
        if re.search(r"pre-?season", nm, re.I):
            pre.setdefault(y, s["season_id"])
            continue
        if s.get("career") != "1" or re.search(r"tie ?break|prospect|all-?star|showcase|exhibition|challenge", nm, re.I):
            continue
        reg.setdefault(y, s["season_id"])
        reg_year[L][str(s["season_id"])] = y
    ht_seasons[L] = {"reg": reg, "pre": pre}
    log(f"  {L}: seasons {sorted(reg)}")


def ht_team_list(L, sid, ttl):
    d = fetch_json(ht_url(L, feed="modulekit", view="teamsbyseason", season_id=sid), ttl=ttl)
    out = []
    for t in d["SiteKit"].get("Teamsbyseason") or []:
        nm = (t.get("name") or "").strip()
        if not nm or nm.startswith("-") or re.search(r"\((OHL|QMJHL|LHJMQ|WHL|AHL|ECHL|CHL|NHL)\)", nm) \
                or re.search(r"all-?star|team (white|red|blue|black)|prospects", nm, re.I):
            continue
        city, nick = (t.get("city") or "").strip(), (t.get("nickname") or "").strip()
        if ", " in nm and city and nick:
            nm = f"{city} {nick}"
        out.append({"tid": str(t["id"]), "name": nm, "city": city, "nickname": nick, "code": t.get("code", ""),
                    "division": t.get("division_long_name") or t.get("division_short_name") or "",
                    "logo_src": t.get("team_logo_url") or ""})
    return out


def ht_roster(L, tid, sid, ttl):
    d = fetch_json(ht_url(L, feed="modulekit", view="roster", team_id=tid, season_id=sid), ttl=ttl)
    return [p for p in (d["SiteKit"].get("Roster") or []) if isinstance(p, dict) and "position" in p
            and p.get("player_id")]


log("HockeyTech: team lists")
ht_teams_by_season = {}  # (L, y) -> [team]
cur_sid = {}
jobs = []
for L, ss in ht_seasons.items():
    for y, sid in ss["reg"].items():
        jobs.append((L, y, sid))
res = pool(lambda j: ht_team_list(j[0], j[2], CUR_TTL if j[1] == CUR else None), jobs)
for (L, y, sid), teams in res.items():
    ht_teams_by_season[(L, y)] = teams or []

log("HockeyTech: rosters")
jobs = [(L, y, ss["reg"][y], t["tid"]) for L, ss in ht_seasons.items() for y in ss["reg"]
        for t in ht_teams_by_season[(L, y)]]
ht_rosters = pool(lambda j: ht_roster(j[0], j[3], j[2], CUR_TTL if j[1] == CUR else None), jobs)

# Leagues whose newest regular season has no rosters yet (e.g. PWHL before opening night) use the preseason.
for L, ss in ht_seasons.items():
    ycur = max(ss["reg"]) if ss["reg"] else None
    if ycur is None:
        continue
    n = sum(len(ht_rosters.get((L, ycur, ss["reg"][ycur], t["tid"])) or []) for t in ht_teams_by_season[(L, ycur)])
    if n < 20 and ycur in ss["pre"]:
        sid = ss["pre"][ycur]
        log(f"  {L}: {season_label(ycur)} regular season empty, using preseason {sid}")
        ht_teams_by_season[(L, ycur)] = ht_team_list(L, sid, CUR_TTL)
        for t in ht_teams_by_season[(L, ycur)]:
            ht_rosters[(L, ycur, sid, t["tid"])] = ht_roster(L, t["tid"], sid, CUR_TTL)
        ss["reg"][ycur] = sid
    cur_sid[L] = (ycur, ss["reg"][ycur])

# ---------------------------------------------------------------- current team nodes
nodes = {}
for ab, t in nhl_teams.items():
    nodes[t["id"]] = t
for L, (ycur, sid) in cur_sid.items():
    if ycur < CUR - 1:
        log(f"  {L}: no current season, skipping")
        continue
    for t in ht_teams_by_season[(L, ycur)]:
        roster = ht_rosters.get((L, ycur, sid, t["tid"])) or []
        if not roster:
            log(f"  {L}: skipping {t['name']} (empty roster, likely interlock placeholder)")
            continue
        nid = f"{L}-{t['tid']}"
        nodes[nid] = {"id": nid, "league": L, "abbr": t["code"], "name": t["name"], "nickname": t["nickname"],
                      "city": t["city"], "division": t["division"], "conference": "", "logo_src": t["logo_src"]}

# Interlock games put a few teams in two league feeds (e.g. Gatineau in both OHL and QMJHL).
# Keep each team in the league whose feed has carried it for the most seasons.
def seasons_in_feed(n):
    L, tid = n["league"], n["id"].split("-", 1)[1]
    return sum(1 for (l2, y), ts in ht_teams_by_season.items() if l2 == L and any(t["tid"] == tid for t in ts))


by_name = defaultdict(list)
dropped = set()
for n in nodes.values():
    if n["league"] != "NHL":
        by_name[norm(n["name"])].append(n)
for dups in by_name.values():
    if len(dups) > 1:
        dups.sort(key=seasons_in_feed, reverse=True)
        for n in dups[1:]:
            log(f"  dropping duplicate {n['id']} {n['name']} (belongs to {dups[0]['league']})")
            dropped.add((n["league"], n["id"].split("-", 1)[1]))
            del nodes[n["id"]]
log(f"nodes: {len(nodes)} teams")

# ---------------------------------------------------------------- identity + stints
strings, string_idx = [], {}


def sref(s):
    if s not in string_idx:
        string_idx[s] = len(strings)
        strings.append(s)
    return string_idx[s]


stints = defaultdict(dict)  # person-root -> {(season, ref): [gp, nameOverride]}
rows_by_elem = {}           # element -> latest roster row info (for bios)
current_rows = defaultdict(list)  # node id -> [element]


def add_stint(elem, season, ref, gp=None, nm=None):
    stints[elem].setdefault((season, ref), [None, nm])
    if gp:
        cur = stints[elem][(season, ref)][0] or 0
        stints[elem][(season, ref)][0] = max(cur, gp)


for (y, ab), d in rosters_nhl.items():
    if not d:
        continue
    nid = f"NHL-{ab}" if ab in nhl_teams else None
    tname = nhl_season_teams[y].get(ab, ab)
    for grp in ("forwards", "defensemen", "goalies"):
        for p in d.get(grp, []):
            el = f"NHL:{p['id']}"
            note_identity(el, "NHL", p["firstName"]["default"], p["lastName"]["default"], p.get("birthDate"))
            ref = nid if nid else f"off:{sref('NHL|' + tname)}"
            nm = tname if nid and tname != nodes[nid]["name"] else None
            add_stint(el, y, ref, nm=nm)
            if y == CUR and nid:
                current_rows[nid].append(el)
                rows_by_elem[el] = ("NHL", p)

for (L, y, sid, tid), roster in ht_rosters.items():
    if not roster or (L, tid) in dropped:
        continue
    nid = f"{L}-{tid}" if f"{L}-{tid}" in nodes else None
    tname = next((t["name"] for t in ht_teams_by_season.get((L, y), []) if t["tid"] == tid), None)
    if tname is None:
        continue  # interlock/preseason leftovers
    for p in roster:
        el = f"{L}:{p['player_id']}"
        dob = p.get("rawbirthdate") or p.get("birthdate") or ""
        note_identity(el, L, p.get("first_name", ""), p.get("last_name", ""), dob)
        ref = nid if nid else f"off:{sref(L + '|' + tname)}"
        nm = tname if nid and norm(tname) != norm(nodes[nid]["name"]) else None
        add_stint(el, y, ref, nm=nm)
        if y == cur_sid.get(L, (None,))[0] and nid and sid == cur_sid[L][1]:
            if str(p.get("active", "1")) != "0":
                current_rows[nid].append(el)
                rows_by_elem[el] = (L, p)

# merge stints by identity root
for g in name_groups.values():  # dedupe repeated rows (same player, many seasons) before pairing
    g[:] = list(dict.fromkeys(g))
link_identities()


# A player on two non-NHL current rosters (a junior trade or a pro assignment the old club hasn't
# cleared from its roster yet) plays for the club of his latest game this season. A stale listing he
# never played for this season is dropped. NHL rosters are authoritative (injuries, conditioning loans).
def ht_games(L, pid):
    d = fetch_json(ht_url(L, feed="modulekit", view="player", category="gamebygame", player_id=pid,
                          season_id=cur_sid[L][1]), ttl=CUR_TTL)
    return ((d or {}).get("SiteKit", {}).get("Player") or {}).get("games") or []


cur_by_root = defaultdict(list)
for nid, els in current_rows.items():
    if nodes[nid]["league"] != "NHL":
        for el in els:
            cur_by_root[find(el)].append((nid, el))
for r, lst in cur_by_root.items():
    if len({nid for nid, _ in lst}) < 2:
        continue
    last = {}  # node -> date of latest game
    for el in {el for _, el in lst}:
        L, pid = el.split(":", 1)
        for g in ht_games(L, pid):
            nid = f"{L}-{g.get('player_team')}"
            if any(n == nid for n, _ in lst):
                last[nid] = max(last.get(nid, ""), g.get("date_played") or "")
    if not last:
        continue  # no games yet: keep every listing
    keep = max(last, key=last.get)
    for nid, el in lst:
        if nid == keep:
            continue
        current_rows[nid].remove(el)
        if nid not in last:
            stints[el].pop((cur_sid[nodes[nid]["league"]][0], nid), None)
        log(f"  {el}: listed by {nodes[nid]['name']} too, but last played for {nodes[keep]['name']}")



# Season rosters are snapshots: a player traded during a season is missing from his old club's roster,
# and clubs list players who never got into a game (try-outs, extra goalies, juniors signed in spring).
# Each player's own season stats decide instead: a past team-season counts when he played games there.
# This season's roster listing stays (he is on the team now), plus any club he played for earlier on.
def ht_stats(el):
    L, pid = el.split(":", 1)
    ttl = CUR_TTL * 6 if el in cur_elems else (5 + sum(map(ord, pid)) % 4) * DAY  # past-only: spread refreshes
    d = fetch_json(ht_url(L, feed="modulekit", view="player", category="seasonstats", player_id=pid), ttl=ttl)
    return (d["SiteKit"].get("Player") or {}).get("regular") or []


cur_elems = {el for els in current_rows.values() for el in els}
elems_by_root = defaultdict(set)
for el in stints:
    elems_by_root[find(el)].add(el)
ht_jobs = sorted({el for r in {find(e) for e in cur_elems} for el in elems_by_root[r]
                  if el.split(":", 1)[0] in HT_LEAGUES})
log(f"HockeyTech: season stats for {len(ht_jobs)} player records")
ht_played = pool(ht_stats, ht_jobs)
n_add = n_drop = 0
for el, rows in ht_played.items():
    if rows is None:
        continue  # download failed: keep the roster view
    L = el.split(":", 1)[0]
    played = {}
    for row in rows:
        y, tid, gp = reg_year[L].get(str(row.get("season_id"))), str(row.get("team_id") or ""), row.get("games_played")
        gp = int(gp) if str(gp).isdigit() else 0
        if y is None or not tid or gp <= 0 or (L, tid) in dropped:
            continue
        tname = next((t["name"] for t in ht_teams_by_season.get((L, y), []) if t["tid"] == tid), None)
        tname = tname or (row.get("team_name") or "").strip()
        nid = f"{L}-{tid}"
        if nid in nodes:
            ref, nm = nid, (tname if tname and norm(tname) != norm(nodes[nid]["name"]) else None)
        elif tname:
            ref, nm = f"off:{sref(L + '|' + tname)}", None
        else:
            continue
        played[(y, ref)] = (max(played.get((y, ref), (0,))[0], gp), nm)
    for key, (gp, nm) in played.items():
        if key in stints[el]:
            stints[el][key][0] = max(stints[el][key][0] or 0, gp)
        else:
            stints[el][key] = [gp, nm]
            n_add += 1
    for key in [k for k in stints[el] if k[0] < cur_sid[L][0] and k not in played]:
        del stints[el][key]
        n_drop += 1
log(f"  {n_add} team-seasons added from player stats, {n_drop} roster listings without games dropped")

person_stints = defaultdict(dict)
person_elems = defaultdict(set)
for el, ss in stints.items():
    r = find(el)
    person_elems[r].add(el)
    for k, v in ss.items():
        cur = person_stints[r].get(k)
        if not cur:
            person_stints[r][k] = list(v)
        else:
            cur[0] = max(cur[0] or 0, v[0] or 0) or None
            cur[1] = cur[1] or v[1]

# ---------------------------------------------------------------- name aliases for NHL career lookups
alias_full = defaultdict(lambda: defaultdict(set))  # league -> alias -> {node}
alias_city = defaultdict(lambda: defaultdict(set))
for nid, n in nodes.items():
    L = n["league"]
    for a in (n["name"], f"{n['city']} {n['nickname']}"):
        alias_full[L][norm(a)].add(nid)
    if n["city"]:
        alias_city[L][norm(n["city"])].add(nid)
for (L, y), ts in ht_teams_by_season.items():
    for t in ts:
        nid = f"{L}-{t['tid']}"
        if nid in nodes:
            alias_full[L][norm(t["name"])].add(nid)
            if t["city"]:
                alias_city[L][norm(t["city"])].add(nid)
for y, ts in nhl_season_teams.items():
    for ab, nm in ts.items():
        if ab in nhl_teams:
            alias_full["NHL"][norm(nm)].add(f"NHL-{ab}")
alias_full["OHL"][norm("Sault Ste. Marie Greyhounds")] |= alias_full["OHL"].get(norm("Soo Greyhounds"), set())
_ntdp = {nid for nid, n in nodes.items() if n["league"] == "USHL" and "ntdp" in norm(n["name"])}
for a in ("USNTDP", "USNTDP Juniors", "US NTDP", "USNTDP U18", "USNTDP U17", "U.S. National U18 Team",
          "U.S. National U17 Team", "USA Hockey NTDP"):
    alias_full["USHL"][norm(a)] |= _ntdp
LEAGUE_ALIAS = {"LHJMQ": "QMJHL", "QMJHL": "QMJHL", "OHL": "OHL", "WHL": "WHL", "AHL": "AHL", "ECHL": "ECHL",
                "NHL": "NHL", "USHL": "USHL", "SPHL": "SPHL", "PWHL": "PWHL"}


# Names a prefix match would get wrong: St. John's (Newfoundland) is not Saint John (New Brunswick).
NOT_TEAM = {("QMJHL", "saintjohns"), ("AHL", "saintjohns"), ("ECHL", "saintjohns")}
prefix_matches = {}


def map_team(league, name):
    L = LEAGUE_ALIAS.get(league)
    if not L:
        return None
    n = norm(name)
    if (L, n) in NOT_TEAM:
        return None
    hit = alias_full[L].get(n)
    if hit and len(hit) == 1:
        return next(iter(hit))
    hit = alias_city[L].get(n)
    if hit and len(hit) == 1:
        return next(iter(hit))
    cands = {nid for a, ids in alias_full[L].items() if a.startswith(n) or (len(a) > 5 and n.startswith(a))
             for nid in ids}
    if len(cands) == 1:
        nid = cands.pop()
        prefix_matches[f"{L}|{name}"] = nodes[nid]["name"]
        return nid
    return None


# ---------------------------------------------------------------- NHL player careers (full history)
nhl_ids = sorted({int(el.split(":")[1]) for els in current_rows.values() for el in els if el.startswith("NHL:")})
# Current players elsewhere (AHL, ECHL, ...) who were on an NHL roster before: their NHL.com record
# checks those NHL seasons (it is not used for the rest of their career).
cur_roots = {find(el) for els in current_rows.values() for el in els}
past_nhl_ids = sorted({int(el.split(":")[1]) for r in cur_roots for el in person_elems[r]
                       if el.startswith("NHL:")} - set(nhl_ids))
log(f"NHL: {len(nhl_ids)} career histories, {len(past_nhl_ids)} former NHL players")
landings = pool(lambda pid: fetch_json(f"{NHL}/player/{pid}/landing", ttl=CUR_TTL * 6), nhl_ids + past_nhl_ids)


def nhl_ref(tn):
    nid = map_team("NHL", tn)
    if nid:
        return nid
    i = string_idx.get("NHL|" + tn)
    return f"off:{i}" if i is not None else None


def is_nhl(ref):
    return nodes[ref]["league"] == "NHL" if ref in nodes else strings[int(ref[4:])].startswith("NHL|")


def check_nhl_seasons(r, d):
    """NHL.com's past-season rosters include offseason moves: a June trade lists the player on his new
    club for the season just finished (and drops him from the old one). A past NHL season counts only if
    the player's own NHL.com record has games for that club that season."""
    played, unsure = set(), set()
    for s in d.get("seasonTotals", []):
        if s.get("leagueAbbrev") != "NHL":
            continue
        y, ref = int(str(s["season"])[:4]), nhl_ref((s.get("teamName") or {}).get("default", "").strip())
        if ref:
            played.add((y, ref))
        else:
            unsure.add(y)  # a name we can't place: leave that season alone
    for key in [k for k in person_stints[r] if k[0] < CUR and k[0] not in unsure and is_nhl(k[1])]:
        if key not in played:
            del person_stints[r][key]
            pruned.append(key)


unmapped = defaultdict(int)
pruned = []
past_set = set(past_nhl_ids)
for pid, d in landings.items():
    if not d:
        continue
    r = find(f"NHL:{pid}")
    check_nhl_seasons(r, d)
    leagues_with_data = defaultdict(set)
    for (y, ref) in person_stints[r]:
        leagues_with_data[y].add(nodes[ref]["league"] if ref in nodes else strings[int(ref[4:])].split("|")[0])
    for s in d.get("seasonTotals", []):
        if s.get("gameTypeId") != 2:
            continue
        y = int(str(s["season"])[:4])
        lg = (s.get("leagueAbbrev") or "").strip()
        if pid in past_set and (lg != "NHL" or y < FIRST_SEASON):
            continue  # former NHL players: only their NHL seasons, in the years their careers cover
        tn = (s.get("teamName") or {}).get("default", "").strip()
        if not tn or INTL_LEAGUES.match(lg) or INTL_EVENTS.search(f"{lg} {tn}"):
            continue
        nid = map_team(lg, tn)
        Lc = LEAGUE_ALIAS.get(lg)
        if nid:
            # keep a historical name (a relocated franchise: "Kootenay" is now Wenatchee), but not the
            # current team's own name, city or nickname
            cur_names = {norm(nodes[nid][k]) for k in ("name", "city", "nickname") if nodes[nid].get(k)}
            same = nid in _ntdp or any(c.startswith(norm(tn)) for c in cur_names)  # "Wilkes-Barre", "USNTDP"
            nm = tn if not same else None
            key = (y, nid)
            ex = person_stints[r].get(key)
            if ex:
                ex[0] = max(ex[0] or 0, s.get("gamesPlayed") or 0) or None
            else:
                person_stints[r][key] = [s.get("gamesPlayed"), nm]
        else:
            if Lc and Lc != "NHL" and y >= FIRST_SEASON and Lc in leagues_with_data[y]:
                continue  # already known from that league's own rosters
            if Lc:
                unmapped[f"{lg}|{tn}"] += 1
            key = (y, f"off:{sref((lg or '?') + '|' + tn)}")
            person_stints[r].setdefault(key, [s.get("gamesPlayed"), None])
log(f"  {len(pruned)} NHL roster listings without NHL games that season dropped")
if prefix_matches:
    log("  matched by name prefix:", ", ".join(f"{k} -> {v}" for k, v in sorted(prefix_matches.items())))
if unmapped:
    top = sorted(unmapped.items(), key=lambda kv: -kv[1])[:25]
    log("  unmapped in-scope teams (defunct/renamed):", ", ".join(f"{k}×{v}" for k, v in top))

# ---------------------------------------------------------------- reference data (coords, affiliates)
node_list = sorted(nodes.values(), key=lambda n: ([l["id"] for l in LEAGUES].index(n["league"]), n["name"]))
ref = reference.resolve(node_list, force=args.reference)
ovr = reference.overrides()
for nid, o in (ovr.get("teams") or {}).items():
    ref.setdefault(nid, {}).update(o)
aff = reference.table_affiliations(node_list, ref)
aff_info = reference.infobox_affiliations(node_list, ref)
for p in sorted(aff_info - aff):
    a, b = p
    la, lb = nodes[a]["league"], nodes[b]["league"]
    # fall back to infobox only for teams the league tables gave nothing for
    lower = a if [l["id"] for l in LEAGUES].index(la) > [l["id"] for l in LEAGUES].index(lb) else b
    upper_league = lb if lower == a else la
    if not any(lower in q and nodes[q[0] if q[1] == lower else q[1]]["league"] == upper_league for q in aff):
        aff.add(p)
for a, b in ovr.get("affiliations", {}).get("add", []):
    aff.add(tuple(sorted((a, b))))
for a, b in ovr.get("affiliations", {}).get("remove", []):
    aff.discard(tuple(sorted((a, b))))
missing = [n["id"] for n in node_list if ref.get(n["id"], {}).get("lat") is None]
if missing:
    log("  !! teams without coordinates (add to data/overrides.json):", missing)

# ---------------------------------------------------------------- logos
os.makedirs(LOGO_DIR, exist_ok=True)
try:
    from PIL import Image
except ImportError:
    Image = None


def get_logo(n):
    src = n.get("logo_src")
    if not src:
        return None
    ext = "svg" if src.endswith(".svg") else "png"
    rel = f"assets/logos/{n['id']}.{ext}"
    path = os.path.join(ROOT, rel)
    try:
        raw = fetch(src, binary=True, ttl=30 * DAY)
    except Exception as e:
        log("  logo fail", n["id"], e)
        return rel if os.path.exists(path) else None
    if ext == "png" and Image is not None:
        try:
            im = Image.open(io.BytesIO(raw)).convert("RGBA")
            bbox = im.getbbox()
            if bbox:
                im = im.crop(bbox)
            im.thumbnail((128, 128), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, "PNG", optimize=True)
            raw = buf.getvalue()
        except Exception as e:
            log("  logo resize fail", n["id"], e)
    with open(path, "wb") as f:
        f.write(raw)
    return rel


log("logos")
logos = pool(lambda nid: get_logo(nodes[nid]), [n["id"] for n in node_list], workers=6)
keep = {os.path.basename(v) for v in logos.values() if v}
for f in os.listdir(LOGO_DIR):  # stale logos only; subfolders (e.g. football/) belong to other builds
    if f not in keep and os.path.isfile(os.path.join(LOGO_DIR, f)):
        os.remove(os.path.join(LOGO_DIR, f))

# ---------------------------------------------------------------- output
team_index = {n["id"]: i for i, n in enumerate(node_list)}


def encode_ref(r):
    if r in team_index:
        return team_index[r]
    return -1 - int(r[4:])


players, player_index = [], {}


def bio(el):
    L, p = rows_by_elem[el]
    if L == "NHL":
        bc = [p.get("birthCity", {}).get("default"), (p.get("birthStateProvince") or {}).get("default"),
              p.get("birthCountry")]
        h = p.get("heightInInches")
        return {"name": f"{p['firstName']['default']} {p['lastName']['default']}",
                "pos": POS.get(p.get("positionCode"), p.get("positionCode")),
                "no": p.get("sweaterNumber"), "dob": p.get("birthDate") if valid_dob(p.get("birthDate")) else None, "from": ", ".join(x for x in bc if x),
                "sh": p.get("shootsCatches"), "ht": f"{h // 12}-{h % 12}" if h else None,
                "wt": p.get("weightInPounds"), "img": p.get("headshot"), "nhl": p["id"]}
    no = p.get("tp_jersey_number") or p.get("jersey_number")
    img = p.get("player_image") or ""
    return {"name": f"{p.get('first_name', '').strip()} {p.get('last_name', '').strip()}".strip(),
            "pos": POS.get((p.get("position") or "").upper(), p.get("position")),
            "no": int(no) if str(no).isdigit() else None,
            "dob": p.get("rawbirthdate") if valid_dob(p.get("rawbirthdate")) else None,
            "from": (p.get("birthplace") or p.get("hometown") or "").strip(" ,") or None,
            "sh": p.get("shoots") or p.get("catches") or None, "ht": p.get("height") or None,
            "wt": int(p["weight"]) if str(p.get("weight", "")).isdigit() else None,
            "img": img if img and "nophoto" not in img else None}


def draft_text(el):
    L, p = rows_by_elem[el]
    if L == "NHL":
        dd = (landings.get(p["id"]) or {}).get("draftDetails")
        if dd:
            return f"{dd['year']} R{dd['round']} #{dd['overallPick']} {dd['teamAbbrev']}", dd["teamAbbrev"]
        return None, None
    for di in p.get("draftinfo") or []:
        if di.get("draft_type") == "NHL" and di.get("draft_team"):
            ab = NHL_ABBR_FIX.get(di["draft_team"].strip(), di["draft_team"].strip())
            rnd = f" R{di['draft_round']}" if di.get("draft_round") else ""
            pick = f" #{di['draft_rank']}" if di.get("draft_rank") else ""
            return f"{di.get('draft_year', '')}{rnd}{pick} {ab}".strip(), ab
    nt = (p.get("nhlteam") or "").strip()
    if nt:
        ab = NHL_ABBR_FIX.get(nt, nt)
        return f"NHL rights: {ab}", ab
    return None, None


LEVEL = {l["id"]: i for i, l in enumerate(LEAGUES)}
by_root = defaultdict(list)
for nid in team_index:
    for el in current_rows.get(nid, []):
        by_root[find(el)].append((nid, el))

for r, lst in by_root.items():
    lst.sort(key=lambda t: LEVEL[nodes[t[0]]["league"]])
    nid0, el0 = lst[0]
    els = [el for _, el in lst]
    b = bio(next((e for e in els if e.startswith("NHL:")), el0))
    for e in els:  # fill gaps from other league records
        for k, v in bio(e).items():
            if b.get(k) in (None, "") and v not in (None, ""):
                b[k] = v
    dtext, dteam = None, None
    for e in [e for e in els if e.startswith("NHL:")] + els:
        dtext, dteam = draft_text(e)
        if dtext:
            break
    career = []
    for (y, rf), (gp, nm) in sorted(person_stints[r].items(), key=lambda kv: (kv[0][0], kv[0][1] in team_index)):
        row = [y, encode_ref(rf)]
        if gp or nm:
            row.append(gp or 0)
        if nm:
            row.append(sref(nm))
        career.append(row)
    rec = {"id": (f"n{b['nhl']}" if b.get("nhl") else els[0].replace(":", "-")), "n": b["name"], "p": b["pos"],
           "t": sorted({team_index[n] for n, _ in lst}), "c": career}
    for k_out, k_in in (("no", "no"), ("dob", "dob"), ("fr", "from"), ("sh", "sh"), ("ht", "ht"), ("wt", "wt"),
                        ("img", "img")):
        if b.get(k_in) not in (None, ""):
            rec[k_out] = b[k_in]
    if dtext:
        rec["dr"] = dtext
        if f"NHL-{dteam}" in team_index:
            rec["rt"] = team_index[f"NHL-{dteam}"]
    player_index[r] = len(players)
    players.append(rec)

teams_out = []
for n in node_list:
    rf = ref.get(n["id"], {})
    roster = sorted({player_index[find(el)] for el in current_rows.get(n["id"], [])},
                    key=lambda i: (("C", "LW", "RW", "F", "W", "D", "G").index(players[i]["p"])
                                   if players[i]["p"] in ("C", "LW", "RW", "F", "W", "D", "G") else 9,
                                   players[i]["n"]))
    t = {"id": n["id"], "lg": n["league"], "name": n["name"], "nick": n.get("nickname") or "",
         "city": n.get("city") or "", "abbr": n.get("abbr") or "", "div": n.get("division") or "",
         "conf": n.get("conference") or "", "lat": rf.get("lat"), "lng": rf.get("lng"),
         "arena": rf.get("arena"), "loc": rf.get("city"), "wiki": rf.get("wiki"),
         "logo": logos.get(n["id"]), "roster": roster}
    if n.get("record"):
        t["rec"] = n["record"]
        t["pts"] = n["pts"]
    teams_out.append(t)

out = {
    "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
    "season": season_label(CUR),
    "firstSeason": FIRST_SEASON,
    "leagues": [{k: l[k] for k in ("id", "name", "tier", "color")} for l in LEAGUES
                if any(t["lg"] == l["id"] for t in teams_out)],
    "teams": teams_out,
    "affiliations": sorted([team_index[a], team_index[b]] for a, b in aff if a in team_index and b in team_index),
    "strings": strings,
    "players": players,
}
write_json(os.path.join(DATA, "hockey.json"), out, compact=True)
size = os.path.getsize(os.path.join(DATA, "hockey.json"))
log(f"wrote data/hockey.json: {len(teams_out)} teams, {len(players)} players, {len(out['affiliations'])} "
    f"affiliations, {size / 1e6:.2f} MB")
