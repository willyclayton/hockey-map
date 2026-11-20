# Hockey Atlas

An interactive map of every NHL, AHL, ECHL, SPHL, OHL, WHL, QMJHL, USHL and PWHL team, plus the players that tie them together.

- **Map with logos.** Every team sits at its home arena. Badge size shows the level and the ring color shows the league. Overlapping badges fan out so you can still see every one, and you can zoom and pan.
- **Affiliates.** NHL → AHL → ECHL organizations are drawn as lines. Click a team to light up its org.
- **Player web.** Two teams are linked whenever a player on one roster has played for the other. Click a team to see its whole web, with a shared-player count on every linked team.
- **Rosters and careers.** Every current player, with headshot, bio, draft info and a season-by-season career. Click a player to trace their route across the map.
- **Reunions.** Current teammates who already played together somewhere else.
- **Connection Rating (0–100).** How interconnected a roster is, ranked within its league. See *Rankings* in the app.
- **Filters.** League toggles (double-click one to show only that league), layer toggles, color by league or rating, a minimum-shared-players slider, and search across every team and player (press `/`).
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

## Data

`scripts/build_data.py` builds `data/hockey.json` and downloads logos into `assets/logos/`:

- **NHL:** api-web.nhle.com provides standings, rosters for every season since 2017-18, and full career histories for current NHL players.
- **AHL, ECHL, OHL, WHL, QMJHL, USHL, SPHL, PWHL:** the HockeyTech/LeagueStat feeds the league websites use. They provide rosters for every season since 2017-18.
- **Wikipedia:** arena coordinates and NHL/AHL/ECHL affiliations, cached in `data/reference.json`. Manual fixes go in `data/overrides.json`.

Within a league, players are linked by that league's player ID. Across leagues they're matched by last name and birth date. NHL players get their full career, including college and Europe. Everyone else gets matched seasons from 2017-18 on.

```bash
python3 scripts/build_data.py            # uses .cache/, refreshes current-season data after 12h
python3 scripts/build_data.py --refresh  # force fresh rosters
python3 scripts/build_data.py --reference  # re-resolve every arena/affiliation on Wikipedia
```

Python 3.9+ and the standard library are all it needs. Pillow is optional and shrinks the logos. The **Refresh hockey data** GitHub Action runs this every day and commits any changes, so the live site stays current.

## Running locally

It's a static site with no build step:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

D3 v7.9.0 and topojson-client 3.1.0 are vendored in `vendor/`. The base map in `data/na.topo.json` comes from Natural Earth 1:50m admin-1, with the lakes cut out.

---

An unofficial fan project, not affiliated with any league or team. Team names and logos are trademarks of their respective owners.
