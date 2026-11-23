#!/usr/bin/env python3
"""Build data/football.json (NFL + NCAA Division I football) for the map's Football mode.

    python3 scripts/build_football.py            # uses .cache/
    python3 scripts/build_football.py --refresh  # re-download current rosters now

Sources (all public ESPN endpoints + Wikipedia):
  * Teams + current rosters: site.api.espn.com (NFL, FBS = group 80, FCS = group 81)
  * Careers: each player's NFL and college stats logs (sports.core.api.espn.com). ESPN uses one athlete id
    across college and the NFL, so a career runs straight from a first school, through transfers, to NFL teams.
  * Stadium coordinates: Wikipedia (cached in data/football_reference.json; fixes in data/football_overrides.json)
Output has the same shape as data/hockey.json, plus "sport": "football".
"""
import argparse
import concurrent.futures as cf
import datetime
import io
import os
import re
import sys
import zlib
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reference  # noqa: E402
from common import DATA, ROOT, fetch, fetch_json, log, norm, write_json  # noqa: E402

SITE = "https://site.api.espn.com/apis/site/v2/sports/football"
CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues"
DAY = 86400
LOGO_DIR = os.path.join(ROOT, "assets", "logos", "football")
LEAGUES = [
    {"id": "NFL", "name": "National Football League", "tier": "Pro", "color": "#3987e5", "wiki": "National_Football_League"},
    {"id": "FBS", "name": "NCAA Division I FBS", "tier": "College (FBS)", "color": "#d95926",
     "wiki": "List_of_NCAA_Division_I_FBS_football_programs"},
    {"id": "FCS", "name": "NCAA Division I FCS", "tier": "College (FCS)", "color": "#199e70",
     "wiki": "List_of_NCAA_Division_I_FCS_football_programs"},
]

ap = argparse.ArgumentParser()
ap.add_argument("--refresh", action="store_true")
ap.add_argument("--workers", type=int, default=12)
args = ap.parse_args()
CUR_TTL = 60 if args.refresh else DAY / 2


def log_ttl(pid):
    # career logs change slowly; spread expiry over 5-8 days so refreshes stay small
    return (5 + zlib.crc32(str(pid).encode()) % 4) * DAY


def pool(fn, items, workers=None, label=""):
    out, items = {}, list(items)
    with cf.ThreadPoolExecutor(max_workers=workers or args.workers) as ex:
        futs = {ex.submit(fn, it): it for it in items}
        for k, f in enumerate(cf.as_completed(futs)):
            try:
                out[futs[f]] = f.result()
            except Exception as e:  # noqa: BLE001
                out[futs[f]] = None
                if "404" not in str(e):
                    log("  !", futs[f], str(e)[:120])
            if label and (k + 1) % 2000 == 0:
                log(f"    {label}: {k + 1}/{len(items)}")
    return out


def ref_id(ref, kind):
    m = re.search(rf"/{kind}/(\d+)", ref or "")
    return m.group(1) if m else None


def team_info(league, tid, ttl=CUR_TTL):
    return fetch_json(f"{SITE}/{league}/teams/{tid}", ttl=ttl)["team"]


def statlog(league, pid):
    d = fetch_json(f"{CORE}/{league}/athletes/{pid}/statisticslog", ttl=log_ttl(pid), ok404=True)
    if d is None:  # no stats on file (never played): nothing to add
        return []
    out = []
    for e in d.get("entries", []):
        y = ref_id(e.get("season", {}).get("$ref"), "seasons")
        for st in e.get("statistics", []):
            if st.get("type") == "team":
                tid = ref_id(st.get("team", {}).get("$ref"), "teams")
                if y and tid:
                    out.append((int(y), tid))
    return out


def summary_div(t):
    s = t.get("standingSummary") or ""
    m = re.search(r"\bin (.+)$", s)
    return m.group(1).strip() if m else ""


# ---------------------------------------------------------------- teams
log("NFL teams")
nfl_list = fetch_json(f"{SITE}/nfl/teams", ttl=DAY)["sports"][0]["leagues"][0]["teams"]
nodes = {}
for x in nfl_list:
    t = x["team"]
    nodes[f"NFL-{t['id']}"] = {"id": f"NFL-{t['id']}", "league": "NFL", "espn": t["id"], "abbr": t.get("abbreviation", ""),
                               "name": t["displayName"], "nickname": t.get("name", ""), "city": t.get("location", ""),
                               "logo_src": (t.get("logos") or [{}])[0].get("href", "")}
