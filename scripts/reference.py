"""Resolve team locations + affiliations from Wikipedia (raw wikitext, cached).

resolve(nodes) -> {node_id: {wiki, arena, city, lat, lng, affiliates: [wiki titles]}}
Results persist in data/reference.json so normal refreshes only look up new teams.
Manual fixes live in data/overrides.json and always win.
"""
import os
import re
import urllib.parse

from common import DATA, LEAGUES, fetch, log, norm, read_json, write_json

WIKI = "https://en.wikipedia.org/wiki/"
REF_PATH = os.path.join(DATA, "reference.json")
OVR_PATH = os.path.join(DATA, "overrides.json")
LINK_RE = re.compile(r"\[\[([^\[\]|#]+)(?:#[^\[\]|]*)?(?:\|([^\[\]]*))?\]\]")


def wiki_raw(title, depth=0):
    """Raw wikitext for a title, following redirects. Returns (final_title, text) or (title, None)."""
    t = title.strip().replace(" ", "_")
    url = WIKI + urllib.parse.quote(t, safe="_()'%,.-") + "?action=raw"
    try:
        text = fetch(url, min_gap=0.7)
    except Exception as e:
        log("  wiki miss", title, e)
        return title, None
    m = re.match(r"\s*#redirect\s*\[\[([^\]|#]+)", text, re.I)
    if m and depth < 3:
        return wiki_raw(m.group(1), depth + 1)
    return title.replace("_", " "), text


def links(text):
    out = []
    for m in LINK_RE.finditer(text or ""):
        tgt = m.group(1).strip()
        if ":" in tgt and tgt.split(":")[0].lower() in ("file", "image", "category", "wikt", "w"):
            continue
        out.append((tgt, (m.group(2) or tgt).strip()))
    return out


def base(title):
    return re.sub(r"\s*\([^)]*\)\s*$", "", title)


def _num(s):
    try:
        return float(s)
    except ValueError:
        return None


def parse_coord(text):
    """First {{coord}} template in wikitext -> (lat, lng)."""
    for m in re.finditer(r"\{\{\s*coord\s*\|([^{}]*)\}\}", text or "", re.I):
        parts = [p.strip() for p in m.group(1).split("|")]
        parts = [p for p in parts if p and "=" not in p]
        vals = []
        for p in parts:
            if p.upper() in ("N", "S", "E", "W"):
                vals.append(p.upper())
            elif _num(p) is not None:
                vals.append(_num(p))
            else:
                break
        try:
            if "N" in vals or "S" in vals:
                i = vals.index("N") if "N" in vals else vals.index("S")
                lat_parts, rest = vals[:i], vals[i + 1:]
                j = rest.index("E") if "E" in rest else rest.index("W")
                lng_parts = rest[:j]
                lat = sum(v / 60 ** k for k, v in enumerate(lat_parts))
                lng = sum(v / 60 ** k for k, v in enumerate(lng_parts))
                if vals[i] == "S":
                    lat = -lat
                if rest[j] == "W":
                    lng = -lng
            else:
                lat, lng = vals[0], vals[1]
            if -90 <= lat <= 90 and -180 <= lng <= 180:
                return round(lat, 5), round(lng, 5)
        except (ValueError, IndexError, TypeError):
            continue
    return None


def infobox_field(text, field):
    m = re.search(r"^\s*\|\s*" + field + r"\s*=\s*(.*)$", text or "", re.I | re.M)
    if not m:
        return None
    v = m.group(1)
    v = re.sub(r"<ref[^>]*/>", "", v)
    v = re.sub(r"<ref.*?(</ref>|$)", "", v)
    return v.strip()


def plain(v):
    v = LINK_RE.sub(lambda m: (m.group(2) or m.group(1)), v or "")
    v = re.sub(r"\{\{[^{}]*\}\}", "", v)
    v = re.sub(r"<[^>]+>", " ", v)
    return re.sub(r"\s+", " ", v).replace("'''", "").replace("''", "").strip(" ,")


def league_tables(text):
    """Rows (list of link lists) from every wikitable in a league article."""
    rows = []
    for m in re.finditer(r"\{\|[^\n]*wikitable", text):
        end = text.find("\n|}", m.start())
        body = text[m.start(): end if end > 0 else len(text)]
        for chunk in re.split(r"\n\|-", body):
            ls = links(chunk)
            if ls:
                rows.append(ls)
    return rows


def find_title(node, league_links, suffix=""):
    """Pick the Wikipedia title for a team from its league article links (suffix: e.g. " football")."""
    name, nick, city, lg = norm(node["name"]), norm(node.get("nickname", "")), norm(node.get("city", "")), node["league"]
    sx = norm(suffix)
    strip = (lambda t: t[: -len(sx)] if sx and t.endswith(sx) else t)
    exact = []
    for tgt, txt in league_links:
        if strip(norm(base(tgt))) == name or norm(txt) == name:
            exact.append(tgt)
    if exact:
        exact.sort(key=lambda t: (f"({lg})" not in t and "(" in t, "(" not in t))
        return exact[0]
    if nick:
        cands = {tgt for tgt, txt in league_links if strip(norm(base(tgt))).endswith(nick) or norm(txt).endswith(nick)}
        if len(cands) > 1 and city:
            cands = {c for c in cands if city[:5] in norm(c)} or cands
        if len(cands) == 1:
            return cands.pop()
    return None


