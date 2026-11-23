# Hockey Atlas

**Now with Football:** switch *Sport → Football* in Map settings (or open `?sport=football`) for every NFL team and every NCAA Division I program (FBS + FCS), with the same webs, journeys, reunions, ratings and rankings.

An interactive map of every NHL, AHL, ECHL, SPHL, OHL, WHL, QMJHL, USHL and PWHL team, plus the players that tie them together.

- **Map with logos.** Every team sits at its home arena. Badge size shows the level and the ring color shows the league. Overlapping badges fan out so you can still see every one, and you can zoom and pan.
- **Affiliates.** NHL → AHL → ECHL organizations are drawn as lines. Click a team to light up its org.
- **Player web.** Two teams are linked whenever a player on one roster has played for the other. Click a team to see its whole web, with a shared-player count on every linked team.
- **Rosters and careers.** Every current player, with headshot, bio, draft info and a season-by-season career. Click a player to trace their route across the map.
- **Reunions.** Current teammates who already played together somewhere else.
- **Connection Rating (0–100).** How interconnected a roster is, ranked within its league. Every player gets a connection score too. See *Rankings* in the app.
- **Filters.** League toggles (double-click one to show only that league), layer toggles, color by league or rating, a minimum-shared-players slider, and search across every team and player (press `/`).
- **15-second welcome tour.** Five story-style slides (tap to skip, hold to pause) built from stills of the real site and animated with CSS. Shown on load until “Don't show this again” is ticked, never on shared links, and replayable from About. Refresh the stills with `node scripts/make_tour.js` while the site is served on :8765.
- **Shareable URLs.** `#t=NHL-TOR` opens a team and `#p=n8478402` opens a player.

## Connection Rating

Each component is turned into a percentile against the other teams in the same league, then blended:

| Component | Weight | What it measures |
|---|---|---|
| Reach | 35% | Number of teams on the map linked to the roster (players who came from there, or alumni now there) |
| Web strength | 25% | Total number of those player links |
| Reunions | 25% | Pairs of current teammates who were on the same team, in the same season, somewhere else |
| Pipeline | 15% | NHL/AHL/ECHL: share of the roster that played for the club's affiliates. Juniors: share that's NHL-drafted or has pro experience. SPHL/PWHL: share that has played for another team on the map |

The formula lives in `js/model.js` (`RATING_WEIGHTS`).

## Player connection score

Every player gets a 0–100 score too, ranked against players in the same league:

| Component | Weight | What it measures |
|---|---|---|
| Teammates | 40% | Active players they've shared a locker room with (same team, same season), not counting this season's current team |
| Locker rooms | 30% | Other teams on the map that have one of their former teammates right now |
| Map teams | 20% | Teams on the map they've played for |
| Leagues | 10% | Leagues on the map they've played in |

You'll find it in the player panel (with a list of where their former teammates are now), as a chip on every roster row (sort by "Connection score"), and in *Rankings → Players*. The weights are `PLAYER_WEIGHTS` in `js/model.js`.

## Data

`scripts/build_data.py` builds `data/hockey.json` and downloads logos into `assets/logos/`:

- **NHL:** api-web.nhle.com provides standings, rosters for every season since 2017-18, and full career histories for current NHL players.
- **AHL, ECHL, OHL, WHL, QMJHL, USHL, SPHL, PWHL:** the HockeyTech/LeagueStat feeds the league websites use. They provide rosters for every season since 2017-18.
- **Wikipedia:** arena coordinates and NHL/AHL/ECHL affiliations, cached in `data/reference.json`. Manual fixes go in `data/overrides.json`.

Within a league, players are linked by that league's player ID. Across leagues they're matched by last name and birth date. NHL players get their full career, including college and Europe (international tournaments are left out). Everyone else gets matched seasons from 2017-18 on.

Season rosters are snapshots, so they miss players traded mid-season and list some who never played. A past team-season therefore counts only when the player's own record has games there: NHL.com for NHL seasons, and the league's player stats for the HockeyTech leagues. This season's rosters decide the current team. A player still listed by a club he has left (a junior trade, say) is placed with the club of his latest game.

```bash
python3 scripts/build_data.py            # uses .cache/, refreshes current-season data after 12h
python3 scripts/build_data.py --refresh  # force fresh rosters
python3 scripts/build_data.py --reference  # re-resolve every arena/affiliation on Wikipedia
```

Python 3.9+ and the standard library are all it needs. Pillow is optional and shrinks the logos. The **Refresh hockey data** GitHub Action runs this every day and commits any changes, so the live site stays current.

## Football mode

`scripts/build_football.py` builds `data/football.json` from ESPN's public APIs: NFL and Division I teams and rosters, plus each player's college and NFL season logs. ESPN gives a player one id in college and the NFL, so careers connect exactly (first school → transfers → NFL teams). Stadium coordinates come from Wikipedia (`data/football_reference.json`, fixes in `data/football_overrides.json`); Hawaii is drawn as an inset. Football mode swaps hockey's pipeline measure for **Movers**: NFL "journeymen" (played for another NFL team) and college transfers.

## Running locally

It's a static site with no build step:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

D3 v7.9.0 and topojson-client 3.1.0 are vendored in `vendor/`. The base map in `data/na.topo.json` comes from Natural Earth 1:50m admin-1, with the lakes cut out.

---

An unofficial fan project, not affiliated with any league or team. Team names and logos are trademarks of their respective owners.
