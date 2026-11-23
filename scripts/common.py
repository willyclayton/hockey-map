"""Shared helpers for the hockey-map data scripts (stdlib only)."""
import hashlib
import json
import os
import re
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
CACHE = os.environ.get("HOCKEY_CACHE", os.path.join(ROOT, ".cache"))
UA = "hockey-map-data/1.0 (static fan visualization)"

os.makedirs(CACHE, exist_ok=True)

_host_locks = {}
_host_last = {}
_lock = threading.Lock()


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def _throttle(url, min_gap):
    host = url.split("/")[2]
    with _lock:
        lk = _host_locks.setdefault(host, threading.Lock())
    with lk:
        last = _host_last.get(host, 0)
        wait = min_gap - (time.time() - last)
        if wait > 0:
            time.sleep(wait)
        _host_last[host] = time.time()


def fetch(url, ttl=None, binary=False, min_gap=0.0, retries=4, ok404=False):
    """GET a URL with an on-disk cache.

    ttl: seconds a cached copy stays fresh (None = forever).
    ok404: a 404 is an answer, not an error: remember it (same ttl) and return None.
    """
    h = hashlib.sha1(url.encode()).hexdigest()
    path = os.path.join(CACHE, h[:2], h)
    if ok404 and os.path.exists(path + ".404"):
        if ttl is None or time.time() - os.path.getmtime(path + ".404") < ttl:
            return None
    if os.path.exists(path):
        age = time.time() - os.path.getmtime(path)
        if ttl is None or age < ttl:
            with open(path, "rb") as f:
                raw = f.read()
            return raw if binary else raw.decode("utf-8", "replace")
    err = None
    for attempt in range(retries):
        if min_gap:
            _throttle(url, min_gap)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
            with urllib.request.urlopen(req, timeout=40) as r:
                raw = r.read()
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(raw)
            return raw if binary else raw.decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            err = e
            if e.code == 404 and ok404:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                open(path + ".404", "wb").close()
                return None
            if e.code in (404, 400, 403):
                break
            time.sleep(2 + attempt * 3)
        except Exception as e:  # network hiccup
            err = e
            time.sleep(2 + attempt * 3)
    raise RuntimeError(f"fetch failed {url}: {err}")


def fetch_json(url, ttl=None, min_gap=0.0, ok404=False):
    t = fetch(url, ttl=ttl, min_gap=min_gap, ok404=ok404)
    if t is None:
        return None
    t = t.strip()
    if t.startswith("(") and t.endswith(")"):
        t = t[1:-1]
    return json.loads(t)


def strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def norm(s):
    """Normalize a name for matching: lowercase, no accents, alnum only."""
    s = strip_accents(s or "").lower().replace("&", "and")
    s = s.replace("st.", "saint ").replace("ste.", "sainte ")
    return re.sub(r"[^a-z0-9]+", "", s)


def read_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj, compact=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")


# HockeyTech (LeagueStat) feeds power the AHL, ECHL, CHL leagues, USHL, SPHL and PWHL
# websites. These are the public client keys those sites ship to every browser.
HT = "https://lscluster.hockeytech.com/feed/index.php"
HT_LEAGUES = {
    "AHL": {"code": "ahl", "key": "50c2cd9b5e18e390"},
    "ECHL": {"code": "echl", "key": "2c2b89ea7345cae8"},
    "OHL": {"code": "ohl", "key": "f1aa699db3d81487"},
    "WHL": {"code": "whl", "key": "41b145a848f4bd67"},
    "QMJHL": {"code": "lhjmq", "key": "f322673b6bcae299"},
    "USHL": {"code": "ushl", "key": "e828f89b243dc43f"},
    "SPHL": {"code": "sphl", "key": "8fa10d218c49ec96"},
    "PWHL": {"code": "pwhl", "key": "694cfeed58c932ee"},
}

LEAGUES = [
    {"id": "NHL", "name": "National Hockey League", "tier": "Major pro", "color": "#3987e5",
     "wiki": "National_Hockey_League"},
    {"id": "AHL", "name": "American Hockey League", "tier": "Top minor pro", "color": "#d95926",
     "wiki": "American_Hockey_League"},
    {"id": "ECHL", "name": "ECHL", "tier": "Minor pro", "color": "#199e70", "wiki": "ECHL"},
    {"id": "SPHL", "name": "SPHL", "tier": "Minor pro", "color": "#c98500", "wiki": "SPHL"},
    {"id": "OHL", "name": "Ontario Hockey League", "tier": "Major junior (CHL)", "color": "#d55181",
     "wiki": "Ontario_Hockey_League"},
    {"id": "WHL", "name": "Western Hockey League", "tier": "Major junior (CHL)", "color": "#0ca30c",
     "wiki": "Western_Hockey_League"},
    {"id": "QMJHL", "name": "Quebec Maritimes Junior Hockey League", "tier": "Major junior (CHL)",
     "color": "#9085e9", "wiki": "Quebec_Maritimes_Junior_Hockey_League"},
    {"id": "USHL", "name": "United States Hockey League", "tier": "Junior (Tier I)", "color": "#e66767",
     "wiki": "United_States_Hockey_League"},
    {"id": "PWHL", "name": "Professional Women's Hockey League", "tier": "Women's pro",
     "color": "#c3c2b7", "wiki": "Professional_Women%27s_Hockey_League"},
]


def ht_url(league, **params):
    cfg = HT_LEAGUES[league]
    q = "&".join(f"{k}={v}" for k, v in params.items())
    return f"{HT}?{q}&key={cfg['key']}&client_code={cfg['code']}&fmt=json&lang=en"