nfl_detail = pool(lambda nid: team_info("nfl", nodes[nid]["espn"]), [n for n in nodes])
for nid, t in nfl_detail.items():
    if t:
        nodes[nid]["division"] = summary_div(t)
        rec = (t.get("record") or {}).get("items") or []
        if rec:
            nodes[nid]["record"] = rec[0].get("summary", "")

log("College teams (FBS + FCS)")
CUR = None
college_ids = {}
for lg, grp in (("FBS", 80), ("FCS", 81)):
    year = datetime.date.today().year
    for y in (year, year - 1):
        try:
            d = fetch_json(f"{CORE}/college-football/seasons/{y}/types/2/groups/{grp}/teams?limit=400", ttl=DAY)
            break
        except RuntimeError:
            continue
    for it in d.get("items", []):
        tid = ref_id(it.get("$ref"), "teams")
        if tid and tid not in college_ids:
            college_ids[tid] = lg
details = pool(lambda tid: team_info("college-football", tid), list(college_ids))
for tid, lg in college_ids.items():
    t = details.get(tid)
    if not t or not t.get("isActive", True) or re.search(r"all-?stars?\b|\ball star|\bstars$|^team |^(american|national|tba)$", t.get("displayName", ""), re.I):
        continue  # all-star game squads are listed alongside schools
    nid = f"{lg}-{tid}"
    rec = (t.get("record") or {}).get("items") or []
    nodes[nid] = {"id": nid, "league": lg, "espn": tid, "abbr": t.get("abbreviation", ""), "name": t["displayName"],
                  "nickname": t.get("name", ""), "city": t.get("location", ""), "division": summary_div(t),
                  "record": rec[0].get("summary", "") if rec else "",
                  "logo_src": (t.get("logos") or [{}])[0].get("href", "")}
log(f"  {sum(1 for n in nodes.values() if n['league'] == 'FBS')} FBS, {sum(1 for n in nodes.values() if n['league'] == 'FCS')} FCS")
by_espn = {("NFL" if n["league"] == "NFL" else "NCAA", n["espn"]): nid for nid, n in nodes.items()}

# ---------------------------------------------------------------- rosters
log("rosters")
rosters = pool(lambda nid: fetch_json(f"{SITE}/{'nfl' if nodes[nid]['league'] == 'NFL' else 'college-football'}/teams/{nodes[nid]['espn']}/roster", ttl=CUR_TTL), list(nodes))
people = {}           # espn athlete id -> bio
current = defaultdict(list)  # espn athlete id -> [node ids]
for nid, d in rosters.items():
    if not d:
        continue
    if CUR is None and nodes[nid]["league"] == "NFL":
        CUR = int((d.get("season") or {}).get("year") or datetime.date.today().year)
    for grp in d.get("athletes", []):
        if grp.get("position") == "suspended":
            continue
        for a in grp.get("items", []):
            pid = a["id"]
            if nid not in current[pid]:
                current[pid].append(nid)
            if pid not in people or nodes[nid]["league"] == "NFL":
                people[pid] = a
CUR = CUR or datetime.date.today().year
# anything listed as a team but carrying (almost) no roster is not a program (all-star squads, placeholders)
for nid in [nid for nid in nodes if sum(1 for ns in current.values() if nid in ns) < 15]:
    log(f"  dropping {nid} {nodes[nid]['name']} (no roster)")
    del nodes[nid]
    for pid in list(current):
        current[pid] = [n for n in current[pid] if n != nid]
        if not current[pid]:
            del current[pid]
            people.pop(pid, None)
by_espn = {("NFL" if n["league"] == "NFL" else "NCAA", n["espn"]): nid for nid, n in nodes.items()}
log(f"  {len(people)} players on {len(nodes)} rosters, season {CUR}")

# ---------------------------------------------------------------- careers
nfl_pids = [p for p, ns in current.items() if any(nodes[n]["league"] == "NFL" for n in ns)]
log(f"career logs: {len(nfl_pids)} NFL + {len(people)} college")
nfl_logs = pool(lambda pid: statlog("nfl", pid), nfl_pids, label="nfl logs")
col_logs = pool(lambda pid: statlog("college-football", pid), list(people), label="college logs")