def resolve(nodes, force=False, leagues=None, ref_path=REF_PATH, ovr_path=OVR_PATH, suffix="", word="hockey"):
    """leagues: [{id, wiki}] (defaults to hockey's); suffix: added to team names for article guesses
    (" football" for college programs); word: a guessed article must mention it."""
    leagues = leagues or LEAGUES
    ref = {} if force else read_json(ref_path, {})
    fixed = {k for k, v in (overrides(ovr_path).get("teams") or {}).items() if v.get("lat") is not None}
    todo = [n for n in nodes if n["id"] not in fixed and (n["id"] not in ref or ref[n["id"]].get("lat") is None)]
    league_cache = {}
    if todo:
        log(f"reference: resolving {len(todo)} teams via Wikipedia")
    for n in todo:
        lg = n["league"]
        if lg not in league_cache:
            wiki = next(l["wiki"] for l in leagues if l["id"] == lg)
            _, text = wiki_raw(urllib.parse.unquote(wiki))
            league_cache[lg] = (links(text), league_tables(text or ""))
        llinks, _ = league_cache[lg]
        title = find_title(n, llinks, suffix)
        text = None
        if title:
            title, text = wiki_raw(title)
        if not text:
            for guess in ([f"{n['name']}{suffix}"] if suffix else []) + [n["name"], f"{n['name']} ({lg})"]:
                t2, tx = wiki_raw(guess)
                if tx and word in tx.lower():
                    title, text = t2, tx
                    break
        entry = {"wiki": title if text else None}
        if text:
            arena_v = infobox_field(text, "arena") or infobox_field(text, "stadium") or ""
            city_v = infobox_field(text, "city") or infobox_field(text, "location") or ""
            arena_links = links(arena_v)
            city_links = links(city_v)
            entry["arena"] = plain(arena_links[0][1]) if arena_links else plain(arena_v)[:60] or None
            entry["city"] = plain(city_v)[:80] or None
            entry["affiliates"] = [t for t, _ in links(infobox_field(text, "affiliates") or "")]
            coord = None
            if arena_links:
                _, atext = wiki_raw(arena_links[0][0])
                coord = parse_coord(atext)
            if not coord:
                coord = parse_coord(text)
            if not coord and city_links:
                _, ctext = wiki_raw(city_links[0][0])
                coord = parse_coord(ctext)
            if coord:
                entry["lat"], entry["lng"] = coord
        log(f"  {n['id']:<12} {n['name']:<34} -> {entry.get('wiki')} | {entry.get('arena')} | {entry.get('lat')},{entry.get('lng')}")
        ref[n["id"]] = entry
        if len(ref) % 25 == 0:
            write_json(ref_path, dict(sorted(ref.items())))  # keep progress if interrupted
    write_json(ref_path, dict(sorted(ref.items())))
    return ref


def table_affiliations(nodes, ref):
    """Affiliate pairs read from the AHL and ECHL league tables' affiliate columns."""
    title_to_id = {}
    for n in nodes:
        t = (ref.get(n["id"]) or {}).get("wiki")
        if t:
            title_to_id[t] = n["id"]
            title_to_id.setdefault(base(t), n["id"])
    by_id = {n["id"]: n for n in nodes}
    pairs = set()
    for lg in ("AHL", "ECHL"):
        wiki = next(l["wiki"] for l in LEAGUES if l["id"] == lg)
        _, text = wiki_raw(urllib.parse.unquote(wiki))
        for row in league_tables(text or ""):
            ids = []
            for tgt, _ in row:
                tid = title_to_id.get(tgt.strip()) or title_to_id.get(tgt.strip().replace("_", " "))
                if tid and tid not in ids:
                    ids.append(tid)
            if not ids or by_id[ids[0]]["league"] != lg:
                continue
            me = ids[0]
            for other in ids[1:]:
                ol = by_id[other]["league"]
                if (lg, ol) in (("AHL", "NHL"), ("ECHL", "NHL"), ("ECHL", "AHL")):
                    pairs.add(tuple(sorted((me, other))))
    return pairs


def infobox_affiliations(nodes, ref):
    title_to_id = {}
    for n in nodes:
        t = (ref.get(n["id"]) or {}).get("wiki")
        if t:
            title_to_id[t] = n["id"]
    by_id = {n["id"]: n for n in nodes}
    pairs = set()
    ok = {frozenset(("NHL", "AHL")), frozenset(("NHL", "ECHL")), frozenset(("AHL", "ECHL"))}
    for n in nodes:
        for t in (ref.get(n["id"]) or {}).get("affiliates") or []:
            o = title_to_id.get(t)
            if o and frozenset((n["league"], by_id[o]["league"])) in ok:
                pairs.add(tuple(sorted((n["id"], o))))
    return pairs


def overrides(path=OVR_PATH):
    return read_json(path, {"teams": {}, "affiliations": {"add": [], "remove": []}})
