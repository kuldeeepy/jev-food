(async () => {
const { Engine, Bodies, Body, Composite } = Matter;
const dishes = await (await fetch('./dishes.json')).json();

// Tunables. Nothing below this block should carry a bare magic number.
const CFG = {
  emoji: 46,              // drawn glyph size
  rowMax: 10,             // results lifted into the row
  floorSink: 34,          // how far into the grass the heap settles
  debounceMs: 450,        // pause before a query is sent
  timeoutMs: 4000,        // give up on the gateway and use local rules
  minQuery: 3,            // shorter than this is never sent
  hero: { w: 2400, h: 1600, grassAt: 0.805 },   // measured from hero.webp
};
const EMOJI = CFG.emoji, R = EMOJI * 0.44;
function fit(ctx, t, maxW) {                 // trim to the real rendered width
  if (ctx.measureText(t).width <= maxW) return t;
  let s = t;
  while (s.length > 1 && ctx.measureText(s + '\u2026').width > maxW) s = s.slice(0, -1);
  return s.trimEnd() + '\u2026';
}          // draw size, and the physics radius that fits it
const cv = document.createElement('canvas');
document.body.appendChild(cv);
const ctx = cv.getContext('2d');
let W, H, dpr, GRASS = 0;   // viewport y where the grass line falls

function resize() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  const { w: IMG_W, h: IMG_H, grassAt: GRASS_AT } = CFG.hero;
  const drawnH = IMG_H * Math.max(W / IMG_W, H / IMG_H);
  GRASS = Math.round(Math.min(H - 60, Math.max(H * 0.35, H - drawnH * (1 - GRASS_AT))));
  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  layoutWalls();
}

const engine = Engine.create();
engine.gravity.y = 1.7;
engine.positionIterations = 12;
engine.velocityIterations = 8;
// Matter defaults sleeping off, so a settled heap micro-jitters forever and reads as flicker.
engine.enableSleeping = true;

// floor + side walls, rebuilt on resize so the heap always sits on the bottom edge
const floorY = () => GRASS + CFG.floorSink;   // just inside the grass so the heap nestles in
let walls = [];
function layoutWalls() {
  Composite.remove(engine.world, walls);
  walls = [
    Bodies.rectangle(W / 2, floorY() + 200, W * 3, 400, { isStatic: true }),   // thick: thin floors get tunnelled
    Bodies.rectangle(-40, H / 2, 80, H * 3, { isStatic: true }),
    Bodies.rectangle(W + 40, H / 2, 80, H * 3, { isStatic: true }),
  ];
  Composite.add(engine.world, walls);
}
resize();
let rz;
addEventListener('resize', () => {
  resize();
  // Re-flow the row for the new width; this hits the cache, so no network call.
  clearTimeout(rz);
  rz = setTimeout(() => { const v = document.getElementById('q').value; if (v.trim()) run(v); }, 180);
});

// ---------- bodies ----------
const items = dishes.map((rec, i) => {
  const body = Bodies.circle(0, 0, R, {
    restitution: 0.02, friction: 1.0, frictionStatic: 2.5, frictionAir: 0.02, density: 0.0018,
    sleepThreshold: 24
  });
  Composite.add(engine.world, body);
  return { rec, body, lifted: false, tween: null, alpha: 1, scale: 1, hover: false, i };
});

function scatter() {
  items.forEach((it, i) => {
    Body.setStatic(it.body, false); Matter.Sleeping.set(it.body, false);
    it.lifted = false; it.tween = null;
    // drop into a centred band so they mound up instead of spreading into a thin line
    const band = Math.min(W * 0.40, 560);
    Body.setPosition(it.body, { x: W / 2 - band / 2 + Math.random() * band, y: -60 - Math.random() * H * 0.45 });
    Body.setVelocity(it.body, { x: 0, y: 0 });
    Body.setAngle(it.body, (Math.random() - 0.5) * 2);
    Body.setAngularVelocity(it.body, (Math.random() - 0.5) * 0.22);
  });
}
scatter();

// ---------- search ----------
const INTENT = [
  [/\b(quick|fast|lazy|no ?time|hurry|instant)\b/, m => m.mins <= 12],
  [/\b(no.?prep|can.?t be bothered|effortless)\b/, m => m.noprep],
  [/\b(protein|gym|muscle|post.?workout)\b/, m => m.p >= 25],
  [/\b(light|low ?cal|small)\b/, m => m.kcal <= 350],
  [/\b(heavy|big|filling|hungry|cheat)\b/, m => m.kcal >= 600],
  [/\b(veg|vegetarian|no ?meat)\b/, m => m.diet === 'veg'],
  [/\b(egg|eggs)\b/, m => m.diet === 'egg' || /egg|omelette|bhurji/i.test(m.name)],
  [/\b(chicken|meat|non.?veg|nonveg)\b/, m => m.diet === 'nonveg'],
  [/\b(drink|drinks|beverage|thirsty)\b/, m => /chai|coffee|lassi|dahi|water|milk/i.test(m.name)],
  [/\b(sweet|dessert|mithai)\b/, m => /jamun|jalebi|kheer|chikki|halwa/i.test(m.name)],
  [/\b(rice)\b/, m => /rice|pulao|biryani|khichdi|chawal/i.test(m.name)],
  [/\b(breakfast|morning)\b/, m => m.slot === 'breakfast'],
  [/\b(lunch)\b/, m => m.slot === 'lunch'],
  [/\b(dinner|tonight|night)\b/, m => m.slot === 'dinner'],
  [/\b(snack)\b/, m => m.slot === 'snack'],
];

// Offline fallback for when Jev is unreachable, keyless or slow.
function matches(rec, q) {
  const hits = INTENT.filter(([re]) => re.test(q));
  if (hits.length) return hits.every(([, f]) => f(rec));       // an intent is authoritative
  const hay = (rec.name + ' ' + rec.slot + ' ' + rec.diet + ' ' + rec.how + ' ' + rec.micros.join(' ')).toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(t => t.length > 2).some(t => hay.includes(t));
}

// ---------- who decides what matches ----------
let jevOK = true, inflight = null, loading = false, rowGap = 108;
let hero = null;          // the revealed dish; read by the render loop, so it must live above it
const tipEl = document.getElementById('tip');
let mouse = null, hovered = null;   // read by the frame loop, so they must be declared above it
const cache = new Map();                     // normalised query -> scores
const norm = q => q.trim().toLowerCase().replace(/\s+/g, ' ');
async function resolve(q) {
  const local = () => items.filter(it => matches(it.rec, q));
  if (!jevOK) return { hits: local(), via: 'rules' };

  const key = norm(q);
  if (cache.has(key)) return { ...rank(cache.get(key).scores, cache.get(key).threshold), via: 'cache' };

  inflight?.abort();
  loading = true; document.body.classList.add('busy');
  const ac = inflight = new AbortController();
  const bail = setTimeout(() => ac.abort(), CFG.timeoutMs);
  try {
    const r = await fetch('/api/match', {
      method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, dishes: items.map(it => it.rec) })
    });
    clearTimeout(bail); loading = false; document.body.classList.remove('busy');
    const j = await r.json();
    if (!r.ok) {
      if (j.error === 'no_key') jevOK = false;    // transient errors (429, 502) must not disable it
      return { hits: local(), via: 'rules' };
    }
    // probability doubles as a relevance rank, so the row comes out best-first
    cache.set(key, j);
    return { ...rank(j.scores, j.threshold), via: 'jev' };
  } catch (e) {
    clearTimeout(bail); loading = false; document.body.classList.remove('busy');
    if (e.name === 'AbortError') return null;      // a newer query superseded this one
    return { hits: local(), via: 'rules' };
  }
}

