// tour.js: the welcome tour. Five story-style slides built from stills of the real site
// (scripts/make_tour.js), animated with CSS so they stay smooth on any device: a slow push-in on the
// map, a tap that fades into a team's web, a zoom into the rating dial, a route spreading out from its
// first stop, and the rankings. Progress bars, tap left/right, press-and-hold to pause, arrow keys.
const V = new URL(import.meta.url).search;
const STORE = 'hockey-atlas:';
const store = {
  get(k, d) { try { const v = localStorage.getItem(STORE + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(STORE + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const phoneMQ = matchMedia('(max-width: 760px)');
const calmMQ = matchMedia('(prefers-reduced-motion: reduce)');
const DUR = 3000; // per slide: 5 slides, 15 seconds
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

let manifest = null;
let el = null, cur = 0, slides = [], returnFocus = null, keyHandler = null, press = null;

async function loadManifest() {
  if (!manifest) manifest = await fetch(`assets/tour/tour.json${V}`).then((r) => r.json());
  return manifest;
}

function buildSlides(m, kind) {
  const d = m[kind], P = d.pts;
  const img = (n) => `assets/tour/${kind}-${n}.webp${V}`;
  const has = (n) => d.imgs.includes(n);
  return [
    { fx: 'kb', a: img('map'), pt: [58, 52], title: 'Every team. One map.', text: '195 pro and junior teams in 9 leagues, each at its home arena.' },
    { fx: 'tap', a: img('before'), b: img('after'), pt: P.team, title: 'Tap a team, see its web', text: 'Lines run to every team its players have played for, plus its affiliates.' },
    // desktop zooms into the panel's rating block anchored at the panel's right edge, so nothing is cut off
    { fx: kind === 'mobile' ? 'kb' : 'zoom', a: img(has('rating') ? 'rating' : 'after'), pt: kind === 'mobile' ? P.gauge : [98.5, P.gauge[1]], title: 'How connected is it?', text: 'Every team and player gets a 0–100 connection score, ranked within its league.' },
    { fx: 'reveal', a: img('route0'), b: img('route1'), pt: P.start, title: 'Replay any player’s journey', text: `Watch ${d.player || 'a career'} travel the map, stop by stop.` },
    { fx: 'rise', a: img('rank'), pt: [50, 40], title: 'Search · rank · share', text: 'Find anyone, sort the most connected players, send a route to a friend.' },
  ];
}

export async function openTour() {
  if (el) return;
  let m;
  try { m = await loadManifest(); } catch { return; }
  const kind = phoneMQ.matches ? 'mobile' : 'desktop';
  const d = m[kind];
  slides = buildSlides(m, kind);
  returnFocus = document.activeElement;
  el = document.createElement('div');
  el.className = `tour ${kind}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Hockey Atlas tour');
  el.innerHTML = `<div class="tour-card" tabindex="-1">
      <div class="tour-stage" style="--ar:${d.w} / ${d.h}">
        ${slides.map((s, i) => `<div class="tour-slide fx-${s.fx}" data-i="${i}" style="--px:${s.pt[0]}%;--py:${s.pt[1]}%" aria-hidden="true">
          <img class="ts-a" src="${s.a}" alt="" decoding="async">${s.b ? `<img class="ts-b" src="${s.b}" alt="" decoding="async">` : ''}${s.fx === 'tap' ? '<span class="ts-tap"></span>' : ''}</div>`).join('')}
        <div class="tour-shade" aria-hidden="true"></div>
      </div>
      <div class="tour-bars" aria-hidden="true">${slides.map(() => '<span><i></i></span>').join('')}</div>
      <button class="tour-x" type="button" aria-label="Close tour">${ICON_X}</button>
      <div class="tour-cap" aria-live="polite"><span class="tc-n"></span><h3 class="tc-t"></h3><p class="tc-p"></p></div>
      <div class="tour-foot">
        <label class="tour-skip"><input type="checkbox"${store.get('tour-skip', false) ? ' checked' : ''}><span>Don’t show this again</span></label>
        <button class="tour-go" type="button">Start exploring</button>
      </div>
      <p class="tour-hint">Tap to skip ahead · hold to pause</p>
    </div>`;
  document.body.append(el);
  document.body.classList.add('touring');
  wire();
  // start once the first slide's images are ready, so nothing pops in
  const first = [...el.querySelectorAll('.tour-slide[data-i="0"] img')];
  await Promise.race([Promise.all(first.map((i) => i.decode().catch(() => {}))), new Promise((r) => setTimeout(r, 1500))]);
  if (!el) return;
  el.classList.add('open');
  el.querySelector('.tour-card').focus({ preventScroll: true });
  go(0);
}

function go(i) {
  if (!el) return;
  cur = Math.max(0, Math.min(slides.length - 1, i));
  const s = slides[cur];
  el.querySelectorAll('.tour-slide').forEach((n) => {
    const on = +n.dataset.i === cur;
    n.classList.toggle('on', on);
    if (on) { n.classList.remove('play'); void n.offsetWidth; n.classList.add('play'); } // restart its animation
  });
  el.querySelectorAll('.tour-bars span').forEach((b, k) => {
    b.className = k < cur ? 'done' : '';
    if (k === cur) { void b.offsetWidth; b.className = 'run'; }
  });
  const cap = el.querySelector('.tour-cap');
  cap.querySelector('.tc-n').textContent = `${cur + 1} / ${slides.length}`;
  cap.querySelector('.tc-t').textContent = s.title;
  cap.querySelector('.tc-p').textContent = s.text;
  cap.classList.remove('in'); void cap.offsetWidth; cap.classList.add('in');
  el.classList.toggle('last', cur === slides.length - 1);
  el.classList.remove('ended');
}

function next() { if (cur < slides.length - 1) go(cur + 1); else el.classList.add('ended'); }
function prev() { go(cur - 1); }

function close() {
  if (!el) return;
  const node = el;
  el = null;
  window.removeEventListener('keydown', keyHandler, true);
  document.body.classList.remove('touring');
  node.classList.remove('open');
  node.classList.add('closing');
  setTimeout(() => node.remove(), calmMQ.matches ? 0 : 280);
  if (returnFocus?.isConnected && returnFocus !== document.body) returnFocus.focus({ preventScroll: true });
}

function wire() {
  const card = el.querySelector('.tour-card'), stage = el.querySelector('.tour-stage');
  // the running bar drives the timing: it pauses with everything else, and its end moves on
  el.querySelector('.tour-bars').addEventListener('animationend', (e) => { if (e.target.parentElement?.classList.contains('run')) next(); });
  el.querySelector('.tour-x').addEventListener('click', close);
  el.querySelector('.tour-go').addEventListener('click', close);
  el.querySelector('.tour-skip input').addEventListener('change', (e) => store.set('tour-skip', e.target.checked));
  el.addEventListener('click', (e) => { if (e.target === el) close(); }); // backdrop (desktop)

  // tap left third = back, elsewhere = forward; press and hold = pause
  const tapZone = card;
  tapZone.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, label, input, .tour-foot')) return;
    press = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    const hold = setTimeout(() => { if (press) { press.held = true; el?.classList.add('paused'); } }, 220);
    press.hold = hold;
  });
  const end = (e, cancel) => {
    if (!press || (e.pointerId != null && e.pointerId !== press.id)) return;
    clearTimeout(press.hold);
    el?.classList.remove('paused');
    const p = press;
    press = null;
    if (cancel || p.held || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 12) return;
    const r = stage.getBoundingClientRect();
    if (e.clientX < r.left + r.width * 0.3) prev(); else next();
  };
  tapZone.addEventListener('pointerup', (e) => end(e, false));
  tapZone.addEventListener('pointercancel', (e) => end(e, true));
  tapZone.addEventListener('pointerleave', (e) => end(e, true));

  keyHandler = (e) => {
    if (!el) return;
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (k === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); next(); return; }
    if (k === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); prev(); return; }
    if (k === ' ' && !e.target.matches('button, input')) { e.preventDefault(); e.stopPropagation(); el.classList.toggle('paused'); return; }
    if (k === 'Tab') { // keep focus inside the tour
      const f = [...el.querySelectorAll('button, input')].filter((n) => n.getClientRects().length);
      if (!f.length) return;
      const a = document.activeElement;
      if (e.shiftKey && (a === f[0] || !el.contains(a))) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && a === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      e.stopPropagation();
      return;
    }
    e.stopPropagation(); // the map's own shortcuts stay quiet while the tour is up
  };
  window.addEventListener('keydown', keyHandler, true);
}

/** Show the tour on load until "Don't show this again" is ticked; never over a shared team/player link. */
export function maybeTour(canShow) {
  if (store.get('tour-skip', false)) return;
  if (/[#&](t|p)=/.test(location.hash)) return;
  setTimeout(() => { if (!canShow || canShow()) openTour(); }, 900);
}
