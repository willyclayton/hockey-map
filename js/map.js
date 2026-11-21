// D3 map: geography, team badges, affiliate lines, the player web, hover previews, career routes
// and the camera.
//
// Layout: badges sit at their arena, nudged apart by a collision layout. The layout only depends on
// the zoom scale, so it is cached per zoom level (LEVEL steps of log2 k) and interpolated between
// levels while zooming: badges glide continuously, pans never re-run it, and a selection or filter
// change tweens from what is on screen to the new layout instead of jumping.

const RAMP = ['#104281', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb'];
export const ratingColor = d3.scaleLinear().domain(d3.range(RAMP.length).map((i) => (i / (RAMP.length - 1)) * 100)).range(RAMP).interpolate(d3.interpolateRgb).clamp(true);
export const RATING_RAMP = RAMP;

const K_MIN = 0.8, K_MAX = 14;
const LEVEL = 0.25;          // layout cache spacing, in log2(zoom)
const SEL_F = 1.35;          // selected badge scale
const PATH_F = 1.5;          // badges on the open player's route
const MOBILE = 760;
const LABEL_K = { NHL: 1.45, PWHL: 2.1, AHL: 2.2 }; // zoom at which a league's names start to appear
const LABEL_K_REST = 3.1;
const LABEL_FONT = { sel: [700, 14], hot: [600, 13], stop: [600, 12], rel: [600, 12], zoom: [600, 11.5] };
const ANCHOR = ['middle', 'middle', 'start', 'end']; // label sides: below, above, right, left
const STOP_ANGLES = [-135, -45, 180, 0, 135, 45, -90, 90].map((a) => (a * Math.PI) / 180);
const SVGNS = 'http://www.w3.org/2000/svg';

const mq = (q) => (window.matchMedia ? window.matchMedia(q) : { matches: false });
const reducedMQ = mq('(prefers-reduced-motion: reduce)');
const coarseMQ = mq('(pointer: coarse)');
const reduced = () => reducedMQ.matches;
// "2018-19" for one season, "2018–21" for a run, "Now" for the current team with no past seasons here
const yearSpan = (a, b) => (a == null ? 'Now' : a === b ? `${a}-${String(a + 1).slice(2)}` : `${a}–${String(b + 1).slice(2)}`);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = (v) => Math.round(v * 10) / 10;
const overlaps = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
const circleHitsRect = (x, y, r, b) => {
  const nx = clamp(x, b.x0, b.x1), ny = clamp(y, b.y0, b.y1);
  return (x - nx) ** 2 + (y - ny) ** 2 < r * r;
};

// Text widths for label collision, measured with the label font.
const measureCtx = document.createElement('canvas').getContext('2d');
const widths = new Map();
function textWidth(s, weight, size) {
  const key = `${weight}|${size}|${s}`;
  let w = widths.get(key);
  if (w == null) {
    measureCtx.font = `${weight} ${size}px "Barlow Condensed", Inter, system-ui, sans-serif`;
    w = measureCtx.measureText(s).width + s.length * size * 0.02; // letter-spacing .02em
    widths.set(key, w);
  }
  return w;
}

// Quadratic arc between two screen points, bending left of a→b.
function curve(a, b, bend) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  const off = Math.min(d * bend, 160);
  const cx = (a.x + b.x) / 2 - (dy / d) * off, cy = (a.y + b.y) / 2 + (dx / d) * off;
  return `M${r1(a.x)},${r1(a.y)}Q${r1(cx)},${r1(cy)} ${r1(b.x)},${r1(b.y)}`;
}

export class HockeyMap {
  constructor(el, model, topo, handlers) {
    this.el = el;
    this.model = model;
    this.topo = topo;
    this.h = handlers;
    this.visibleLeagues = new Set(model.leagues.map((l) => l.id));
    this.layers = { aff: true, web: true };
    this.colorMode = 'league';
    this.minShared = 1;
    this.sel = { team: null, player: null };
    this.hover = null;          // team under the pointer
    this.hl = null;             // team highlighted from outside the map (panel rows, search results)
    this.linkHover = null;
    this.preview = null;        // team whose web is previewed (hover with nothing selected)
    this.transform = d3.zoomIdentity;
    this.pos = new Map();       // team index -> {ax, ay, x, y, r, s, f}: arena + displayed position (screen px)
    this.cache = new Map();     // layout level -> Map(team index -> [dx, dy])
    this.seed = new Map();
    this.tw = null;             // layout tween {from, t0, dur}
    this.labels = new Map();    // team index -> {el, side, kind, fs, on}
    this.stops = [];
    this.stopGroups = [];
    this.hotLinks = [];
    this.pings = [];
    this.focus = null;
    this.camSeq = 0;
    this.selSeq = 0;
    this._camTok = 0;
    this.countRects = [];
    this.stopRects = [];
    this.badgeList = [];
    this.labelOrder = [...model.teams].sort((a, b) => b.baseR - a.baseR || b.rating - a.rating);
    this.init();
  }

