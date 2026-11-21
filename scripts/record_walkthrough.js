#!/usr/bin/env node
// Records the ~15 s welcome walkthrough videos (desktop + phone) by driving the real site.
//
//   python3 -m http.server 8765 &            # serve the repo
//   node scripts/record_walkthrough.js       # writes assets/tour/tour-{desktop,mobile}.mp4 + posters
//
// Needs Playwright (with Chromium) and ffmpeg on PATH. Re-run after UI changes so the tour stays current.
const { chromium, devices } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.TOUR_URL || 'http://localhost:8765/';
const OUT = path.join(__dirname, '..', 'assets', 'tour');
const LEN = 15.5; // seconds kept

const CAPTION_CSS = `
#tour-cap { position: fixed; left: 50%; z-index: 999; transform: translate(-50%, 8px); opacity: 0; pointer-events: none;
  padding: 12px 22px; border-radius: 999px; background: rgba(8, 14, 26, .92); border: 1px solid rgba(124,196,255,.35);
  box-shadow: 0 14px 40px rgba(0,0,0,.55); color: #eef3fa; font: 700 30px/1.1 "Barlow Condensed", system-ui, sans-serif;
  letter-spacing: .02em; white-space: nowrap; transition: opacity .35s ease, transform .35s ease; }
#tour-cap.on { opacity: 1; transform: translate(-50%, 0); }
#tour-cap b { color: #7cc4ff; font-weight: 700; }
.tour-tap { position: fixed; z-index: 998; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%; pointer-events: none;
  background: rgba(255,255,255,.35); border: 2px solid #fff; animation: tour-tap .7s ease-out forwards; }
@keyframes tour-tap { 0% { transform: scale(.4); opacity: 1; } 100% { transform: scale(1.6); opacity: 0; } }
`;

async function record(kind) {
  const mobile = kind === 'mobile';
  const viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tour-${kind}-`));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    ...(mobile ? devices['iPhone 13'] : {}),
    viewport, deviceScaleFactor: mobile ? 2 : 1,
    recordVideo: { dir, size: viewport },
  });
  const t0 = Date.now();
  // the recording itself must not show the tour or the first-visit hint
  await ctx.addInitScript(() => {
    try { localStorage.setItem('hockey-atlas:tour-skip', 'true'); localStorage.setItem('hockey-atlas:coach-seen', 'true'); } catch {}
  });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: CAPTION_CSS });
  await page.waitForFunction(() => !document.querySelector('#loading'));
  await page.waitForTimeout(600);
  // app modules: import with the same ?v= the page uses so we share its instances
  await page.evaluate(async () => {
    const v = new URL(document.querySelector('script[type=module]').src).search;
    const app = await import(`/js/app.js${v}`);
    window.__tour = app;
    const cap = document.createElement('div');
    cap.id = 'tour-cap';
    document.body.append(cap);
  });
  const capTop = mobile ? 118 : 96;
  const caption = (html, top = capTop) => page.evaluate(([h, top]) => {
    const c = document.getElementById('tour-cap');
    c.style.top = `${top}px`;
    c.classList.remove('on');
    setTimeout(() => { c.innerHTML = h; c.classList.add('on'); }, h ? 180 : 0);
    if (!h) c.classList.remove('on');
  }, [html, top]);
  const tap = (x, y) => page.evaluate(([x, y]) => {
    const d = document.createElement('div');
    d.className = 'tour-tap';
    d.style.left = `${x}px`; d.style.top = `${y}px`;
    document.body.append(d);
    setTimeout(() => d.remove(), 800);
  }, [x, y]);
  const start = Date.now();
  const at = async (sec) => { const w = start + sec * 1000 - Date.now(); if (w > 0) await page.waitForTimeout(w); };

  // 1. the map
  await caption(mobile ? '<b>195</b> teams · <b>9</b> leagues' : '<b>195</b> teams · <b>9</b> leagues · one map');
  await at(0.6);
  await page.evaluate(() => window.__tour.map.zoomBy(1.12));

  // 2. a team's web
  await at(2.9);
  await caption(mobile ? 'Tap a team → its web' : 'Tap any team to see its <b>player web</b>');
  await at(3.4);
  const tor = await page.evaluate(() => {
    const t = window.__tour.M.teamById.get('NHL-TOR');
    const p = window.__tour.map.pos.get(t.i);
    return { i: t.i, x: p.x, y: p.y };
  });
  await tap(tor.x, tor.y);
  await at(3.6);
  await page.evaluate((i) => window.__tour.actions.selectTeam(i, { from: 'ui', snap: 'half' }), tor.i);

  // 3. a player's journey (the Leafs player with the most stops)
  await at(6.6);
  await page.evaluate(() => window.__tour.actions.setTab('roster'));
  await at(7.2);
  await caption(mobile ? 'Tap a player → their journey' : 'Tap a player to replay their <b>journey</b>');
  const row = await page.evaluate(() => {
    const { M } = window.__tour;
    const t = M.teamById.get('NHL-TOR');
    const best = t.roster.map((i) => M.players[i]).sort((a, b) => (b.sm?.stops || 0) - (a.sm?.stops || 0))[0];
    const el = document.querySelector(`.panel .prow[data-player="${best.i}"]`);
    el?.scrollIntoView({ block: 'center' });
    const r = el?.getBoundingClientRect();
    return { i: best.i, x: r ? r.left + 60 : 0, y: r ? r.top + r.height / 2 : 0 };
  });
  await at(7.9);
  if (row.x) await tap(row.x, row.y);
  await at(8.1);
  await page.evaluate((i) => window.__tour.actions.selectPlayer(i, { snap: 'peek' }), row.i);
  if (mobile) { await page.waitForTimeout(350); await page.click('.panel-play'); } // lower the sheet so the route shows

  // 4. search / rank / share
  await at(13.0);
  await caption(mobile ? 'Search · rank · share' : 'Search anyone · <b>rank</b> everyone · <b>share</b> it', Math.round(viewport.height * (mobile ? 0.62 : 0.55)));
  await page.evaluate(() => window.__tour.actions.clearSelection());
  await at(13.5);
  await page.click('#search');
  await page.keyboard.type('McDav', { delay: 90 });
  await at(LEN + 0.4);

  const video = page.video();
  await ctx.close();
  await browser.close();
  const src = await video.path();
  const skip = ((start - t0) / 1000).toFixed(2);
  const mp4 = path.join(OUT, `tour-${kind}.mp4`);
  fs.mkdirSync(OUT, { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', skip, '-i', src, '-t', String(LEN),
    '-vf', mobile ? 'scale=390:-2,fps=30' : 'scale=1280:-2,fps=30',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '5', '-i', mp4, '-frames:v', '1', '-q:v', '4', path.join(OUT, `tour-${kind}.jpg`)]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`wrote ${mp4} (${(fs.statSync(mp4).size / 1e6).toFixed(2)} MB)`);
}

(async () => {
  for (const k of process.argv.slice(2).length ? process.argv.slice(2) : ['desktop', 'mobile']) await record(k);
})();
