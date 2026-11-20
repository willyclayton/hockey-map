// D3 map: geography, team badges (semantic zoom + collision layout), affiliate lines, player web, career paths.

const RAMP = ['#104281', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb'];
export const ratingColor = d3.scaleLinear().domain(d3.range(RAMP.length).map((i) => (i / (RAMP.length - 1)) * 100)).range(RAMP).interpolate(d3.interpolateRgb).clamp(true);
export const RATING_RAMP = RAMP;

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
    this.hover = null;
    this.transform = d3.zoomIdentity;
    this.pos = new Map(); // team index -> {x, y} display position (screen)
    this.init();
  }

  init() {
    const { el } = this;
    this.svg = d3.select(el).append('svg').attr('role', 'img').attr('aria-label', 'Hockey team map');
    const defs = this.svg.append('defs');
    const glow = defs.append('filter').attr('id', 'glow').attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
    glow.append('feGaussianBlur').attr('stdDeviation', 3).attr('result', 'b');
    const fm = glow.append('feMerge');
    fm.append('feMergeNode').attr('in', 'b');
    fm.append('feMergeNode').attr('in', 'SourceGraphic');
    const shadow = defs.append('filter').attr('id', 'badge-shadow').attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
    shadow.append('feDropShadow').attr('dx', 0).attr('dy', 1.5).attr('stdDeviation', 2).attr('flood-color', '#000').attr('flood-opacity', 0.55);
    this.defs = defs;

    this.gGeo = this.svg.append('g').attr('class', 'geo');
    this.gAff = this.svg.append('g').attr('class', 'aff-layer');
    this.gWeb = this.svg.append('g').attr('class', 'web-layer');
    this.gPath = this.svg.append('g').attr('class', 'path-layer');
    this.gLeaders = this.svg.append('g').attr('class', 'leaders');
    this.gTeams = this.svg.append('g').attr('class', 'teams');
    this.gBadges = this.svg.append('g').attr('class', 'badges');
    this.gLabels = this.svg.append('g').attr('class', 'labels');
    this.gStops = this.svg.append('g').attr('class', 'stops');

    this.resize();
    this.drawGeo();
    this.zoom = d3.zoom().scaleExtent([0.7, 16])
      .on('zoom', (e) => this.onZoom(e))
      .on('end', () => this.relayout(true));
    this.svg.call(this.zoom).on('dblclick.zoom', null);
    this.svg.on('click', (e) => {
      if (e.target === this.svg.node() || e.target.closest('.geo')) this.h.onBackground();
    });
    window.addEventListener('resize', () => {
      clearTimeout(this._rt);
      this._rt = setTimeout(() => { this.resize(true); }, 120);
    });
    this.relayout(false);
    this.render();
  }

  resize(redraw) {
    const r = this.el.getBoundingClientRect();
    this.w = r.width;
    this.h0 = r.height;
    this.svg.attr('viewBox', `0 0 ${this.w} ${this.h0}`);
    const pts = this.model.teams.filter((t) => t.lat != null).map((t) => [t.lng, t.lat]);
    const mobile = this.w < 760;
    const top = mobile ? 170 : 128, pad = mobile ? 12 : 40;
    this.proj = d3.geoConicConformal().parallels([33, 55]).rotate([95, 0])
      .fitExtent([[pad, top], [this.w - pad, this.h0 - (mobile ? 30 : 40)]], { type: 'MultiPoint', coordinates: pts });
    this.path = d3.geoPath(this.proj);
    for (const t of this.model.teams) t.xy = t.lat != null ? this.proj([t.lng, t.lat]) : null;
    this.sizeScale = Math.max(0.5, Math.min(1.1, Math.sqrt((this.w * this.h0) / (1500 * 900))));
    if (redraw) {
      this.gGeo.selectAll('*').remove();
      this.drawGeo();
      this.relayout(false);
      this.render();
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
  setVisibleLeagues(set) { this.visibleLeagues = set; this.relayout(true); this.render(); }
  setLayer(k, v) { this.layers[k] = v; this.render(); }
  setColorMode(m) { this.colorMode = m; this.render(); }
  setMinShared(n) { this.minShared = n; this.render(); }
  setSelection(sel) {
    this.sel = { team: sel.team ?? null, player: sel.player ?? null };
    this.relayout(true);
    this.render();
  }

  isVisible(t) {
    if (t.xy == null) return false;
    if (this.visibleLeagues.has(t.lg)) return true;
    const s = this.sel;
    if (s.team === t.i) return true;
    if (s.player != null && this.pathTeams().has(t.i)) return true;
    return false;
  }

  visibleTeams() { return this.model.teams.filter((t) => this.isVisible(t)); }

  radius(t) {
    const k = this.transform.k;
    const zf = Math.max(0.85, Math.min(2.1, 0.7 + 0.3 * k));
    let r = t.baseR * this.sizeScale * zf;
    if (this.sel.team === t.i) r *= 1.35;
    return r;
  }

  pathTeams() {
    const p = this.sel.player != null ? this.model.players[this.sel.player] : null;
    return p ? new Set([...p.nodes, ...p.t]) : new Set();
  }

  // ------------------------------------------------------------------ layout
  onZoom(e) {
    const prev = this.transform;
    this.transform = e.transform;
    this.gGeo.attr('transform', e.transform);
    // keep collision offsets (scaled a little) while moving
    const ratio = e.transform.k / prev.k;
    for (const t of this.model.teams) {
      const p = this.pos.get(t.i);
      if (!p || !t.xy) continue;
      const [ax, ay] = this.transform.apply(t.xy);
      const dx = (p.x - p.ax) * Math.min(1, ratio), dy = (p.y - p.ay) * Math.min(1, ratio);
      p.ax = ax; p.ay = ay; p.x = ax + dx; p.y = ay + dy;
    }
    this.updatePositions(false);
    this.h.onZoom?.();
  }

  relayout(animate) {
    const vis = this.visibleTeams();
    const nodes = vis.map((t) => {
      const [ax, ay] = this.transform.apply(t.xy);
      const prev = this.pos.get(t.i);
      return { t, ax, ay, x: prev ? prev.x : ax, y: prev ? prev.y : ay, r: this.radius(t) };
    });
    const sim = d3.forceSimulation(nodes)
      .force('x', d3.forceX((d) => d.ax).strength((d) => (d.t.i === this.sel.team ? 0.9 : 0.22)))
      .force('y', d3.forceY((d) => d.ay).strength((d) => (d.t.i === this.sel.team ? 0.9 : 0.22)))
      .force('c', d3.forceCollide((d) => d.r + 1.6).strength(0.85).iterations(3))
      .stop();
    for (let i = 0; i < 160; i++) sim.tick();
    const next = new Map();
    for (const n of nodes) next.set(n.t.i, { ax: n.ax, ay: n.ay, x: n.x, y: n.y, r: n.r });
    this.pos = next;
    this.updatePositions(animate);
  }

  P(i) { return this.pos.get(i); }

  // ------------------------------------------------------------------ rendering
  render() {
    this.renderTeams();
    this.renderAff();
    this.renderWeb();
    this.renderPath();
    this.renderLabels();
    this.updatePositions(false);
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
    const vis = this.visibleTeams().sort((a, b) => a.baseR - b.baseR || (a.i === this.sel.team) - (b.i === this.sel.team));
    const focus = this.focusSet();
    const self = this;
    const g = this.gTeams.selectAll('g.team').data(vis, (d) => d.i);
    const enter = g.enter().append('g').attr('class', 'team').attr('tabindex', -1)
      .on('mouseenter', function (e, d) { self.hover = d.i; self.h.onHover(d, e); self.renderLabels(); })
      .on('mousemove', (e, d) => this.h.onHover(d, e))
      .on('mouseleave', () => { this.hover = null; this.h.onHover(null); this.renderLabels(); })
      .on('click', (e, d) => { e.stopPropagation(); this.h.onTeam(d.i); });
    enter.append('circle').attr('class', 'halo');
    enter.append('circle').attr('class', 'disc').attr('filter', 'url(#badge-shadow)');
    enter.each(function (d) {
      const s = d3.select(this);
      if (d.logo) {
        s.append('image').attr('href', d.logo).attr('preserveAspectRatio', 'xMidYMid meet')
          .on('error', function () { d3.select(this).remove(); s.append('text').attr('class', 'abbr').text(d.abbr || d.short.slice(0, 3)); });
      } else {
        s.append('text').attr('class', 'abbr').text((d.abbr || d.short).slice(0, 4));
      }
    });
    enter.append('circle').attr('class', 'ring').attr('fill', 'none');
    g.exit().remove();
    const all = enter.merge(g);
    all.order();
    all.classed('selected', (d) => d.i === this.sel.team)
      .classed('dim', (d) => focus != null && !focus.has(d.i));
    all.each(function (d) {
      const r = self.radius(d);
      const s = d3.select(this);
      const c = self.teamStroke(d);
      const rate = self.colorMode === 'rating';
      s.select('.halo').attr('r', r + 4).attr('stroke', c)
        .style('opacity', rate && d.i !== self.sel.team ? 0.08 + 0.6 * (d.rating / 100) ** 2 : null);
      s.select('.disc').attr('r', r);
      s.select('.ring').attr('r', r).attr('stroke', c).style('stroke-width', rate ? '4px' : null);
      const sz = r * 1.42;
      s.select('image').attr('x', -sz / 2).attr('y', -sz / 2).attr('width', sz).attr('height', sz);
      s.select('text.abbr').style('font-size', `${Math.max(7, r * 0.62)}px`);
    });
    this.teamSel = all;
  }

  curve(a, b, bend = 0.18) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const off = Math.min(d * bend, 160);
    const cx = mx - (dy / d) * off, cy = my + (dx / d) * off;
    return `M${a.x},${a.y}Q${cx},${cy} ${b.x},${b.y}`;
  }

  renderAff() {
    const { teams, affiliations } = this.model;
    const s = this.sel;
    let data = [];
    if (this.layers.aff || s.team != null) {
      for (const [a, b] of affiliations) {
        if (!this.pos.has(a) || !this.pos.has(b)) continue;
        const hot = s.team != null && (a === s.team || b === s.team);
        if (!this.layers.aff && !hot) continue;
        if (s.player != null) continue;
        data.push({ a, b, hot, k: `${a}-${b}` });
      }
    }
    const dimmed = s.team != null || s.player != null;
    const sel = this.gAff.selectAll('g.affl').data(data, (d) => d.k);
    const en = sel.enter().append('g').attr('class', 'affl');
    en.append('path').attr('class', 'link aff-base');
    en.append('path').attr('class', 'link aff-flow');
    sel.exit().remove();
    this.affSel = en.merge(sel);
    this.affSel.each(function (d) {
      const g = d3.select(this);
      const ta = teams[d.a], tb = teams[d.b];
      const upper = ta.baseR >= tb.baseR ? ta : tb;
      g.select('.aff-base')
        .attr('stroke', d.hot ? '#ffffff' : '#dbe7f7')
        .attr('stroke-width', d.hot ? 2.6 : 1.1)
        .attr('stroke-opacity', d.hot ? 0.95 : dimmed ? 0.06 : 0.32)
        .attr('filter', d.hot ? 'url(#glow)' : null);
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
        if (!this.pos.has(o)) continue;
        if (e.n < this.minShared && !t.affs.has(o)) continue;
        out.push({ e, from: t.i, to: o, hot: true });
      }
      return out.sort((x, y) => x.e.n - y.e.n);
    }
    if (!this.layers.web) return [];
    const out = [];
    for (const e of pairs) {
      if (e.n < Math.max(2, this.minShared)) break;
      if (!this.pos.has(e.a) || !this.pos.has(e.b)) continue;
      out.push({ e, from: e.a, to: e.b, hot: false });
      if (out.length >= 320) break;
    }
    return out.reverse();
  }

  renderWeb() {
    const { teams } = this.model;
    const data = this.webData();
    this.webMax = d3.max(data, (d) => d.e.n) || 1;
    const wScale = d3.scaleSqrt().domain([1, Math.max(4, this.webMax)]).range([1, 5.5]);
    const oScale = d3.scaleLinear().domain([1, Math.max(4, this.webMax)]).range([0.07, 0.42]);
    const sel = this.gWeb.selectAll('path.web').data(data, (d) => `${d.from}-${d.to}-${d.hot}`);
    sel.exit().remove();
    const en = sel.enter().append('path').attr('class', 'link web')
      .on('mouseenter', (ev, d) => d.hot && this.h.onLinkHover(d, ev))
      .on('mousemove', (ev, d) => d.hot && this.h.onLinkHover(d, ev))
      .on('mouseleave', () => this.h.onLinkHover(null))
      .on('click', (ev, d) => { if (d.hot) { ev.stopPropagation(); this.h.onTeam(d.to); } });
    const all = en.merge(sel);
    all.classed('hot', (d) => d.hot)
      .attr('stroke', (d) => (d.hot ? (this.colorMode === 'rating' ? ratingColor(teams[d.to].rating) : teams[d.to].color) : '#7cc4ff'))
      .attr('stroke-width', (d) => (d.hot ? wScale(d.e.n) : wScale(d.e.n) * 0.5))
      .attr('stroke-opacity', (d) => (d.hot ? 0.82 : oScale(d.e.n)));
    if (data.some((d) => d.hot)) {
      en.each(function () {
        const len = 2000;
        d3.select(this).attr('stroke-dasharray', `${len} ${len}`).attr('stroke-dashoffset', len)
          .transition().duration(900).delay(() => Math.random() * 250).ease(d3.easeCubicOut).attr('stroke-dashoffset', 0)
          .on('end', function () { d3.select(this).attr('stroke-dasharray', null); });
      });
    }
    this.webSel = all;

    // count badges on linked teams
    const s = this.sel;
    const badges = s.team != null ? data.map((d) => ({ i: d.to, n: d.e.n })) : [];
    const b = this.gBadges.selectAll('g.count-badge').data(badges, (d) => d.i);
    b.exit().remove();
    const be = b.enter().append('g').attr('class', 'count-badge');
    be.append('circle').attr('r', 8);
    be.append('text');
    this.badgeSel = be.merge(b);
    this.badgeSel.select('circle').attr('stroke', (d) => teams[d.i].color);
    this.badgeSel.select('text').text((d) => d.n);
  }

  renderPath() {
    const { players, teams } = this.model;
    const s = this.sel;
    let stops = [];
    if (s.player != null) {
      const p = players[s.player];
      const seq = [];
      for (const c of p.c) {
        const ref = c[1];
        if (ref < 0 || !this.pos.has(ref)) continue;
        if (seq.length && seq[seq.length - 1].i === ref) { seq[seq.length - 1].to = c[0]; continue; }
        seq.push({ i: ref, from: c[0], to: c[0] });
      }
      for (const ti of p.t) if (this.pos.has(ti) && !seq.some((x) => x.i === ti && x.to >= 2000)) seq.push({ i: ti, from: null, to: null });
      stops = seq;
    }
    this.stops = stops;
    const segs = stops.slice(1).map((d, i) => ({ a: stops[i].i, b: d.i, k: `${i}` }));
    const ps = this.gPath.selectAll('path.path-line').data(segs, (d) => d.k + d.a + '-' + d.b);
    ps.exit().remove();
    const pe = ps.enter().append('path').attr('class', 'path-line');
    pe.each(function (d, i) {
      d3.select(this).attr('stroke-dasharray', '2000 2000').attr('stroke-dashoffset', 2000)
        .transition().delay(i * 260).duration(520).ease(d3.easeCubicInOut).attr('stroke-dashoffset', 0)
        .on('end', function () { d3.select(this).attr('stroke-dasharray', null); });
    });
    this.pathSel = pe.merge(ps);
    const st = this.gStops.selectAll('g.path-stop').data(stops.map((d, n) => ({ ...d, n: n + 1 })), (d) => d.n + '-' + d.i);
    st.exit().remove();
    const se = st.enter().append('g').attr('class', 'path-stop').style('opacity', 0);
    se.append('circle').attr('r', 8);
    se.append('text');
    se.transition().delay((d) => (d.n - 1) * 260).duration(300).style('opacity', 1);
    this.stopSel = se.merge(st);
    this.stopSel.select('text').text((d) => d.n);
    this.stopSel.select('circle').attr('stroke', (d) => teams[d.i].color);
  }

  renderLabels() {
    const { teams } = this.model;
    const s = this.sel;
    const set = new Set();
    if (this.hover != null) set.add(this.hover);
    if (s.team != null) {
      set.add(s.team);
      for (const a of teams[s.team].affs) set.add(a);
      const top = [...teams[s.team].links.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 6);
      for (const [o] of top) set.add(o);
    }
    if (s.player != null) for (const st of this.stops || []) set.add(st.i);
    if (this.transform.k >= 3.2) for (const t of this.visibleTeams()) set.add(t.i);
    const data = [...set].filter((i) => this.pos.has(i)).map((i) => teams[i]);
    const sel = this.gLabels.selectAll('text.team-label').data(data, (d) => d.i);
    sel.exit().remove();
    this.labelSel = sel.enter().append('text').attr('class', 'team-label').merge(sel)
      .text((d) => (this.transform.k >= 3.2 && d.i !== s.team ? d.short : d.name));
    this.updatePositions(false);
  }

  updatePositions(animate) {
    const P = (i) => this.pos.get(i);
    const dur = animate ? 420 : 0;
    const tr = (sel) => (dur ? sel.transition().duration(dur).ease(d3.easeCubicOut) : sel);
    if (this.teamSel) {
      tr(this.teamSel.filter((d) => P(d.i))).attr('transform', (d) => `translate(${P(d.i).x},${P(d.i).y})`);
      this.teamSel.each((d, i, n) => {
        const r = this.radius(d);
        const s = d3.select(n[i]);
        const tiny = r < 7 && d.i !== this.sel.team;
        s.select('.halo').attr('r', r + 4);
        s.select('.disc').attr('r', r).style('fill', tiny ? this.teamStroke(d) : null);
        s.select('.ring').attr('r', r);
        const sz = r * 1.42;
        s.select('image').attr('x', -sz / 2).attr('y', -sz / 2).attr('width', sz).attr('height', sz).style('display', tiny ? 'none' : null);
        s.select('text.abbr').style('display', tiny ? 'none' : null);
      });
    }
    // leaders for displaced badges
    const lead = [];
    for (const [i, p] of this.pos) {
      const d = Math.hypot(p.x - p.ax, p.y - p.ay);
      if (d > p.r * 0.9) lead.push({ i, p });
    }
    const ls = this.gLeaders.selectAll('g.ld').data(lead, (d) => d.i);
    ls.exit().remove();
    const le = ls.enter().append('g').attr('class', 'ld');
    le.append('line').attr('class', 'leader');
    le.append('circle').attr('class', 'anchor').attr('r', 1.8);
    const la = le.merge(ls);
    tr(la.select('line')).attr('x1', (d) => d.p.ax).attr('y1', (d) => d.p.ay).attr('x2', (d) => d.p.x).attr('y2', (d) => d.p.y);
    tr(la.select('circle')).attr('cx', (d) => d.p.ax).attr('cy', (d) => d.p.ay);

    const ok = (d) => P(d.a) && P(d.b);
    if (this.affSel) this.affSel.filter(ok).selectAll('path').attr('d', (d) => this.curve(P(d.a), P(d.b), 0.12));
    if (this.webSel) {
      const okw = (d) => P(d.from) && P(d.to);
      this.webSel.filter(okw).attr('d', (d) => this.curve(P(d.from), P(d.to), d.hot ? 0.2 : 0.16));
    }
    if (this.badgeSel) {
      this.badgeSel.filter((d) => P(d.i)).attr('transform', (d) => {
        const p = P(d.i);
        return `translate(${p.x + p.r * 0.78},${p.y - p.r * 0.78})`;
      });
    }
    if (this.pathSel) this.pathSel.filter((d) => P(d.a) && P(d.b)).attr('d', (d) => this.curve(P(d.a), P(d.b), 0.22));
    if (this.stopSel) {
      this.stopSel.filter((d) => P(d.i)).attr('transform', (d) => {
        const p = P(d.i);
        return `translate(${p.x - p.r * 0.8},${p.y - p.r * 0.8})`;
      });
    }
    if (this.labelSel) {
      this.labelSel.filter((d) => P(d.i)).attr('x', (d) => P(d.i).x).attr('y', (d) => P(d.i).y + P(d.i).r + 13);
    }
  }

  // ------------------------------------------------------------------ camera
  zoomBy(f) { this.svg.transition().duration(350).call(this.zoom.scaleBy, f); }
  resetView() { this.svg.transition().duration(700).call(this.zoom.transform, d3.zoomIdentity); }

  fitTeams(indices, { maxK = 6, padRight = 0 } = {}) {
    const pts = indices.map((i) => this.model.teams[i]).filter((t) => t.xy).map((t) => t.xy);
    if (!pts.length) return;
    const mobile = this.w < 760;
    const x0 = d3.min(pts, (p) => p[0]), x1 = d3.max(pts, (p) => p[0]);
    const y0 = d3.min(pts, (p) => p[1]), y1 = d3.max(pts, (p) => p[1]);
    const availW = this.w - (mobile ? 40 : 100 + padRight);
    const top = mobile ? 120 : 130;
    const availH = (mobile ? this.h0 * 0.36 : this.h0 - 60) - top;
    const k = Math.max(0.8, Math.min(maxK, availW / Math.max(60, x1 - x0), availH / Math.max(60, y1 - y0)));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const sx = (mobile ? this.w / 2 : (this.w - padRight) / 2), sy = top + availH / 2;
    const t = d3.zoomIdentity.translate(sx - cx * k, sy - cy * k).scale(k);
    this.svg.transition().duration(850).ease(d3.easeCubicInOut).call(this.zoom.transform, t);
  }
}