# names for schools in careers that are not on the map (Division II/III, NAIA, defunct programs)
unknown = {tid for lg in col_logs.values() if lg for _, tid in lg if ("NCAA", tid) not in by_espn}
unknown |= {str((people[p].get("college") or {}).get("id")) for p in nfl_pids if (people[p].get("college") or {}).get("id")
            and ("NCAA", str(people[p]["college"]["id"])) not in by_espn}
log(f"  naming {len(unknown)} off-map schools")
off_names = pool(lambda tid: team_info("college-football", tid, ttl=60 * DAY).get("displayName"), sorted(unknown))

strings, sidx = [], {}


def sref(s):
    if s not in sidx:
        sidx[s] = len(strings)
        strings.append(s)
    return sidx[s]


def college_ref(tid, fallback_name=None):
    nid = by_espn.get(("NCAA", str(tid)))
    if nid:
        return nid
    nm = off_names.get(str(tid)) or fallback_name or f"School #{tid}"
    return f"off:{sref('NCAA|' + nm)}"


careers = {}
for pid, a in people.items():
    st = set()
    for y, tid in col_logs.get(pid) or []:
        st.add((y, college_ref(tid)))
    for y, tid in nfl_logs.get(pid) or []:
        nid = by_espn.get(("NFL", tid))
        if nid:
            st.add((y, nid))
    cur_nodes = current[pid]
    is_nfl = any(nodes[n]["league"] == "NFL" for n in cur_nodes)
    if is_nfl and not any(nodes[r]["league"] != "NFL" if r in nodes else True for _, r in st):
        col = a.get("college") or {}
        if col.get("id"):  # no college stats on file: place the school just before the rookie season
            exp = (a.get("experience") or {}).get("years") or 0
            st.add((CUR - int(exp) - 1, college_ref(col["id"], col.get("name"))))
    for n in cur_nodes:
        if not any(y == CUR and r == n for y, r in st):
            st.add((CUR, n))
    careers[pid] = st

# ---------------------------------------------------------------- reference: stadium coordinates
node_list = sorted(nodes.values(), key=lambda n: (["NFL", "FBS", "FCS"].index(n["league"]), n["name"]))
REF = os.path.join(DATA, "football_reference.json")
OVR = os.path.join(DATA, "football_overrides.json")
ref = reference.resolve([n for n in node_list if n["league"] == "NFL"], leagues=LEAGUES, ref_path=REF, ovr_path=OVR, word="football")
ref = reference.resolve([n for n in node_list if n["league"] != "NFL"], leagues=LEAGUES, ref_path=REF, ovr_path=OVR,
                        suffix=" football", word="football")
for nid, o in (reference.overrides(OVR).get("teams") or {}).items():
    ref.setdefault(nid, {}).update(o)
missing = [n["id"] for n in node_list if ref.get(n["id"], {}).get("lat") is None]
if missing:
    log(f"  !! {len(missing)} teams without coordinates (add to data/football_overrides.json):",
        ", ".join(f"{m} {nodes[m]['name']}" for m in missing))

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
    rel = f"assets/logos/football/{n['id']}.png"
    try:
        raw = fetch(src, binary=True, ttl=60 * DAY)
    except Exception as e:  # noqa: BLE001
        log("  logo fail", n["id"], e)
        return rel if os.path.exists(os.path.join(ROOT, rel)) else None
    if Image is not None:
        try:
            im = Image.open(io.BytesIO(raw)).convert("RGBA")
            if im.getbbox():
                im = im.crop(im.getbbox())
            im.thumbnail((112, 112), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, "PNG", optimize=True)
            raw = buf.getvalue()
        except Exception as e:  # noqa: BLE001
            log("  logo resize fail", n["id"], e)
    with open(os.path.join(ROOT, rel), "wb") as f:
        f.write(raw)
    return rel


log("logos")
logos = pool(lambda nid: get_logo(nodes[nid]), [n["id"] for n in node_list], workers=8)
keep = {os.path.basename(v) for v in logos.values() if v}
for f in os.listdir(LOGO_DIR):
    if f not in keep:
        os.remove(os.path.join(LOGO_DIR, f))

