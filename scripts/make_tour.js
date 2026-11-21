#!/usr/bin/env node
// Captures the stills for the welcome tour (desktop + phone) from the real site, plus the points the
// slides animate around (where to "tap", where to zoom, where the route starts).
//
//   python3 -m http.server 8765 &      # serve the repo
//   node scripts/make_tour.js          # writes assets/tour/*.webp + assets/tour/tour.json
//
// Needs Playwright (Chromium) and Python 3 with Pillow (for WebP). Re-run after UI changes.
const { chromium, devices } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.TOUR_URL || 'http://localhost:8765/';
const OUT = path.join(__dirname, '..', 'assets', 'tour');

async function capture(kind) {
  const mobile = kind === 'mobile';
  const viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `tour-${kind}-`));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    ...(mobile ? devices['iPhone 13'] : {}), viewport, deviceScaleFactor: mobile ? 2 : 1.5,
    reducedMotion: 'reduce', // every state lands at once: clean, settled stills
  });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('hockey-atlas:tour-skip', 'true'); localStorage.setItem('hockey-atlas:coach-seen', 'true'); } catch {}
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('#loading'));
  await page.evaluate(async () => {
    const v = new URL(document.querySelector('script[type=module]').src).search;
    window.__t = await import(`/js/app.js${v}`);
    const { ensurePlayerScores } = await import(`/js/model.js${v}`);
    ensurePlayerScores(window.__t.M);
  });
  const wait = (ms) => page.waitForTimeout(ms);
  const shots = [];
  const shot = async (name) => { const f = path.join(tmp, `${name}.png`); await page.screenshot({ path: f }); shots.push([f, name]); };
  const pct = (x, y) => [+(x / viewport.width * 100).toFixed(2), +(y / viewport.height * 100).toFixed(2)];
  const teamPt = (id) => page.evaluate((id) => { const { M, map } = window.__t; const p = map.pos.get(M.teamById.get(id).i); return [p.x, p.y]; }, id);
  const rectPt = (sel) => page.evaluate((sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? [r.left + r.width / 2, r.top + r.height / 2] : [0, 0]; }, sel);
  const act = (fn, ...args) => page.evaluate(([fn, args]) => window.__t.actions[fn](...args), [fn, args]);
  const pts = {};

  // 1. the whole map
  await wait(900);
  await shot('map');

  // 2. tap a team: frame it as a selection would, then shoot before/after from that same camera
  const tor = await page.evaluate(() => window.__t.M.teamById.get('NHL-TOR').i);
  await act('selectTeam', tor, { from: 'ui', snap: 'half' });
  await wait(1500);
  await shot('after');
  pts.gauge = pct(...await rectPt('.panel .rating'));
  const cam = await page.evaluate(() => { const t = window.__t.map.transform; return [t.x, t.y, t.k]; });
  await act('clearSelection');
  await wait(900);
  // same camera as the "after" shot, so the slide can crossfade between them
  await page.evaluate(([x, y, k]) => { const m = window.__t.map; m.svg.call(m.zoom.transform, d3.zoomIdentity.translate(x, y).scale(k)); }, cam);
  await wait(1200);
  await shot('before');
  pts.team = pct(...await teamPt('NHL-TOR'));

  // 3. the rating (phone: open the sheet fully so the dial and top players show)
  if (mobile) {
    await act('clearSelection');
    await wait(700);
    await act('selectTeam', tor, { from: 'map', snap: 'full' });
    await wait(1400);
    await shot('rating');
    pts.gauge = pct(...await rectPt('.panel .rating'));
  }

  // 4. a player's journey: same frame without and with the route
  await act('clearSelection');
  await wait(700);
  const pi = await page.evaluate(() => {
    const { M } = window.__t;
    const ok = M.players.filter((p) => M.teams[p.t[0]]?.lg === 'NHL' && p.sm && p.sm.stops >= 8 && p.sm.stops <= 11 && p.sm.leagues >= 3 && p.img);
    ok.sort((a, b) => b.sm.mates - a.sm.mates);
    return ok[0].i;
  });
  await act('selectPlayer', pi, { snap: 'peek' });
  await wait(2200);
  await page.addStyleTag({ content: '.path-layer, .journey { opacity: 0 !important; transition: none !important; }' });
  await wait(150);
  await shot('route0');
  await page.evaluate(() => document.querySelectorAll('style').forEach((s) => { if (s.textContent.includes('.path-layer, .journey')) s.remove(); }));
  await wait(250);
  await shot('route1');
  pts.start = pct(...await page.evaluate(() => { const { map } = window.__t; const p = map.pos.get(map.stops[0].i); return [p.x, p.y]; }));
  const who = await page.evaluate((pi) => window.__t.M.players[pi].n, pi);

  // 5. rankings (players)
  await act('clearSelection');
  await wait(700);
  await page.click('#btn-leaderboard');
  await wait(500);
  await page.click('[data-lb-kind=players]');
  await wait(700);
  await shot('rank');

  await browser.close();
  fs.mkdirSync(OUT, { recursive: true });
  const py = `import sys
from PIL import Image
for i in range(1, len(sys.argv), 2):
    Image.open(sys.argv[i]).convert('RGB').save(sys.argv[i + 1], 'WEBP', quality=${mobile ? 78 : 80}, method=6)`;
  execFileSync('python3', ['-c', py, ...shots.flatMap(([f, n]) => [f, path.join(OUT, `${kind}-${n}.webp`)])]);
  fs.rmSync(tmp, { recursive: true, force: true });
  const kb = shots.reduce((s, [, n]) => s + fs.statSync(path.join(OUT, `${kind}-${n}.webp`)).size, 0) / 1024;
  console.log(`${kind}: ${shots.length} stills, ${kb.toFixed(0)} KB, journey: ${who}`);
  return { w: viewport.width, h: viewport.height, pts, player: who, imgs: shots.map(([, n]) => n) };
}

(async () => {
  const manifest = { made: new Date().toISOString().slice(0, 10) };
  for (const k of ['desktop', 'mobile']) manifest[k] = await capture(k);
  fs.writeFileSync(path.join(OUT, 'tour.json'), JSON.stringify(manifest, null, 1) + '\n');
  for (const f of fs.readdirSync(OUT)) if (/\.(mp4|jpg)$/.test(f)) fs.rmSync(path.join(OUT, f)); // old video tour
  console.log('wrote assets/tour/tour.json');
})();