// Floor rejects nonsense, order does the rest; a fixed high threshold matched nothing for "spicy".
function rank(scores, threshold = 0.5) {
  const r = items.filter(it => (scores[it.rec.id] ?? 0) >= threshold)
                 .sort((a, b) => scores[b.rec.id] - scores[a.rec.id]);
  r.forEach(it => it.score = scores[it.rec.id]);
  return { hits: r.slice(0, CFG.rowMax), total: r.length };
}

const ROW_Y = () => innerHeight * 0.07 + 118;
const easeOut = t => 1 - Math.pow(1 - t, 3);
// slight overshoot so each emoji pops into the row rather than sliding to a dead stop
const easeBack = t => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

let seq = 0;
async function run(q) {
  clearHero();
  const on = q.trim();
  document.getElementById('clear').classList.toggle('on', !!on);
  document.getElementById('chips').classList.toggle('hide', !!on);   // row lands where the chips were
  const mine = ++seq;
  let hitList = [], via = 'rules';
  if (on) {
    const r = await resolve(q);
    if (!r || mine !== seq) return;                // stale response, drop it
    hitList = r.hits; via = r.via; run._total = r.total ?? r.hits.length;
  }
  document.body.dataset.via = on ? via : '';
  const ve = document.getElementById('via');
  ve.textContent = via === 'cache' ? 'cached' : via === 'jev' ? 'jev' : 'offline rules';
  ve.classList.toggle('on', !!on);

  // Matches line up under the box; spacing is driven by label width, not emoji width.
  const gap = Math.min(108, Math.max(46, Math.min(W - 80, 1080) / Math.max(hitList.length, 1)));
  // keep the whole cascade under ~0.8s however many hits there are
  const step = Math.min(45, 800 / Math.max(hitList.length, 1));
  const total = (hitList.length - 1) * gap;
  rowGap = gap;
  hitList.forEach((it, n) => {
    const to = { x: W / 2 - total / 2 + n * gap, y: ROW_Y() };
    if (!it.lifted) {
      Body.setStatic(it.body, false);
      it.body.collisionFilter.mask = 0;          // stop blocking the pile so it can close over the gap
      Matter.Sleeping.set(it.body, false);
      Body.setVelocity(it.body, { x: (Math.random() - .5) * 4, y: -13 - Math.random() * 5 });
      Body.setAngularVelocity(it.body, (Math.random() - .5) * .5);
    }
    it.lifted = true;
    // negative t = the burst; `from` is captured when the tween actually takes over
    it.tween = { t: -n * step - 150, dur: 460, from: null, to, a0: 0 };
  });

  for (const it of items) {
    const hit = hitList.includes(it);
    it.alpha = !on ? 1 : (hit ? 1 : 0.16);
    if (!hit && it.lifted) {                      // dropped back into the heap, also staggered
      it.lifted = false; it.tween = null; it.hover = false;
      // Restore collisions now: a deferred restore lets the body fall through the floor.
      it.body.collisionFilter.mask = 0xFFFFFFFF;
      Body.setStatic(it.body, true);              // hold it until its turn to drop
      const d = Math.random() * 260;
      setTimeout(() => {
        if (it.lifted) return;                    // a newer search grabbed it again
        Body.setStatic(it.body, false);
        Matter.Sleeping.set(it.body, false);
        Body.setVelocity(it.body, { x: (Math.random() - .5) * 3, y: 1 });
        Body.setAngularVelocity(it.body, (Math.random() - .5) * .25);
      }, d);
    }
  }

}