# ---------------------------------------------------------------- output
team_index = {n["id"]: i for i, n in enumerate(node_list)}
teams_out = []
for n in node_list:
    rf = ref.get(n["id"], {})
    lat, lng = rf.get("lat"), rf.get("lng")
    t = {"id": n["id"], "lg": n["league"], "name": n["name"], "nick": n.get("nickname") or "", "city": n.get("city") or "",
         "abbr": n.get("abbr") or "", "div": n.get("division") or "", "conf": "", "lat": lat, "lng": lng,
         "arena": rf.get("arena"), "loc": rf.get("city"), "wiki": rf.get("wiki"), "logo": logos.get(n["id"]), "roster": []}
    if lng is not None and lng < -140:  # Hawaii: drawn as an inset off the southwest coast, like most US maps
        t["lat"], t["lng"], t["inset"] = 27.2, -121.5, "Hawaii"
    if n.get("record"):
        t["rec"] = n["record"]
    teams_out.append(t)

POS = {"OT": "OL", "G": "OL", "OG": "OL", "T": "OL", "IOL": "OL", "DE": "DL", "DT": "DL", "NT": "DL", "EDGE": "DL",
       "ILB": "LB", "OLB": "LB", "MLB": "LB", "FS": "S", "SS": "S", "PK": "K"}
players = []
pindex = {}
for pid, a in people.items():
    cur = sorted({team_index[n] for n in current[pid] if n in team_index})
    if not cur:
        continue
    c = []
    now = set(current[pid])
    for y, r in sorted(careers[pid], key=lambda x: (x[0], x[1] in team_index and teams_out[team_index[x[1]]]["lg"] == "NFL", x[1] in now)):
        c.append([y, team_index[r] if r in team_index else -1 - int(r[4:])])
    pos = ((a.get("position") or {}).get("abbreviation") or "").upper()
    rec = {"id": f"f{pid}", "n": a.get("fullName") or a.get("displayName"), "p": POS.get(pos, pos), "t": cur, "c": c}
    if a.get("jersey"):
        rec["no"] = int(a["jersey"]) if str(a["jersey"]).isdigit() else a["jersey"]
    if a.get("dateOfBirth"):
        rec["dob"] = a["dateOfBirth"][:10]
    bp = (a.get("birthPlace") or {})
    fr = bp.get("displayText") or ", ".join(x for x in (bp.get("city"), bp.get("state")) if x)
    if fr:
        rec["fr"] = fr
    if a.get("height"):
        h = int(a["height"])
        rec["ht"] = f"{h // 12}-{h % 12}"
    if a.get("weight"):
        rec["wt"] = int(a["weight"])
    if (a.get("headshot") or {}).get("href"):
        rec["img"] = 1  # the page builds ESPN's headshot URL from the id
    xp = (a.get("experience") or {})
    if teams_out[cur[0]]["lg"] == "NFL":
        # NFL season number (the page spells it out). Counted from the first NFL season in the career log;
        # ESPN's experience field is often a season off, so it is only a fallback for players with no NFL stats.
        nfl_years = [y for y, r in careers[pid] if r in nodes and nodes[r]["league"] == "NFL" and y < CUR]
        rec["xp"] = CUR - min(nfl_years) + 1 if nfl_years else max(1, int(xp.get("years") or 0))
        col = (a.get("college") or {}).get("name")
        if col:
            rec["col"] = col
    elif xp.get("abbreviation"):
        rec["xp"] = xp["abbreviation"]  # FR / SO / JR / SR / GR
    pindex[pid] = len(players)
    players.append(rec)
    for i in cur:
        teams_out[i]["roster"].append(len(players) - 1)

ORDER = ["QB", "RB", "FB", "WR", "TE", "OL", "C", "DL", "LB", "CB", "S", "DB", "K", "P", "LS", "ATH"]
for t in teams_out:
    t["roster"].sort(key=lambda i: (ORDER.index(players[i]["p"]) if players[i]["p"] in ORDER else 99, players[i]["n"]))

seasons = [c[0] for p in players for c in p["c"]]
out = {
    "sport": "football",
    "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
    "season": str(CUR),
    "firstSeason": min(seasons) if seasons else CUR,
    "careerNote": "Seasons from ESPN's college and NFL stats logs (seasons a player recorded stats).",
    "leagues": [{k: l[k] for k in ("id", "name", "tier", "color")} for l in LEAGUES],
    "teams": teams_out,
    "affiliations": [],
    "strings": strings,
    "players": players,
}
write_json(os.path.join(DATA, "football.json"), out, compact=True)
size = os.path.getsize(os.path.join(DATA, "football.json"))
log(f"wrote data/football.json: {len(teams_out)} teams, {len(players)} players, {size / 1e6:.2f} MB")