  init() {
    const { el } = this;
    this.svg = d3.select(el).append('svg')
      .attr('class', 'map-svg')
      .attr('tabindex', 0)
      .attr('role', 'application')
      .attr('aria-roledescription', 'map')
      .attr('aria-label', 'Hockey team map. Arrow keys pan, plus and minus zoom, 0 resets the view.');
    this.defs = this.svg.append('defs');

    this.gGeo = this.svg.append('g').attr('class', 'geo');
    this.gAff = this.svg.append('g').attr('class', 'aff-layer');
    this.gWebGlow = this.svg.append('g').attr('class', 'web-glow-layer');
    this.gWeb = this.svg.append('g').attr('class', 'web-layer');
    this.gPreview = this.svg.append('g').attr('class', 'preview-layer');
    this.gPath = this.svg.append('g').attr('class', 'path-layer');
    this.gLeaders = this.svg.append('g').attr('class', 'leaders');
    this.leadDim = this.gLeaders.append('path').attr('class', 'leader dim').node();
    this.leadOn = this.gLeaders.append('path').attr('class', 'leader').node();
    this.anchorDim = this.gLeaders.append('path').attr('class', 'anchor dim').node();
    this.anchorOn = this.gLeaders.append('path').attr('class', 'anchor').node();
    this.gTeams = this.svg.append('g').attr('class', 'teams');
    this.gBadges = this.svg.append('g').attr('class', 'badges');
    this.gStops = this.svg.append('g').attr('class', 'stops');
    this.gLabels = this.svg.append('g').attr('class', 'labels');
    // HTML overlay for always-running effects (selection pulse, locator pings): composited, so they
    // never force the SVG to repaint.
    this.fx = d3.select(el).append('div').attr('class', 'map-fx').attr('aria-hidden', 'true');
    this.pulse = this.fx.append('div').attr('class', 'sel-pulse').attr('hidden', '');
    this.pulse.append('i');
    this.pulse.append('i');

    this.resize();
    this.drawGeo();
    this.zoom = d3.zoom()
      .scaleExtent([K_MIN, K_MAX])
      .constrain((t, ext) => this.constrain(t, ext))
      .clickDistance(5)
      .tapDistance(12)
      // long flights arc out and back in (van Wijk); short pans and zooms about a point stay straight
      .interpolate((a, b) => {
        const w = Math.max(a[2], b[2]);
        const pan = Math.hypot(b[0] - a[0], b[1] - a[1]) / w;
        return pan < 0.9 ? d3.interpolate(a, b) : d3.interpolateZoom(a, b);
      })
      .on('start', (e) => {
        if (!e.sourceEvent) return;
        this.gesture = true;
        this.camSeq++;
        this.cregion = this.viewRect();
        this.c0 = this.violation(this.transform);
      })
      .on('zoom', (e) => this.onZoom(e))
      .on('end', () => { this.gesture = false; this.c0 = null; this.scheduleSettle(); });
    this.svg.call(this.zoom)
      .on('dblclick.zoom', (e) => this.onDblClick(e))
      .on('wheel.zoom', (e) => this.onWheel(e), { passive: false })
      .on('pointermove.map', (e) => this.onPointerMove(e))
      .on('pointerleave.map', () => this.setPointerHit(null))
      .on('click.map', (e) => this.onClick(e))
      .on('keydown.map', (e) => this.onKey(e));
    window.addEventListener('resize', () => {
      clearTimeout(this._rt);
      this._rt = setTimeout(() => this.resize(true), 120);
    });
    document.fonts?.ready?.then(() => { widths.clear(); this.placeOverlays(); });
    this._panelOpen = document.body.classList.contains('panel-open');
    new MutationObserver(() => {
      const open = document.body.classList.contains('panel-open');
      if (open === this._panelOpen) return;
      this._panelOpen = open;
      clearTimeout(this._prT);
      this._prT = setTimeout(() => this.reconstrain(), 380);
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    this.invalidate(false);
    this.render();
  }

  resize(redraw) {
    const r = this.el.getBoundingClientRect();
    const sameW = Math.abs(r.width - this.w) < 1;
    this.w = r.width;
    this.h0 = r.height;
    this.svg.attr('viewBox', `0 0 ${this.w} ${this.h0}`);
    if (redraw && sameW && this.w < MOBILE) {
      // phone URL bar / keyboard: keep the projection so the map doesn't jump
      this.cregion = this.viewRect();
      this.placeOverlays();
      return;
    }
    const placed = this.model.teams.filter((t) => t.lat != null);
    const mobile = this.w < MOBILE;
    const top = mobile ? 170 : 128, pad = mobile ? 12 : 40;
    this.proj = d3.geoConicConformal().parallels([33, 55]).rotate([95, 0])
      .fitExtent([[pad, top], [this.w - pad, this.h0 - (mobile ? 30 : 40)]], { type: 'MultiPoint', coordinates: placed.map((t) => [t.lng, t.lat]) });
    this.path = d3.geoPath(this.proj);
    for (const t of this.model.teams) t.xy = t.lat != null ? this.proj([t.lng, t.lat]) : null;
    const xs = d3.extent(placed, (t) => t.xy[0]), ys = d3.extent(placed, (t) => t.xy[1]);
    this.bounds = [[xs[0] - 20, ys[0] - 20], [xs[1] + 20, ys[1] + 20]];
    this.sizeScale = Math.max(0.5, Math.min(1.1, Math.sqrt((this.w * this.h0) / (1500 * 900))));
    // Below this radius a badge is drawn as a plain league-colored dot (logos would be unreadable).
    this.tinyR = this.w < 760 ? 6.5 : 5.5;
    if (redraw) {
      this.gGeo.selectAll('*').remove();
      this.drawGeo();
      this.pos.clear();
      this.invalidate(false);
      this.render();
      this.cregion = this.viewRect();
      const c = this.constrain(this.transform);
      if (c !== this.transform) this.svg.call(this.zoom.transform, c);
    }
  }

  drawGeo() {
    const { topo } = this;
    const countries = topojson.feature(topo, topo.objects.countries);
    const states = topojson.feature(topo, topo.objects.states);
    const g = this.gGeo;
    g.append('path').attr('class', 'graticule').attr('d', this.path(d3.geoGraticule().step([10, 10])()));
    g.append('g').selectAll('path').data(countries.features.filter((f) => !['USA', 'CAN'].includes(f.properties.iso)))
      .join('path').attr('class', 'country other').attr('d', this.path);
    const usca = countries.features.filter((f) => ['USA', 'CAN'].includes(f.properties.iso));
    g.append('g').selectAll('path').data(usca).join('path').attr('class', 'coast-glow').attr('d', this.path);
    g.append('g').selectAll('path').data(states.features).join('path').attr('class', 'state').attr('d', this.path);
    g.append('g').selectAll('path').data(usca).join('path').attr('class', 'country').attr('d', this.path).style('fill', 'none');
    g.attr('transform', this.transform);
  }

  // ------------------------------------------------------------------ state setters
  setVisibleLeagues(set) { this.visibleLeagues = set; this.invalidate(true); this.render(); }
  setLayer(k, v) { this.layers[k] = v; this.render(); }
  setColorMode(m) { this.colorMode = m; this.render(); }
  setMinShared(n) { this.minShared = n; this.render(); }
  setSelection(sel) {
    const next = { team: sel.team ?? null, player: sel.player ?? null };
    const changed = next.team !== this.sel.team || next.player !== this.sel.player;
    this.sel = next;
    if (changed) {
      clearTimeout(this._pvT);
      this.preview = null;
      this.invalidate(true);
    }
    this.render();
    if (changed && next.team != null) {
      // A team picked on the map can end up under the side panel: nudge it out, unless the caller
      // already moved the camera.
      const seq = ++this.selSeq, cam = this.camSeq;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (seq === this.selSeq && cam === this.camSeq && !this.gesture) this.ensureVisible(next.team);
      }));
    }
  }

  /** Emphasize team i (halo, label, its link to the selected team) without selecting it; null clears. */
  highlightTeam(i) {
    i = i == null || !this.model.teams[i] ? null : i;
    if (i === this.hl) return;
    this.hl = i;
    this.applyEmphasis(true);
    if (i != null) this.ping(i);
  }

  /** Smoothly center team i in the visible part of the map, at zoom k (default: current zoom). */
  flyTo(i, { k, padRight, padBottom } = {}) {
    const t = this.model.teams[i];
    if (!t?.xy) return;
    const k1 = clamp(k ?? this.transform.k, K_MIN, K_MAX);
    const R = this.viewRect({ padRight, padBottom });
    const cx = (R.x0 + R.x1) / 2, cy = (R.y0 + R.y1) / 2;
    this.camera(d3.zoomIdentity.translate(cx - t.xy[0] * k1, cy - t.xy[1] * k1).scale(k1));
  }

  /** Redraw the selected player's route from the first stop. */
  replayRoute() {
    if (this.sel.player == null) return;
    this.gPath.selectAll('*').remove();
    this.gStops.selectAll('*').remove();
    this.renderPath();
    this.updatePositions();
    this.placeOverlays();
  }

  isVisible(t, path = this.sel.player != null ? this.pathTeams() : null) {
    if (t.xy == null) return false;
    if (this.visibleLeagues.has(t.lg)) return true;
    if (this.sel.team === t.i) return true;
    return !!path?.has(t.i);
  }

  visibleTeams() {
    const path = this.sel.player != null ? this.pathTeams() : null;
    return this.model.teams.filter((t) => this.isVisible(t, path));
  }

  zf(k) { return Math.max(0.85, Math.min(2.1, 0.7 + 0.3 * k)); }

  radius(t) {
    const p = this.pos.get(t.i);
    if (p) return p.r;
    return t.baseR * this.sizeScale * this.zf(this.transform.k) * this.sizeF(t.i);
  }

  // badge scale: the selected team, and every stop on an open player's route, are drawn bigger
  sizeF(i) { return i === this.sel.team ? SEL_F : this.pathSet?.has(i) ? PATH_F : 1; }

  pathTeams() {
    const p = this.sel.player != null ? this.model.players[this.sel.player] : null;
    return p ? new Set([...p.nodes, ...p.t]) : new Set();
  }

  // ------------------------------------------------------------------ layout
  /** Selection, filters or size changed: drop cached layouts and glide from what is on screen now. */
  invalidate(animate) {
    const from = new Map();
    for (const [i, p] of this.pos) from.set(i, { dx: p.x - p.ax, dy: p.y - p.ay, f: p.f });
    this.seed = new Map([...from].map(([i, o]) => [i, [o.dx, o.dy]]));
    this.cache.clear();
    this.pathSet = this.sel.player != null ? this.pathTeams() : null;
    this.visList = this.visibleTeams();
    this.visSet = new Set(this.visList.map((t) => t.i));
    for (const i of [...this.pos.keys()]) if (!this.visSet.has(i)) this.pos.delete(i);
    this.tw = animate && from.size && !reduced() ? { from, t0: performance.now(), dur: 560 } : null;
    if (this.hover != null && !this.visSet.has(this.hover)) this.setPointerHit(null);
  }

  // Collision layout at zoom k, in screen px relative to the arenas (translation-free). A small
  // grid-based relaxation: each pass pulls badges toward their arena and pushes overlapping ones
  // apart; the selected badge is heavy so its neighbours make room around it. Warm-started from
  // a nearby level it converges in a few passes.
  computeLayout(k, seed) {
    const vis = this.visList, n = vis.length, sel = this.sel.team, zf = this.zf(k);
    const X = new Float64Array(n), Y = new Float64Array(n), AX = new Float64Array(n), AY = new Float64Array(n);
    const R = new Float64Array(n), W = new Float64Array(n), PULL = new Float64Array(n);
    let maxR = 1;
    vis.forEach((t, i) => {
      AX[i] = t.xy[0] * k; AY[i] = t.xy[1] * k;
      const sd = seed?.get(t.i);
      X[i] = AX[i] + (sd ? sd[0] : 0); Y[i] = AY[i] + (sd ? sd[1] : 0);
      R[i] = t.baseR * this.sizeScale * zf * this.sizeF(t.i) + 1;
      W[i] = t.i === sel ? 0.06 : 1;
      PULL[i] = t.i === sel ? 0.5 : 0.1;
      if (R[i] > maxR) maxR = R[i];
    });
    const cell = maxR * 2, grid = new Map();
    const key = (gx, gy) => (gx + 4096) * 8192 + gy + 4096;
    const iters = seed?.size ? 70 : 160;
    for (let it = 0; it < iters; it++) {
      const relax = it < iters - 6; // the last passes only separate
      let moved = 0;
      if (relax) {
        for (let i = 0; i < n; i++) {
          const dx = (AX[i] - X[i]) * PULL[i], dy = (AY[i] - Y[i]) * PULL[i];
          X[i] += dx; Y[i] += dy;
          moved = Math.max(moved, Math.abs(dx), Math.abs(dy));
        }
      }
      grid.clear();
      for (let i = 0; i < n; i++) {
        const kk = key(Math.floor(X[i] / cell), Math.floor(Y[i] / cell));
        const list = grid.get(kk);
        if (list) list.push(i); else grid.set(kk, [i]);
      }
      for (let i = 0; i < n; i++) {
        const gx = Math.floor(X[i] / cell), gy = Math.floor(Y[i] / cell);
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const list = grid.get(key(gx + ox, gy + oy));
            if (!list) continue;
            for (const j of list) {
              if (j <= i) continue;
              let dx = X[j] - X[i], dy = Y[j] - Y[i];
              const min = R[i] + R[j], d2 = dx * dx + dy * dy;
              if (d2 >= min * min) continue;
              let d = Math.sqrt(d2);
              if (d < 1e-6) { const a = (i * 7 + j * 13) * 0.618; dx = Math.cos(a) * 0.01; dy = Math.sin(a) * 0.01; d = 0.01; }
              const push = ((min - d) / d) * 0.8, wi = W[i] / (W[i] + W[j]), wj = 1 - wi;
              X[i] -= dx * push * wi; Y[i] -= dy * push * wi;
              X[j] += dx * push * wj; Y[j] += dy * push * wj;
              if ((min - d) * 0.8 > moved) moved = (min - d) * 0.8;
            }
          }
        }
      }
      if (moved < 0.03 && it > 4) break;
    }
    const out = new Map();
    vis.forEach((t, i) => out.set(t.i, [X[i] - AX[i], Y[i] - AY[i]]));
    return out;
  }

  layoutLevel(L) {
    let m = this.cache.get(L);
    if (m) return m;
    // warm start from the nearest computed level so neighbouring zooms keep the same arrangement
    let seed = null, best = Infinity;
    for (const [l2, m2] of this.cache) if (Math.abs(l2 - L) < best) { best = Math.abs(l2 - L); seed = m2; }
    m = this.computeLayout(2 ** (L * LEVEL), seed || this.seed);
    this.cache.set(L, m);
    return m;
  }

  computePositions() {
    const tr = this.transform, k = tr.k;
    const Lf = Math.log2(k) / LEVEL, L0 = Math.floor(Lf), fr = Lf - L0;
    const m0 = this.layoutLevel(L0), m1 = fr > 1e-3 ? this.layoutLevel(L0 + 1) : m0;
    let tau = 1, tw = this.tw;
    if (tw) {
      const u = (performance.now() - tw.t0) / tw.dur;
      if (u >= 1) { this.tw = tw = null; this._twDone = true; } else tau = d3.easeCubicInOut(u);
    }
    const zf = this.zf(k), sel = this.sel.team;
    for (const t of this.visList) {
      const a = m0.get(t.i), b = m1.get(t.i) || a;
      let dx = a ? a[0] + (b[0] - a[0]) * fr : 0, dy = a ? a[1] + (b[1] - a[1]) * fr : 0;
      let f = this.sizeF(t.i);
      if (tw) {
        const s = tw.from.get(t.i);
        if (s) { dx = s.dx + (dx - s.dx) * tau; dy = s.dy + (dy - s.dy) * tau; f = s.f + (f - s.f) * tau; }
      }
      const ax = tr.applyX(t.xy[0]), ay = tr.applyY(t.xy[1]);
      let p = this.pos.get(t.i);
      if (!p) this.pos.set(t.i, (p = {}));
      p.ax = ax; p.ay = ay; p.x = ax + dx; p.y = ay + dy; p.f = f; p.s = zf * f; p.r = t.baseR * this.sizeScale * p.s;
    }
    this.delaunay = null;
  }

  /** Positions + DOM for the current transform; keeps itself running while a layout tween is active. */
  frame() {
    this.computePositions();
    this.updatePositions();
    if (this._twDone) { this._twDone = false; this.scheduleSettle(); }
    if (this.tw && !this._twRaf) this._twRaf = requestAnimationFrame(() => { this._twRaf = 0; this.frame(); });
  }

  scheduleSettle() {
    clearTimeout(this._settleT);
    this._settleT = setTimeout(() => this.settle(), 130);
  }

  settle() {
    if (this.tw || this.gesture) return;
    this.placeOverlays();
    this.prefetchLevels();
  }

  // compute the layouts just around the current zoom while idle, so the next zoom never waits on them
  prefetchLevels() {
    const L = Math.floor(Math.log2(this.transform.k) / LEVEL);
    const todo = [L + 1, L - 1, L + 2, L - 2, L + 3].filter((l) => 2 ** (l * LEVEL) >= K_MIN / 1.2 && 2 ** (l * LEVEL) <= K_MAX * 1.2 && !this.cache.has(l));
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 60));
    const step = () => {
      const l = todo.shift();
      if (l == null || this.gesture) return;
      this.layoutLevel(l);
      idle(step);
    };
    idle(step);
  }

  // ------------------------------------------------------------------ rendering
  render() {
    this.focus = this.focusSet();
    this.svg.classed('rating', this.colorMode === 'rating');
    this.computePositions();
    this.renderTeams();
    this.renderAff();
    this.renderWeb();
    this.renderPreview();
    this.renderPath();
    this.frame();
    this.applyEmphasis(false);
    this.placeOverlays();
  }

  teamStroke(t) {
    return this.colorMode === 'rating' ? ratingColor(t.rating) : t.color;
  }

  focusSet() {
    const s = this.sel;
    if (s.player != null) return this.pathTeams();
    if (s.team != null) {
      const t = this.model.teams[s.team];
      const set = new Set([t.i, ...t.affs]);
      for (const [o, e] of t.links) if (e.n >= this.minShared) set.add(o);
      return set;
    }
    return null;
  }

  renderTeams() {
    const self = this;
    const sel = this.sel.team;
    const vis = [...this.visList].sort((a, b) => a.baseR - b.baseR);
    const g = this.gTeams.selectAll('g.team:not(.leaving)').data(vis, (d) => d.i);
    const enter = g.enter().append('g').attr('class', 'team');
    enter.append('circle').attr('class', 'halo');
    enter.append('circle').attr('class', 'shadow');
    enter.append('circle').attr('class', 'disc');
    enter.each(function (d) {
      const s = d3.select(this);
      const abbr = () => s.insert('text', '.ring').attr('class', 'abbr').text((d.abbr || d.short).slice(0, 4));
      if (d.logo) {
        s.append('image').attr('href', d.logo).attr('preserveAspectRatio', 'xMidYMid meet')
          .on('error', function () { d3.select(this).remove(); abbr().style('font-size', `${Math.max(5, d.baseR * self.sizeScale * 0.62)}px`); });
      } else abbr();
    });
    enter.append('circle').attr('class', 'ring');
    if (this.pos.size && !reduced()) {
      enter.classed('entering', true).style('opacity', 0).transition().duration(320).style('opacity', null)
        .on('end interrupt', function () { this.classList.remove('entering'); });
    }
    g.exit().classed('leaving', true).interrupt().transition().duration(220).style('opacity', 0).remove();
    const all = enter.merge(g);
    all.order();
    const F = this.focus, rate = this.colorMode === 'rating';
    all.classed('selected', (d) => d.i === sel)
      .classed('dim', (d) => F != null && !F.has(d.i));
    all.each(function (d) {
      const r0 = d.baseR * self.sizeScale;
      this.style.setProperty('--c', self.teamStroke(d));
      if (rate && d.i !== sel) this.style.setProperty('--halo-o', (0.08 + 0.6 * (d.rating / 100) ** 2).toFixed(3));
      else this.style.removeProperty('--halo-o');
      if (this.__r0 === r0) return;
      this.__r0 = r0;
      const s = d3.select(this);
      s.select('.halo').attr('r', r0 + 3.5);
      s.select('.shadow').attr('r', r0 + 0.4).attr('cy', Math.max(1, r0 * 0.1));
      s.select('.disc').attr('r', r0);
      s.select('.ring').attr('r', r0);
      const sz = r0 * 1.42;
      s.select('image').attr('x', -sz / 2).attr('y', -sz / 2).attr('width', sz).attr('height', sz);
      s.select('text.abbr').style('font-size', `${Math.max(5, r0 * 0.62)}px`);
    });
    this.teamSel = all;
    this.teamNode = new Map();
    all.each(function (d) { self.teamNode.set(d.i, this); });
    // the selected badge on top; its pulse lives in the HTML overlay
    if (sel != null) this.teamNode.get(sel)?.parentNode.appendChild(this.teamNode.get(sel));
    this.pulse.attr('hidden', sel != null && this.teamNode.has(sel) ? null : '')
      .style('--c', sel != null ? this.teamStroke(this.model.teams[sel]) : null);
  }

  renderAff() {
    const { teams, affiliations } = this.model;
    const s = this.sel;
    const data = [];
    if ((this.layers.aff || s.team != null) && s.player == null) {
      for (const [a, b] of affiliations) {
        if (!this.visSet.has(a) || !this.visSet.has(b)) continue;
        const hot = s.team != null && (a === s.team || b === s.team);
        if (!this.layers.aff && !hot) continue;
        data.push({ a, b, hot, k: `${a}-${b}` });
      }
    }
    const dimmed = s.team != null || s.player != null;
    const sel = this.gAff.selectAll('g.affl').data(data, (d) => d.k);
    const en = sel.enter().append('g').attr('class', 'affl');
    en.append('path').attr('class', 'link aff-glow');
    en.append('path').attr('class', 'link aff-base');
    en.append('path').attr('class', 'link aff-flow');
    sel.exit().remove();
    this.affSel = en.merge(sel);
    this.affSel.classed('hot', (d) => d.hot).each(function (d) {
      const g = d3.select(this);
      const ta = teams[d.a], tb = teams[d.b];
      const upper = ta.baseR >= tb.baseR ? ta : tb;
      g.select('.aff-base')
        .attr('stroke', d.hot ? '#ffffff' : '#dbe7f7')
        .attr('stroke-width', d.hot ? 2.6 : 1.1)
        .attr('stroke-opacity', d.hot ? 0.95 : dimmed ? 0.06 : 0.32);
      g.select('.aff-glow').attr('stroke-width', d.hot ? 9 : 0);
      g.select('.aff-flow')
        .attr('stroke', upper.color)
        .attr('stroke-width', d.hot ? 2.6 : 0)
        .attr('stroke-opacity', d.hot ? 1 : 0)
        .classed('flow', d.hot);
    });
  }

  webData() {
    const { teams, pairs } = this.model;
    const s = this.sel;
    if (s.player != null) return [];
    if (s.team != null) {
      const t = teams[s.team];
      const out = [];
      for (const [o, e] of t.links) {
        if (!this.visSet.has(o)) continue;
        if (e.n < this.minShared && !t.affs.has(o)) continue;
        out.push({ e, from: t.i, to: o, hot: true });
      }
      return out.sort((x, y) => x.e.n - y.e.n);
    }
    if (!this.layers.web) return [];
    const out = [];
    for (const e of pairs) {
      if (e.n < Math.max(2, this.minShared)) break;
      if (!this.visSet.has(e.a) || !this.visSet.has(e.b)) continue;
      out.push({ e, from: e.a, to: e.b, hot: false });
      if (out.length >= 320) break;
    }
    return out.reverse();
  }

  renderWeb() {
    const { teams } = this.model;
    const data = this.webData();
    const max = Math.max(4, d3.max(data, (d) => d.e.n) || 1);
    const wScale = d3.scaleSqrt().domain([1, max]).range([1, 5.5]);
    const oScale = d3.scaleLinear().domain([1, max]).range([0.07, 0.42]);
    const color = (d) => (this.colorMode === 'rating' ? ratingColor(teams[d.to].rating) : teams[d.to].color);
    for (const d of data) d.w = d.hot ? wScale(d.e.n) : wScale(d.e.n) * 0.5;
    const sel = this.gWeb.selectAll('path.web').data(data, (d) => `${d.from}-${d.to}-${d.hot ? 1 : 0}`);
    sel.exit().remove();
    const en = sel.enter().append('path').attr('class', 'link web');
    const all = en.merge(sel);
    all.classed('hot', (d) => d.hot).classed('emph', false).each(function () { this.__emph = false; })
      .attr('stroke', (d) => (d.hot ? color(d) : '#7cc4ff'))
      .attr('stroke-width', (d) => d.w)
      .attr('stroke-opacity', (d) => (d.hot ? 0.82 : oScale(d.e.n)));
    all.order();
    if (!reduced()) {
      en.filter((d) => d.hot).attr('pathLength', 1).attr('stroke-dasharray', '1 1').attr('stroke-dashoffset', 1)
        .transition().duration(900).delay(() => 60 + Math.random() * 260).ease(d3.easeCubicOut).attr('stroke-dashoffset', 0)
        .on('end', function () { d3.select(this).attr('stroke-dasharray', null).attr('pathLength', null); });
    }
    this.webSel = all;
    this.hotLinks = data.filter((d) => d.hot).sort((a, b) => b.e.n - a.e.n);

    // a soft glow under the strongest links of the selected team
    const glow = this.hotLinks.filter((d) => d.e.n >= 2).slice(0, 6);
    const gs = this.gWebGlow.selectAll('path.web-glow').data(glow, (d) => `${d.from}-${d.to}`);
    gs.exit().remove();
    this.glowSel = gs.enter().append('path').attr('class', 'link web-glow').merge(gs)
      .attr('stroke', color).attr('stroke-width', (d) => d.w * 2.6 + 3);
  }

  renderPreview() {
    const { teams } = this.model;
    const i = this.preview;
    const data = [];
    if (i != null && this.visSet.has(i) && this.sel.team == null && this.sel.player == null) {
      const t = teams[i];
      for (const a of t.affs) if (this.visSet.has(a) && this.layers.aff) data.push({ from: i, to: a, aff: true, n: t.links.get(a)?.n || 1 });
      const top = [...t.links].filter(([o, e]) => this.visSet.has(o) && !t.affs.has(o) && e.n >= this.minShared)
        .sort((x, y) => y[1].n - x[1].n).slice(0, 8);
      for (const [o, e] of top) data.push({ from: i, to: o, aff: false, n: e.n });
    }
    const max = Math.max(4, d3.max(data, (d) => d.n) || 1);
    const w = d3.scaleSqrt().domain([1, max]).range([1.2, 4.5]);
    const sel = this.gPreview.selectAll('path.pv').data(data, (d) => `${d.from}-${d.to}`);
    sel.exit().remove();
    this.pvSel = sel.enter().append('path').attr('class', 'link pv').merge(sel)
      .classed('aff', (d) => d.aff)
      .attr('stroke', (d) => (d.aff ? '#eef3fa' : this.teamStroke(teams[d.to])))
      .attr('stroke-width', (d) => (d.aff ? 1.6 : w(d.n)));
    const peers = new Set(data.map((d) => d.to));
    if (this.teamSel) this.teamSel.classed('peer', (d) => peers.has(d.i));
    this.svg.classed('previewing', i != null && this.sel.team == null && this.sel.player == null);
    this.updateLinks(true);
  }

  // A player's career as a journey: legs draw one at a time with a puck riding the tip, each stop
  // pauses, pulses and gets a season tag, and a caption card follows along.
  renderPath() {
    const { players, teams } = this.model;
    const s = this.sel;
    this.stopJourney();
    let stops = [];
    if (s.player != null) {
      const p = players[s.player];
      const seq = [];
      for (const c of p.c) {
        const ref = c[1];
        if (ref < 0 || !this.visSet.has(ref)) continue;
        if (seq.length && seq[seq.length - 1].i === ref) { seq[seq.length - 1].to = c[0]; continue; }
        seq.push({ i: ref, from: c[0], to: c[0] });
      }
      for (const ti of p.t) if (this.visSet.has(ti) && !seq.some((x) => x.i === ti && x.to >= 2000)) seq.push({ i: ti, from: null, to: null });
      stops = seq;
    }
    this.stops = stops;
    // one tag per team, listing the seasons of every visit
    const groups = new Map();
    stops.forEach((d, n) => {
      let g = groups.get(d.i);
      if (!g) groups.set(d.i, (g = { i: d.i, ys: new Set(), first: n, ang: STOP_ANGLES[0], sup: 0 }));
      if (d.from != null) for (let y = d.from; y <= d.to; y++) g.ys.add(y);
    });
    for (const g of groups.values()) {
      // every season at this team, collapsed into runs: "2018–21", or "2017-18 · 2022-23" for a return
      const ys = [...g.ys].sort((a, b) => a - b), runs = [];
      for (const y of ys) { const r = runs[runs.length - 1]; if (r && y === r[1] + 1) r[1] = y; else runs.push([y, y]); }
      const spans = runs.map(([a, b]) => yearSpan(a, b));
      g.text = !spans.length ? 'Now' : spans.length > 2 ? `${spans[0]} · ${spans[spans.length - 1]}` : spans.join(' · ');
      g.w = Math.max(20, textWidth(g.text, 700, 11) + 12);
      g.h = 18;
    }
    this.stopGroups = []; // seasons live in the journey card (bottom right), not on the map
    const key = s.player;
    const segs = stops.slice(1).map((d, n) => ({ a: stops[n].i, b: d.i, n, key: `${key}:${n}` }));

    // timing: about a second per leg (longer legs a bit slower) plus a pause at every stop
    const calm = reduced();
    const P = (i) => this.pos.get(i);
    const DWELL = 520;
    let t = 350;
    const arrive = [t];
    segs.forEach((d) => {
      const pa = P(d.a), pb = P(d.b);
      const len = pa && pb ? Math.hypot(pb.x - pa.x, pb.y - pa.y) : 200;
      d.delay = t + DWELL;
      d.dur = Math.max(650, Math.min(1300, 520 + len * 1.1));
      t = d.delay + d.dur;
      arrive.push(t);
    });

    const ps = this.gPath.selectAll('g.seg').data(segs, (d) => d.key);
    ps.exit().remove();
    const pe = ps.enter().append('g').attr('class', 'seg');
    pe.append('path').attr('class', 'route-glow');
    pe.append('path').attr('class', 'route-line');
    if (!calm) {
      pe.selectAll('path').attr('pathLength', 1).attr('stroke-dasharray', '1 1').attr('stroke-dashoffset', 1)
        .transition().delay((d) => d.delay).duration((d) => d.dur)
        .ease(d3.easeCubicInOut).attr('stroke-dashoffset', 0)
        .on('end', function () { d3.select(this).attr('stroke-dasharray', null).attr('pathLength', null); });
    }
    this.pathSel = pe.merge(ps);

    const st = this.gStops.selectAll('g.path-stop').data(this.stopGroups, (d) => `${key}:${d.i}`);
    st.exit().remove();
    const se = st.enter().append('g').attr('class', 'path-stop');
    se.append('rect');
    se.append('text');
    se.style('opacity', 0);
    this.activeStop = null;
    this.stopSel = se.merge(st);
    this.stopSel.each(function (d) {
      this.style.setProperty('--c', teams[d.i].color);
      d3.select(this).select('rect').attr('x', -d.w / 2).attr('y', -d.h / 2).attr('width', d.w).attr('height', d.h).attr('rx', d.h / 2);
      d3.select(this).select('text').text(d.text);
    });

    if (!stops.length) { this.journeyCard(null); this.focusJourney(false); return; }
    const p = players[s.player];
    this.teamSel?.classed('on-route', (x) => this.pathSet?.has(x.i));
    this.focusJourney(true);
    if (calm) { this.journeyCard({ p, done: true }); return; }

    // the puck rides the tip of each leg
    const puck = this.gPath.append('circle').attr('class', 'route-puck').attr('r', 5.5).style('opacity', 0);
    const self = this;
    const at = (ms, fn) => this.jTimers.push(setTimeout(fn, ms));
    stops.forEach((d, n) => at(arrive[n], () => {
      const g = this.stopGroups.find((x) => x.i === d.i);
      this.showStopTag(g);
      this.ping(d.i);
      this.journeyCard({ p, n, d });
    }));
    segs.forEach((d) => at(d.delay - 120, () => this.showStopTag(null)));
    segs.forEach((d) => at(d.delay, () => {
      const path = this.pathSel?.filter((x) => x === d).select('.route-line').node();
      if (!path) return;
      puck.style('opacity', 1).interrupt().transition().duration(d.dur).ease(d3.easeCubicInOut)
        .attrTween('transform', () => (u) => {
          const L = path.getTotalLength();
          const q = path.getPointAtLength(L * u);
          return `translate(${q.x},${q.y})`;
        });
      void self;
    }));
    at(arrive[arrive.length - 1] + 1600, () => this.showStopTag(null));
    at(arrive[arrive.length - 1] + 900, () => { puck.transition().duration(300).style('opacity', 0).remove(); this.journeyCard({ p, done: true }); });
  }

  // While a route plays, everything off the route fades back; the next touch, drag, scroll or key on
  // the map brings it all back.
  focusJourney(on) {
    this.svg.classed('journey-mode', on);
    if (!on) this.journeyCard(null);
    if (this._jOff) { for (const [t, f] of this._jOff) this.el.removeEventListener(t, f, true); this._jOff = null; window.removeEventListener('keydown', this._jKey, true); }
    if (!on) return;
    const off = () => this.focusJourney(false);
    // ignore the tap that started playback (it bubbles up after this runs)
    setTimeout(() => {
      if (!this.svg.classed('journey-mode')) return;
      this._jOff = [['pointerdown', off], ['wheel', off]];
      for (const [t, f] of this._jOff) this.el.addEventListener(t, f, { capture: true, passive: true });
      this._jKey = (e) => { if (this.svg.node().contains(document.activeElement) || e.target === document.body) off(); };
      window.addEventListener('keydown', this._jKey, true);
    }, 0);
  }

  // Only the stop the puck just reached carries its season tag; the rest of the time tags are hidden
  // (the caption card and the panel carry the years), so they never sit on top of logos.
  showStopTag(g) {
    this.activeStop = g;
    if (this.stopSel) this.stopSel.interrupt().transition().duration(g ? 260 : 200).style('opacity', (x) => (x === g ? 1 : 0));
    this.placeStops();
    this.placeLabels();
  }

  stopJourney() {
    for (const id of this.jTimers || []) clearTimeout(id);
    this.jTimers = [];
    this.gPath.selectAll('.route-puck').interrupt().remove();
  }

  // The journey card: pinned bottom right of the visible map, updating in place as the puck arrives
  // (season, team, stop n of N, progress). It fades away with the route focus on the next map move.
  journeyCard(o) {
    let el = this.jCard;
    if (!o) { if (el) el.classList.remove('on'); return; }
    if (!el) {
      el = this.jCard = document.createElement('div');
      el.className = 'journey';
      el.setAttribute('aria-live', 'polite');
      el.innerHTML = '<div class="j-yr"></div><div class="j-row"><span class="j-logo"></span><span class="j-main"><span class="j-name"></span><span class="j-sub"></span></span><span class="j-step"></span></div><div class="j-bar"><i></i></div>';
      this.el.appendChild(el);
    }
    const { teams } = this.model;
    const total = this.stops.length;
    const q = (c) => el.querySelector(c);
    const setText = (c, v) => {
      const n = q(c);
      if (n.textContent === v) return;
      n.textContent = v;
      if (!reduced()) n.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
    };
    const logo = q('.j-logo');
    if (o.done) {
      const ys = o.p.c.map((c) => c[0]);
      setText('.j-yr', ys.length ? `${Math.min(...ys)}–${String(Math.max(...ys) + 1).slice(2)}` : '');
      setText('.j-name', o.p.n);
      setText('.j-sub', `${total} ${total === 1 ? 'stop' : 'stops'} on the map`);
      setText('.j-step', '');
      logo.hidden = true;
      q('.j-bar i').style.width = '100%';
    } else {
      const t = teams[o.d.i];
      const nm = o.d.from != null ? this.model.players[this.sel.player]?.c.find((c) => c[1] === o.d.i && c[0] === o.d.from)?.[3] : null;
      setText('.j-yr', o.d.from == null ? 'Now' : yearSpan(o.d.from, o.d.to));
      setText('.j-name', nm != null ? this.model.strings[nm] : t.name);
      setText('.j-sub', t.lg);
      setText('.j-step', `${o.n + 1} / ${total}`);
      logo.hidden = false;
      logo.style.setProperty('--c', t.color);
      logo.innerHTML = t.logo ? `<img src="${t.logo}" alt="">` : '';
      q('.j-bar i').style.width = `${((o.n + 1) / total) * 100}%`;
    }
    this.placeJourneyCard();
    el.classList.add('on');
  }

  // bottom right of the uncovered map: above the zoom/settings dock (desktop) or the bottom sheet (phone)
  placeJourneyCard() {
    const el = this.jCard;
    if (!el) return;
    const mr = this.el.getBoundingClientRect();
    let right = 14, bottom = 14;
    const sheet = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-h')) || 0;
    const panel = document.getElementById('panel');
    const panelOpen = document.body.classList.contains('panel-open') && panel && !panel.hidden;
    if (this.w < MOBILE) { right = 10; bottom = (panelOpen ? sheet : 0) + 10; }
    else {
      if (panelOpen) right = mr.right - panel.getBoundingClientRect().left + 14;
      const dock = document.getElementById('dock');
      const dr = dock && dock.getClientRects().length ? dock.getBoundingClientRect() : null;
      if (dr && dr.width) bottom = mr.bottom - dr.top + 10;
    }
    el.style.right = `${Math.round(right)}px`;
    el.style.bottom = `${Math.round(bottom)}px`;
  }


  // ------------------------------------------------------------------ per-frame DOM updates
  updatePositions() {
    const P = this.pos, sel = this.sel.team, tinyR = this.tinyR || 6.5, pathSet = this.pathSet;
    if (this.teamSel) {
      this.teamSel.each(function (d) {
        const p = P.get(d.i);
        if (!p) return;
        this.setAttribute('transform', `translate(${r1(p.x)},${r1(p.y)}) scale(${p.s.toFixed(3)})`);
        const tiny = p.r < tinyR && d.i !== sel && !pathSet?.has(d.i);
        if (this.__tiny !== tiny) { this.__tiny = tiny; this.classList.toggle('tiny', tiny); }
      });
    }
    this.updateLeaders();
    this.updateLinks(false);
    this.updateMarkers();
  }

  // Lines from a displaced badge back to its true location: two batched paths (focus + dimmed).
  updateLeaders() {
    let on = '', dim = '', ao = '', ad = '';
    const F = this.focus;
    for (const [i, p] of this.pos) {
      const dx = p.x - p.ax, dy = p.y - p.ay, d = Math.hypot(dx, dy);
      if (d < p.r + 2.5) continue;
      const ex = p.x - (dx / d) * p.r, ey = p.y - (dy / d) * p.r;
      const seg = `M${r1(p.ax)},${r1(p.ay)}L${r1(ex)},${r1(ey)}`, dot = `M${r1(p.ax)},${r1(p.ay)}h0`;
      if (F && !F.has(i)) { dim += seg; ad += dot; } else { on += seg; ao += dot; }
    }
    this.leadOn.setAttribute('d', on || 'M0,0');
    this.leadDim.setAttribute('d', dim || 'M0,0');
    this.anchorOn.setAttribute('d', ao || 'M0,0');
    this.anchorDim.setAttribute('d', ad || 'M0,0');
  }

  updateLinks(previewOnly) {
    const P = this.pos;
    const set = (sel, a, b, bend) => sel && sel.each(function (d) {
      const pa = P.get(d[a]), pb = P.get(d[b]);
      if (!pa || !pb) return;
      const c = curve(pa, pb, typeof bend === 'function' ? bend(d) : bend);
      if (this.tagName === 'g') for (const ch of this.children) ch.setAttribute('d', c);
      else this.setAttribute('d', c);
    });
    set(this.pvSel, 'from', 'to', 0.2);
    if (previewOnly) return;
    set(this.affSel, 'a', 'b', 0.12);
    set(this.webSel, 'from', 'to', (d) => (d.hot ? 0.2 : 0.16));
    set(this.glowSel, 'from', 'to', 0.2);
    set(this.pathSel, 'a', 'b', 0.22);
  }

  updateMarkers() {
    const P = this.pos;
    if (this.countSel) {
      this.countSel.each(function (d) {
        const p = P.get(d.i);
        if (p) this.setAttribute('transform', `translate(${r1(p.x + p.r * 0.74)},${r1(p.y - p.r * 0.74)})`);
      });
    }
    if (this.stopSel) {
      this.stopSel.each(function (d) {
        const p = P.get(d.i);
        if (!p) return;
        const dist = p.r + 2.5 + d.sup;
        this.setAttribute('transform', `translate(${r1(p.x + Math.cos(d.ang) * dist)},${r1(p.y + Math.sin(d.ang) * dist)})`);
      });
    }
    this.updateLabelPositions();
    this.updateFx();
  }

  updateLabelPositions() {
    for (const [i, o] of this.labels) {
      const p = this.pos.get(i);
      if (!p) continue;
      const [x, y] = this.labelXY(p, o.side, o.fs);
      o.el.setAttribute('x', r1(x + (o.dx || 0)));
      o.el.setAttribute('y', r1(y));
    }
  }

  updateFx() {
    const sel = this.sel.team;
    const p = sel != null ? this.pos.get(sel) : null;
    const node = this.pulse.node();
    if (p && !node.hidden) {
      node.style.translate = `${r1(p.x)}px ${r1(p.y)}px`;
      const d = Math.round(p.r * 2 + 2);
      if (node.__d !== d) { node.__d = d; node.style.setProperty('--d', `${d}px`); }
    }
    for (const o of this.pings) {
      const q = this.pos.get(o.i);
      if (!q) continue;
      o.el.style.translate = `${r1(q.x)}px ${r1(q.y)}px`;
      o.el.style.setProperty('--d', `${Math.round(q.r * 2 + 4)}px`);
    }
  }

  // label anchor point (baseline) for a side
  labelXY(p, side, fs) {
    if (side === 0) return [p.x, p.y + p.r + 2.5 + fs * 0.8];
    if (side === 1) return [p.x, p.y - p.r - 3.5 - fs * 0.2];
    if (side === 2) return [p.x + p.r + 4.5, p.y + fs * 0.32];
    return [p.x - p.r - 4.5, p.y + fs * 0.32];
  }

  labelRect(p, side, w, fs) {
    const [x, y] = this.labelXY(p, side, fs);
    const x0 = side === 2 ? x : side === 3 ? x - w : x - w / 2;
    return { x0: x0 - 2, x1: x0 + w + 2, y0: y - fs * 0.78 - 1.5, y1: y + fs * 0.22 + 1.5 };
  }

  // ------------------------------------------------------------------ overlays: counts, stops, labels
  onScreen(p, m = 0) {
    return p.x > -m && p.x < this.w + m && p.y > -m && p.y < this.h0 + m;
  }

  placeOverlays() {
    this.placedK = this.transform.k;
    this.placedAt = performance.now();
    this.badgeList = [];
    for (const [i, p] of this.pos) if (this.onScreen(p, 40)) this.badgeList.push({ i, p });
    this.labelBounds = this.viewRect({ raw: true });
    this.placeCounts();
    this.placeStops();
    this.placeLabels();
  }

  badgeOverlaps(rect, self) {
    let n = 0;
    for (const { i, p } of this.badgeList) if (i !== self && circleHitsRect(p.x, p.y, p.r + 1, rect)) n++;
    return n;
  }

  placeCounts() {
    const out = [];
    this.countRects = [];
    if (this.sel.team != null) {
      const mobile = this.w < MOBILE, minR = mobile ? 8 : 6, cap = mobile ? 14 : 60;
      for (const d of this.hotLinks) {
        if (out.length >= cap) break;
        const p = this.pos.get(d.to);
        if (!p || !this.onScreen(p, 10) || p.r < minR) continue;
        const txt = String(d.e.n);
        const w = Math.max(16, textWidth(txt, 700, 10.5) + 9), h = 16;
        const cx = p.x + p.r * 0.74, cy = p.y - p.r * 0.74;
        const rect = { x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 };
        if (this.countRects.some((q) => overlaps(q, rect))) continue;
        this.countRects.push(rect);
        out.push({ i: d.to, n: d.e.n, w, h, c: this.teamStroke(this.model.teams[d.to]) });
      }
    }
    const b = this.gBadges.selectAll('g.count-badge').data(out, (d) => d.i);
    b.exit().remove();
    const be = b.enter().append('g').attr('class', 'count-badge');
    be.append('rect');
    be.append('text');
    this.countSel = be.merge(b);
    this.countSel.each(function (d) {
      const s = d3.select(this);
      s.select('rect').attr('x', -d.w / 2).attr('y', -d.h / 2).attr('width', d.w).attr('height', d.h).attr('rx', d.h / 2).attr('stroke', d.c);
      s.select('text').text(d.n);
    });
    this.updateMarkers();
  }

  placeStops() {
    this.stopRects = [];
    for (const g of this.stopGroups) {
      if (g !== this.activeStop) continue;
      const p = this.pos.get(g.i);
      if (!p) continue;
      let best = null;
      for (const ang of STOP_ANGLES) {
        const sup = Math.abs(Math.cos(ang)) * (g.w / 2) + Math.abs(Math.sin(ang)) * (g.h / 2);
        const dist = p.r + 2.5 + sup;
        const cx = p.x + Math.cos(ang) * dist, cy = p.y + Math.sin(ang) * dist;
        const rect = { x0: cx - g.w / 2, x1: cx + g.w / 2, y0: cy - g.h / 2, y1: cy + g.h / 2 };
        let score = this.badgeOverlaps(rect, g.i) * 3;
        for (const q of this.stopRects) if (overlaps(q, rect)) score += 10;
        if (!best || score < best.score) best = { ang, sup, rect, score };
        if (score === 0) break;
      }
      g.ang = best.ang;
      g.sup = best.sup;
      this.stopRects.push(best.rect);
    }
    if (this.stopSel) this.updateMarkers();
  }

  // Greedy label placement: by priority, each label takes the first free side (below, above, right,
  // left); labels never overlap each other, count badges or route stops.
  placeLabels() {
    const { teams } = this.model;
    const s = this.sel, k = this.transform.k;
    const cands = [];
    const seen = new Set();
    const push = (i, kind) => {
      if (i == null || seen.has(i) || !this.pos.has(i)) return;
      seen.add(i);
      cands.push({ i, kind });
    };
    push(s.team, 'sel');
    push(this.hover ?? this.hl, 'hot');
    if (this.hover != null && this.hl != null) push(this.hl, 'hot');
    if (s.player != null) for (const st of this.stops) push(st.i, 'stop');
    if (s.team != null) {
      const t = teams[s.team];
      for (const a of t.affs) push(a, 'rel');
      const cap = k < 1.5 ? 8 : k < 3 ? 16 : 40;
      for (const d of this.hotLinks.slice(0, cap)) push(d.to, 'rel');
    }
    const F = this.focus;
    for (const t of this.labelOrder) {
      if (!this.visSet.has(t.i) || (F && !F.has(t.i))) continue;
      if (k >= (LABEL_K[t.lg] ?? LABEL_K_REST)) push(t.i, 'zoom');
    }

    const placed = [...this.countRects, ...this.stopRects];
    const B = this.labelBounds || { x0: 0, y0: 0, x1: this.w, y1: this.h0 };
    const out = [];
    const maxLabels = this.w < MOBILE ? 36 : 90;
    for (const c of cands) {
      if (out.length >= maxLabels && c.kind === 'zoom') break;
      const p = this.pos.get(c.i);
      const forced = c.kind === 'sel' || c.kind === 'hot';
      if (!forced && !this.onScreen(p, -4)) continue;
      const t = teams[c.i];
      const text = c.kind === 'zoom' && k < 3 ? t.short : t.name;
      const [wt, fs] = LABEL_FONT[c.kind];
      const w = textWidth(text, wt, fs);
      let best = null;
      for (let side = 0; side < 4; side++) {
        const rect = this.labelRect(p, side, w, fs);
        if (placed.some((q) => overlaps(q, rect))) continue;
        const off = rect.x0 < B.x0 + 2 || rect.x1 > B.x1 - 2 || rect.y0 < B.y0 + 2 || rect.y1 > B.y1 - 2;
        if (off && !forced) continue;
        const bo = this.badgeOverlaps(rect, c.i) + (off ? 50 : 0);
        if (!best || bo < best.bo) best = { side, rect, bo };
        if (bo === 0) break;
      }
      if (!best && forced) best = { side: 0, rect: this.labelRect(p, 0, w, fs), bo: 0 };
      if (!best || (c.kind === 'zoom' && best.bo > 0) || (c.kind === 'rel' && best.bo > 2)) continue;
      // a must-show label hanging off the visible area slides sideways back inside it
      let dx = 0;
      if (best.rect.x0 < B.x0 + 2) dx = B.x0 + 2 - best.rect.x0;
      else if (best.rect.x1 > B.x1 - 2) dx = B.x1 - 2 - best.rect.x1;
      if (dx) best.rect = { ...best.rect, x0: best.rect.x0 + dx, x1: best.rect.x1 + dx };
      placed.push(best.rect);
      out.push({ i: c.i, side: best.side, text, fs, kind: c.kind, dx });
    }
    this.applyLabels(out);
  }

  applyLabels(list) {
    const keep = new Set();
    const root = this.gLabels.node();
    for (const L of list) {
      let o = this.labels.get(L.i);
      if (!o) {
        const el = document.createElementNS(SVGNS, 'text');
        root.appendChild(el);
        o = { el };
        this.labels.set(L.i, o);
      }
      clearTimeout(o.t);
      if (o.text !== L.text) { o.el.textContent = L.text; o.text = L.text; }
      const cls = `team-label ${L.kind} on`;
      if (o.cls !== cls) { o.el.setAttribute('class', cls); o.cls = cls; }
      if (o.side !== L.side) o.el.setAttribute('text-anchor', ANCHOR[L.side]);
      o.side = L.side;
      o.fs = L.fs;
      o.dx = L.dx || 0;
      o.on = true;
      keep.add(L.i);
    }
    for (const [i, o] of this.labels) {
      if (keep.has(i) || !o.on) continue;
      o.on = false;
      o.cls = o.cls.replace(' on', '');
      o.el.setAttribute('class', o.cls);
      o.t = setTimeout(() => { if (!o.on) { o.el.remove(); this.labels.delete(i); } }, 240);
    }
    // labels of teams that left the map
    for (const [i, o] of this.labels) if (!this.pos.has(i)) { o.el.remove(); this.labels.delete(i); }
    this.updateLabelPositions();
  }

  // ------------------------------------------------------------------ hover + highlight
  applyEmphasis(placeLabels) {
    const f = this.hover ?? this.hl;
    const s = this.sel.team;
    if (this.teamSel) {
      this.teamSel.classed('hl', (d) => d.i === f);
      const node = f != null && f !== s ? this.teamNode.get(f) : null;
      const top = (s != null && this.teamNode.get(s)) || null;
      // lift above neighbours, but keep the selected badge on top
      if (node && node.nextSibling !== top) node.parentNode.insertBefore(node, top);
    }
    const linked = s != null && f != null && f !== s;
    let hasEmph = false;
    if (this.webSel) {
      this.webSel.each(function (d) {
        const on = linked && d.hot && d.to === f;
        if (on) hasEmph = true;
        if (on !== !!this.__emph) {
          this.__emph = on;
          this.classList.toggle('emph', on);
          this.setAttribute('stroke-width', on ? d.w + 2 : d.w);
          if (on) this.parentNode.appendChild(this);
        }
      });
    }
    this.gWeb.classed('has-emph', hasEmph);
    if (this.affSel) this.affSel.classed('emph', (d) => linked && ((d.a === s && d.b === f) || (d.b === s && d.a === f)));
    this.countSel?.classed('emph', (d) => linked && d.i === f);

    // preview the hovered team's web when nothing is selected (after a short hover intent)
    const want = s == null && this.sel.player == null ? f : null;
    if (want !== this.preview) {
      clearTimeout(this._pvT);
      const go = () => { this.preview = want; this.renderPreview(); };
      if (want == null || this.hover == null || this.hl === want) go();
      else this._pvT = setTimeout(go, 90);
    }
    if (placeLabels) this.placeLabels();
  }

  ping(i) {
    if (reduced() || !this.pos.has(i)) return;
    const el = document.createElement('div');
    el.className = 'ping';
    el.style.setProperty('--c', this.teamStroke(this.model.teams[i]));
    this.fx.node().appendChild(el);
    const o = { i, el };
    this.pings.push(o);
    const done = () => { el.remove(); this.pings = this.pings.filter((x) => x !== o); };
    el.addEventListener('animationend', done);
    setTimeout(done, 1200);
    this.updateFx();
  }

  // ------------------------------------------------------------------ pointer
  // Hit testing is nearest-badge within a radius, so small badges get a generous target
  // (>= 40px across on touch) without stealing clicks from the badges drawn next to them.
  nearest(x, y, coarse) {
    if (!this.delaunay) {
      this.dIdx = [...this.pos.keys()];
      this.delaunay = d3.Delaunay.from(this.dIdx, (i) => this.pos.get(i).x, (i) => this.pos.get(i).y);
      this._dj = 0;
    }
    if (!this.dIdx.length) return null;
    const j = this.delaunay.find(x, y, this._dj < this.dIdx.length ? this._dj : 0);
    this._dj = j;
    const i = this.dIdx[j], p = this.pos.get(i);
    const R = coarse ? Math.max(p.r + 6, 20) : p.r + 5;
    return Math.hypot(p.x - x, p.y - y) <= R ? i : null;
  }

  hitAt(e, src = e) {
    const tgt = src.target || e.target;
    const tn = tgt?.closest?.('g.team');
    if (tn && !tn.classList.contains('leaving') && tn.__data__) return { team: tn.__data__.i };
    const sn = tgt?.closest?.('g.path-stop');
    if (sn?.__data__) return { team: sn.__data__.i };
    const [x, y] = d3.pointer(src, this.svg.node());
    const pt = e.pointerType;
    const coarse = e.touches || e.changedTouches ? true : pt ? pt !== 'mouse' : coarseMQ.matches;
    const i = this.nearest(x, y, coarse);
    if (i != null) return { team: i };
    const ln = tgt?.closest?.('path.web.hot');
    if (ln?.__data__) return { link: ln.__data__ };
    return null;
  }

  onPointerMove(e) {
    if (e.pointerType === 'touch' || e.buttons) return;
    this.setPointerHit(this.hitAt(e), e);
  }

  setPointerHit(hit, e) {
    const team = hit?.team ?? null;
    const link = team == null ? hit?.link ?? null : null;
    if (team !== this.hover) {
      this.hover = team;
      this.h.onHover(team == null ? null : this.model.teams[team], e);
      this.applyEmphasis(true);
    } else if (team != null && e) this.h.onHover(this.model.teams[team], e);
    if (link !== this.linkHover) {
      const had = this.linkHover;
      this.linkHover = link;
      if (link) this.h.onLinkHover(link, e);
      else if (had && team == null) this.h.onLinkHover(null);
    } else if (link && e) this.h.onLinkHover(link, e);
    this.svg.classed('pointing', team != null || link != null);
  }

  onClick(e) {
    const now = performance.now();
    if (e.defaultPrevented || now - (this._dblAt || 0) < 350) return; // the tail of a double-tap
    const hit = this.hitAt(e);
    if (hit?.team != null) {
      clearTimeout(this._bgT);
      const again = this._tap && this._tap.i === hit.team && now - this._tap.t < 450;
      this._tap = { i: hit.team, t: now };
      if (e.detail > 1 || again) return; // second click of a double-click: zoom only
      e.stopPropagation();
      this.h.onTeam(hit.team);
      return;
    }
    if (hit?.link) { e.stopPropagation(); this.h.onTeam(hit.link.to); return; }
    if (e.detail > 1) return;
    clearTimeout(this._bgT);
    if (this.sel.team == null && this.sel.player == null) { this.h.onBackground(); return; }
    // wait a beat so a double-click on empty map zooms instead of clearing the selection
    this._bgT = setTimeout(() => this.h.onBackground(), 250);
  }

  onDblClick(e) {
    const now = performance.now();
    if (now - (this._dblAt || 0) < 400) return;
    this._dblAt = now;
    clearTimeout(this._bgT);
    e.preventDefault?.();
    const src = e.changedTouches ? e.changedTouches[0] : e;
    const hit = this.hitAt(e, src);
    const k = this.transform.k;
    if (hit?.team != null && !e.shiftKey) {
      this.flyTo(hit.team, { k: clamp(Math.max(k * 2, 3), K_MIN, K_MAX) });
      return;
    }
    const p = d3.pointer(src, this.svg.node());
    this.zoomAround(p, e.shiftKey ? 0.5 : 2, 520);
  }

  // Wheel: mouse wheels ease toward the target zoom; trackpads (small deltas) follow directly.
  onWheel(e) {
    e.preventDefault();
    const delta = -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002) * (e.ctrlKey ? 10 : 1);
    if (!delta) return;
    const p = d3.pointer(e, this.svg.node());
    this.camSeq++;
    if (reduced() || (!this._wheel && e.deltaMode === 0 && Math.abs(e.deltaY) < 40)) {
      this.zoom.scaleTo(this.svg, clamp(this.transform.k * 2 ** delta, K_MIN, K_MAX), p);
      return;
    }
    const base = this._wheel ? this._wheel.k : this.transform.k;
    this._wheel = { k: clamp(base * 2 ** delta, K_MIN, K_MAX), p };
    if (!this._wheelRaf) this._wheelRaf = requestAnimationFrame(() => this.wheelStep());
  }

  wheelStep() {
    this._wheelRaf = 0;
    const w = this._wheel;
    if (!w) return;
    const k0 = this.transform.k;
    let k = Math.exp(Math.log(k0) + (Math.log(w.k) - Math.log(k0)) * 0.24);
    if (Math.abs(Math.log(w.k / k)) < 0.003) { k = w.k; this._wheel = null; }
    this.zoom.scaleTo(this.svg, k, w.p);
    if (this._wheel) this._wheelRaf = requestAnimationFrame(() => this.wheelStep());
  }

  onKey(e) {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const step = (e.shiftKey ? 3 : 1) * Math.min(140, this.w * 0.12);
    const pan = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (pan) this.panBy(pan[0], pan[1]);
    else if (e.key === '+' || e.key === '=') this.zoomBy(1.5);
    else if (e.key === '-' || e.key === '_') this.zoomBy(1 / 1.5);
    else if (e.key === '0') this.resetView();
    else return;
    e.preventDefault();
    e.stopPropagation(); // the page-wide +/-/0 shortcut would zoom a second time
  }

  // ------------------------------------------------------------------ camera
  extent() { return [[0, 0], [this.w, this.h0]]; }

  // Keep the middle of the visible map (beside the panel, above the sheet) over the continent, so it
  // can't be flung off-screen or hidden under the panel. Any team can still be centered there.
  violation(t) {
    const b = this.bounds, R = this.cregion || (this.cregion = this.viewRect());
    const e = this.w < MOBILE ? 24 : 60;
    const sx0 = t.applyX(b[0][0]) - e, sx1 = t.applyX(b[1][0]) + e;
    const sy0 = t.applyY(b[0][1]) - e, sy1 = t.applyY(b[1][1]) + e;
    const cx = (R.x0 + R.x1) / 2, cy = (R.y0 + R.y1) / 2;
    return [cx < sx0 ? cx - sx0 : cx > sx1 ? cx - sx1 : 0, cy < sy0 ? cy - sy0 : cy > sy1 ? cy - sy1 : 0];
  }

  constrain(t) {
    if (!this.bounds) return t;
    let [dx, dy] = this.violation(t);
    // during a gesture, never snap: the view may not get worse than where the gesture started
    const c0 = this.c0;
    const soft = (d, d0) => (d0 && Math.sign(d) === Math.sign(d0) ? Math.sign(d) * Math.max(0, Math.abs(d) - Math.abs(d0)) : d);
    if (c0) { dx = soft(dx, c0[0]); dy = soft(dy, c0[1]); }
    return dx || dy ? d3.zoomIdentity.translate(t.x + dx, t.y + dy).scale(t.k) : t;
  }

  // the panel opened or closed: re-measure, and ease back if the view now sits off the continent
  reconstrain() {
    if (this.gesture || this.flying) return;
    this.cregion = this.viewRect();
    const c = this.constrain(this.transform);
    if (c !== this.transform) this.camera(c, { dur: 650 });
  }

  // Screen area not covered by the top bar, filter chips and the panel / bottom sheet.
  // raw: just what is uncovered (for label bounds), without the framing margins
  viewRect({ padRight, padBottom, raw = false } = {}) {
    const mobile = this.w < MOBILE;
    const mr = this.el.getBoundingClientRect();
    let chrome = 0;
    for (const q of ['.topbar', '.filters']) {
      const n = document.querySelector(q);
      if (!n || !n.getClientRects().length) continue;
      const r = n.getBoundingClientRect();
      if (r.height && r.bottom - mr.top < this.h0 * 0.4) chrome = Math.max(chrome, r.bottom - mr.top);
    }
    let top = Math.max(mobile ? 112 : 124, chrome + 12), right = mobile ? 10 : 64, bottom = mobile ? 64 : 60, left = mobile ? 10 : 24;
    const panel = document.getElementById('panel');
    const open = document.body.classList.contains('panel-open') && panel && !panel.hidden && panel.getClientRects().length;
    if (padRight == null && padBottom == null && open) {
      if (mobile) {
        const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-h'));
        padBottom = v > 0 ? v : Math.max(0, mr.bottom - panel.getBoundingClientRect().top);
      } else padRight = this.w - panel.offsetLeft + 16;
    }
    if (raw) return { x0: 0, y0: chrome, x1: this.w - (!mobile && padRight ? padRight - 12 : 0), y1: this.h0 - (padBottom || 0) };
    if (!mobile && padRight) right = Math.max(right, padRight + 44); // + the zoom buttons beside the panel
    if (padBottom) bottom = Math.max(bottom, padBottom + 12);
    let y1 = this.h0 - bottom;
    if (y1 - top < 90) y1 = Math.min(this.h0, top + 90);
    return { x0: left, x1: Math.max(left + 120, this.w - right), y0: top, y1 };
  }

  camera(tr, { dur, ease = d3.easeCubicInOut, point } = {}) {
    this.cregion = this.viewRect();
    this.c0 = null;
    tr = this.constrain(tr);
    this.camSeq++;
    this._wheel = null;
    if (reduced()) {
      this.svg.interrupt();
      this.svg.call(this.zoom.transform, tr);
      return;
    }
    if (dur == null) {
      const a = this.transform, c = [this.w / 2, this.h0 / 2], W = Math.max(this.w, this.h0);
      const i = d3.interpolateZoom([...a.invert(c), W / a.k], [...tr.invert(c), W / tr.k]);
      dur = clamp(i.duration * 0.8, 520, 1400);
    }
    const tok = ++this._camTok;
    this.camTarget = tr;
    this.flying = true;
    this.svg.transition().duration(dur).ease(ease).call(this.zoom.transform, tr, point)
      .on('end.cam interrupt.cam', () => { if (tok === this._camTok) this.flying = false; });
  }

  zoomAround(p, f, dur = 450) {
    const base = this.flying && this.camTarget ? this.camTarget : this.transform;
    const k1 = clamp(base.k * f, K_MIN, K_MAX);
    const [wx, wy] = base.invert(p);
    const tr = d3.zoomIdentity.translate(p[0] - wx * k1, p[1] - wy * k1).scale(k1);
    this.camera(tr, { dur, ease: d3.easeCubicOut, point: base === this.transform ? p : undefined });
  }

  panBy(dx, dy) {
    const base = this.flying && this.camTarget ? this.camTarget : this.transform;
    this.camera(d3.zoomIdentity.translate(base.x + dx, base.y + dy).scale(base.k), { dur: 280, ease: d3.easeCubicOut });
  }

  zoomBy(f) {
    const R = this.viewRect();
    this.zoomAround([(R.x0 + R.x1) / 2, (R.y0 + R.y1) / 2], f, 460);
  }

  resetView() {
    const open = document.body.classList.contains('panel-open');
    if (!open) { this.camera(d3.zoomIdentity, { dur: 800 }); return; }
    this.fitTeams(this.model.teams.filter((t) => t.xy).map((t) => t.i), { maxK: 1 });
  }

  fitTeams(indices, { maxK = 6, padRight, padBottom } = {}) {
    const pts = indices.map((i) => this.model.teams[i]).filter((t) => t?.xy).map((t) => t.xy);
    if (!pts.length) return;
    const R = this.viewRect({ padRight, padBottom });
    const m = this.w < MOBILE ? 18 : 48; // room for badges and labels around the edge teams
    const x0 = d3.min(pts, (p) => p[0]), x1 = d3.max(pts, (p) => p[0]);
    const y0 = d3.min(pts, (p) => p[1]), y1 = d3.max(pts, (p) => p[1]);
    const availW = Math.max(60, R.x1 - R.x0 - 2 * m), availH = Math.max(60, R.y1 - R.y0 - 2 * m);
    const k = clamp(Math.min(maxK, availW / Math.max(40, x1 - x0), availH / Math.max(40, y1 - y0)), K_MIN, K_MAX);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const sx = (R.x0 + R.x1) / 2, sy = (R.y0 + R.y1) / 2;
    this.camera(d3.zoomIdentity.translate(sx - cx * k, sy - cy * k).scale(k));
  }

  // Pan just enough to bring a team out from under the side panel (the phone sheet is main.js's call).
  ensureVisible(i) {
    const p = this.pos.get(i);
    if (!p || this.w < MOBILE) return;
    const R = this.viewRect();
    const m = p.r + 36;
    let dx = 0, dy = 0;
    if (p.x < R.x0 + m) dx = R.x0 + m - p.x; else if (p.x > R.x1 - m) dx = R.x1 - m - p.x;
    if (p.y < R.y0 + m) dy = R.y0 + m - p.y; else if (p.y > R.y1 - m) dy = R.y1 - m - p.y;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    const t = this.transform;
    this.camera(d3.zoomIdentity.translate(t.x + dx, t.y + dy).scale(t.k), { dur: 650 });
  }

  // ------------------------------------------------------------------ zoom events
  onZoom(e) {
    this.transform = e.transform;
    this.gGeo.attr('transform', e.transform);
    const se = e.sourceEvent;
    if (se && (se.type === 'mousemove' || se.type === 'touchmove') && this.hover != null) this.setPointerHit(null);
    this.frame();
    // while zooming, refresh label/badge placement a few times a second
    if (Math.abs(Math.log(this.transform.k / (this.placedK || 1))) > 0.15 && performance.now() - (this.placedAt || 0) > 220) this.placeOverlays();
    this.h.onZoom?.();
  }
}