// ---------- loop ----------
let last = performance.now();
(function frame(now) {
  const dt = Math.min(now - last, 40); last = now;
  Engine.update(engine, dt);
  for (const it of items) {                    // nothing may leave the world permanently
    if (it.lifted) continue;
    if (it.body.collisionFilter.mask === 0) it.body.collisionFilter.mask = 0xFFFFFFFF;
    const p = it.body.position;
    if (p.y > floorY() + 300 || p.y < -H * 2 || p.x < -200 || p.x > W + 200) {
      Body.setPosition(it.body, { x: W / 2 + (Math.random() - .5) * 200, y: -80 });
      Body.setVelocity(it.body, { x: 0, y: 2 });
    }
  }

  for (const it of items) {
    if (it.tween) {
      it.tween.t += dt;
      if (it.tween.t >= 0) {
        if (!it.tween.from) {                    // hand off from physics to the row
          it.tween.from = { x: it.body.position.x, y: it.body.position.y };
          it.tween.a0 = it.body.angle;
          Body.setStatic(it.body, true);
        }
        const p = Math.min(1, it.tween.t / it.tween.dur);
        const e = easeBack(p), { from, to, a0 } = it.tween;
        Body.setPosition(it.body, { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
        Body.setAngle(it.body, a0 * (1 - easeOut(p)));
        if (p === 1) it.tween = null;
      }
    }
    const want = it === hero ? 2.6 : it.hover ? 1.32 : 1;
    it.scale += (want - it.scale) * Math.min(1, dt / 70);
  }

  updateHover();

  ctx.clearRect(0, 0, W, H);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const it of items) {
    const { x, y } = it.body.position;
    ctx.save();
    ctx.globalAlpha = it.alpha;
    ctx.translate(x, y); ctx.rotate(it.body.angle);
    if (it.scale !== 1) ctx.scale(it.scale, it.scale);
    const FONT = f => `${f}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    if (it.rec.emoji2) {
      // A pair reads more precisely; no single emoji says "paneer roti".
      ctx.font = FONT(EMOJI * 0.92);
      ctx.fillText(it.rec.emoji, -EMOJI * 0.16, -EMOJI * 0.06);
      ctx.font = FONT(EMOJI * 0.60);
      ctx.fillText(it.rec.emoji2, EMOJI * 0.30, EMOJI * 0.22);
    } else {
      ctx.font = FONT(EMOJI);
      ctx.fillText(it.rec.emoji, 0, 0);
    }
    ctx.restore();

    // label the row — 10 results is too many to identify by hovering each one
    if (it.lifted && !it.tween && it !== hero) {
      ctx.save();
      ctx.globalAlpha = it.alpha * (it.hover ? 1 : 0.62);
      ctx.font = '500 10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
      ctx.fillStyle = it === selected ? '#18181b' : '#71717a';
      ctx.fillText(fit(ctx, it.rec.name, rowGap - 12), x, y + R + 13);
      ctx.restore();
    }
  }
  requestAnimationFrame(frame);
})(last);

// ---------- ui ----------
const q = document.getElementById('q');
let t; q.addEventListener('input', e => {
  clearTimeout(t);
  const v = e.target.value;
  // Each search is a network round trip, so wait for a real pause and ignore fragments.
  if (v.trim() && v.trim().length < CFG.minQuery) return;
  t = setTimeout(() => run(v), CFG.debounceMs);
});
document.getElementById('clear').onclick = () => { q.value = ''; run(''); q.focus(); };

const PRESETS = ['high protein', 'quick', 'veg', 'chicken', 'rice', 'something sweet', 'light'];
const chips = document.getElementById('chips');
chips.innerHTML = PRESETS.map(p => `<span class="chip">${p}</span>`).join('')
  + `<span class="chip" data-x>reshuffle</span><button id="decide">decide for me</button>`;
chips.querySelector('#decide').onclick = () => decide(q.value);
chips.querySelectorAll('.chip').forEach(c => c.onclick = () => {
  if (c.dataset.x !== undefined) { q.value = ''; run(''); scatter(); return; }
  q.value = c.textContent; run(q.value);
});

// ---------- hover ----------
// Box test covering the glyph pair and its label; nearest wins so overlaps can't shadow.
function pick(mx, my) {
  let best = null, bestD = Infinity;
  for (const it of items) {
    if (it.alpha <= 0.5) continue;
    const dx = mx - it.body.position.x, dy = my - it.body.position.y;
    const half = it.lifted ? Math.min(rowGap, 112) / 2 : R * 1.5;
    const up = R * 1.5, down = it.lifted ? R + 26 : R * 1.5;   // lifted items own their label
    if (dx < -half || dx > half || dy < -up || dy > down) continue;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = it; }
  }
  return best;
}

// Re-tested every frame, not on mousemove: results fly in under a possibly stationary cursor.
cv.addEventListener('mousemove', e => { mouse = { x: e.clientX, y: e.clientY }; });
cv.addEventListener('mouseleave', () => { mouse = null; });

function updateHover() {
  const hit = mouse ? pick(mouse.x, mouse.y) : null;
  if (hit !== hovered) {
    hovered = hit;
    for (const it of items) it.hover = (it === hit);
    cv.style.cursor = hit ? 'pointer' : 'default';
    if (hit) tipEl.textContent = hit.rec.name;
    tipEl.classList.toggle('on', !!hit && !hero);
  }
  if (hit) {                                   // follow it while it moves
    tipEl.style.left = hit.body.position.x + 'px';
    tipEl.style.top = (hit.body.position.y - R * (hit.scale || 1) - 16) + 'px';
  }
}

// ---------- modal ----------
const modal = document.getElementById('modal'), veil = document.getElementById('veil');
function openModal(r) {
  modal.innerHTML = `<button class="x" aria-label="Close">&times;</button>
    <span class="big">${r.emoji}${r.emoji2 ? `<span style="font-size:.62em;margin-left:-.12em">${r.emoji2}</span>` : ''}</span>
    <h3>${r.name}${r.demo ? '<span class="tag">not in rotation</span>' : ''}</h3>
    <div class="n">${r.kcal} kcal · ${r.p}g protein · ${r.mins} min</div>
    <div class="quip">${r.quip}</div>
    ${r.how ? `<div class="how">${r.how}</div>` : ''}
    ${r.tip && !r.demo ? `<div class="tip">${r.tip}</div>` : ''}`;
  modal.classList.add('on'); veil.classList.add('on');
  tipEl.classList.remove('on');
  for (const it of items) it.hover = false;
  modal.querySelector('.x').onclick = closeModal;
}
const closeModal = () => { modal.classList.remove('on'); veil.classList.remove('on'); };
veil.onclick = closeModal;
addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

cv.addEventListener('click', e => {
  const hit = pick(e.clientX, e.clientY);
  if (!hit) return;
  if (!hit.body.isStatic) {                      // a nudge, only for ones still in the heap
    Body.setVelocity(hit.body, { x: (Math.random() - .5) * 2, y: -7 });
    Body.setAngularVelocity(hit.body, (Math.random() - .5) * .4);
  }
  hit.scale = 1.5;                               // pops, then eases back in the frame loop
  openModal(hit.rec);
});

// ---------- the reveal: one dish out of the heap, not ten to choose between ----------
async function decide(q) {
  const r = await resolve(q || 'what should I eat now');
  if (!r || !r.hits.length) return;
  const win = r.hits[0];
  document.body.dataset.via = r.via;
  document.getElementById('via').classList.remove('on');
  document.getElementById('chips').classList.add('hide');

  const cx = W / 2, cy = H * 0.34;
  for (const it of items) {
    if (it === win) continue;
    it.lifted = false; it.tween = null; it.hover = false;
    Body.setStatic(it.body, false);
    it.body.collisionFilter.mask = 0xFFFFFFFF;
    // Nudge the heap rather than demolish it; it is the context the answer rises out of.
    Matter.Sleeping.set(it.body, false);
    Body.setVelocity(it.body, { x: (it.body.position.x < cx ? -1 : 1) * (1.5 + Math.random() * 3), y: -2 - Math.random() * 3 });
    Body.setAngularVelocity(it.body, (Math.random() - .5) * .35);
    it.alpha = 0.28;
  }
  win.alpha = 1; win.lifted = true;
  win.body.collisionFilter.mask = 0;
  Body.setStatic(win.body, false);
  Matter.Sleeping.set(win.body, false);
  Body.setVelocity(win.body, { x: 0, y: -17 });
  win.tween = { t: -520, dur: 900, from: null, to: { x: cx, y: cy }, a0: 0 };
  hero = win;

  setTimeout(() => {
    if (hero !== win) return;
    const c = document.getElementById('hero');
    c.innerHTML = `<div class="hn">${win.rec.name}</div>
      <div class="hs">${win.rec.kcal} kcal · ${win.rec.p}g protein · ${win.rec.mins} min</div>
      <div class="hq">${win.rec.quip}</div>`;
    c.classList.add('on');
  }, 1150);
}

function clearHero() {
  if (!hero) return;
  const h = hero;
  hero = null;
  document.getElementById('hero').classList.remove('on');
  // Restore what the reveal disabled, or this dish falls through the floor and is lost.
  h.lifted = false; h.tween = null; h.scale = 1;
  Body.setStatic(h.body, false);
  h.body.collisionFilter.mask = 0xFFFFFFFF;
  if (h.body.position.y > H || h.body.position.y < 0) {
    Body.setPosition(h.body, { x: W / 2 + (Math.random() - .5) * 120, y: -60 });
  }
  Body.setVelocity(h.body, { x: (Math.random() - .5) * 2, y: 2 });
  for (const it of items) it.alpha = 1;
}

// ---------- keyboard ----------
let selected = null;
addEventListener('keydown', e => {
  if (modal.classList.contains('on')) return;
  if (e.key === 'Enter' && !q.value.trim() && !hero) { e.preventDefault(); return decide(''); }
  const row = items.filter(it => it.lifted);
  if (!row.length) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    const i = row.indexOf(selected);
    selected = row[(i + (e.key === 'ArrowRight' ? 1 : -1) + row.length + (i < 0 ? 1 : 0)) % row.length];
    for (const it of items) it.hover = (it === selected);
  } else if (e.key === 'Enter' && !row.length) {
    e.preventDefault(); decide(q.value);
  } else if (e.key === 'Enter' && (selected || row[0])) {
    e.preventDefault(); openModal((selected || row[0]).rec);
  }
});
q.addEventListener('input', () => { selected = null; });

// Debug handle, localhost only.
if (location.hostname === 'localhost') window.__pile = { items, run, engine, scatter, cache, decide, clearHero, updateHover, pick };
})().catch(e => {
  console.error('pile failed to start:', e);
  document.body.insertAdjacentHTML('beforeend',
    `<pre style="position:fixed;left:16px;bottom:16px;color:#b00;font:12px monospace;z-index:99">${e}</pre>`);
});
