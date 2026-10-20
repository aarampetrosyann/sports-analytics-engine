'use strict';

const TEAM_COLORS = ['#3b82f6', '#ef4444'];
const HUD_INTERVAL = 200; // ms between sidebar refreshes
const STALE_AFTER = 1000; // ms without a frame before the stream counts as stalled
const TRAIL_LEN = 14;

const canvas = document.getElementById('pitch');
const ctx = canvas.getContext('2d');
const pitchView = new PitchView();
const $ = (id) => document.getElementById(id);
const smoothToggle = $('smooth');
const trailToggle = $('trail');

let pitch = { w: 105, h: 68 };
let zones = [];
let teams = ['Home', 'Away'];
let dpr = 1;

// The two most recent frames, used for interpolation.
let prev = null;
let curr = null;
let trail = [];
const zoneFlash = {};
let wireLatency = null;
let lastHud = 0;
let renderFrames = 0;
let renderWindow = performance.now();
let renderFps = 0;
let socketOpen = false;
let goals = [];

// ---------------------------------------------------------------- network

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  setConn('connecting', 'Connecting…');
  ws.onopen = () => { socketOpen = true; setConn('stale', 'Waiting for edge…'); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'hello') onHello(msg);
    else if (msg.type === 'state') onState(msg);
  };
  ws.onclose = () => {
    socketOpen = false;
    setConn('offline', 'Disconnected — retrying');
    setTimeout(connect, 1000);
  };
}

function onHello(msg) {
  pitch = msg.pitch;
  pitchView.setPitch(pitch.w, pitch.h);
  zones = msg.zones;
  teams = msg.teams;
  prev = curr = null;
  trail = [];
  renderEvents((msg.events || []).slice().reverse(), true);
  goals = msg.goals || [];
  renderGoals();
  resize();
}

function onState(msg) {
  const now = performance.now();
  if (curr && msg.seq < curr.msg.seq) { // edge restarted
    prev = null;
    trail = [];
    renderEvents([], true);
    goals = [];
    renderGoals();
  } else {
    prev = curr;
  }
  curr = { msg, at: now, byId: new Map(msg.players.map((p) => [p.id, p])) };

  trail.push({ x: msg.ball.x, y: msg.ball.y });
  if (trail.length > TRAIL_LEN) trail.shift();

  const lat = Date.now() - msg.srvTs;
  wireLatency = wireLatency === null ? lat : wireLatency * 0.9 + lat * 0.1;

  if (msg.events) {
    for (const ev of msg.events) if (ev.type === 'box_entry') zoneFlash[ev.zone] = now;
    renderEvents(msg.events.slice().reverse(), false);
    const scored = msg.events.filter((ev) => ev.type === 'goal');
    if (scored.length) {
      goals.push(...scored);
      renderGoals();
    }
  }
}

function renderGoals() {
  $('goals').innerHTML = goals
    .map((g) => `<li>${teamDot(g.team)}${teams[g.team]} ${fmtClock(g.clock)}</li>`)
    .join('');
}

function setConn(state, text) {
  const el = $('conn');
  if (el.dataset.state === state && el.textContent === text) return;
  el.dataset.state = state;
  el.textContent = text;
}

// ---------------------------------------------------------------- canvas

function resize() {
  dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  pitchView.resize(canvas.width, canvas.height, dpr);
}

// ---------------------------------------------------------------- views

const VIEW_KEY = 'pitch-view';

function setView(name) {
  pitchView.setView(name);
  for (const b of document.querySelectorAll('#views button')) {
    b.setAttribute('aria-pressed', String(b.dataset.view === name));
  }
  try { localStorage.setItem(VIEW_KEY, name); } catch { /* storage unavailable */ }
}

function initViews() {
  const bar = $('views');
  bar.innerHTML = Object.entries(PITCH_VIEWS)
    .map(([name, v]) => `<button type="button" data-view="${name}">${v.label}</button>`)
    .join('');
  bar.addEventListener('click', (ev) => {
    const name = ev.target.closest('button')?.dataset.view;
    if (name) setView(name);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.target.closest('input, textarea') || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const names = Object.keys(PITCH_VIEWS);
    const i = Number(ev.key) - 1;
    if (i >= 0 && i < names.length) setView(names[i]);
  });
  let saved = null;
  try { saved = localStorage.getItem(VIEW_KEY); } catch { /* storage unavailable */ }
  setView(PITCH_VIEWS[saved] ? saved : 'top');
}

function lerp(a, b, t) { return a + (b - a) * t; }

// Positions to draw now. With interpolation on we render one frame behind
// and blend towards the newest frame, which hides network jitter.
function sample(now) {
  const msg = curr.msg;
  if (!smoothToggle.checked || !prev) return { ball: msg.ball, players: msg.players };
  const span = Math.max(1, curr.at - prev.at);
  const t = Math.min(1, (now - curr.at) / span);
  const players = msg.players.map((p) => {
    const q = prev.byId.get(p.id);
    return q ? { ...p, x: lerp(q.x, p.x, t), y: lerp(q.y, p.y, t) } : p;
  });
  const pb = prev.msg.ball;
  return { ball: { x: lerp(pb.x, msg.ball.x, t), y: lerp(pb.y, msg.ball.y, t) }, players };
}

function render(now) {
  requestAnimationFrame(render);

  renderFrames++;
  if (now - renderWindow >= 1000) {
    renderFps = (renderFrames * 1000) / (now - renderWindow);
    renderFrames = 0;
    renderWindow = now;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(pitchView.layer, 0, 0);
  if (!curr) return;

  const stale = now - curr.at > STALE_AFTER;
  if (socketOpen) setConn(stale ? 'stale' : 'live', stale ? 'No signal from edge' : 'Live');

  const msg = curr.msg;
  const s = sample(now);
  const pv = pitchView;

  // Geofences: steady tint while the ball is inside, plus a flash on entry.
  for (const z of zones) {
    const flash = zoneFlash[z.name] ? Math.max(0, 1 - (now - zoneFlash[z.name]) / 800) : 0;
    const alpha = (msg.zones[z.name] ? 0.22 : 0) + flash * 0.35;
    if (alpha <= 0) continue;
    ctx.fillStyle = `rgba(255, 236, 120, ${alpha})`;
    pv.tracePolygon(ctx, [[z.x0, z.y0], [z.x1, z.y0], [z.x1, z.y1], [z.x0, z.y1]]);
    ctx.fill();
  }

  if (trailToggle.checked && trail.length > 1) {
    ctx.lineCap = 'round';
    for (let i = 1; i < trail.length; i++) {
      const a = pv.project(trail[i - 1].x, trail[i - 1].y), b = pv.project(trail[i].x, trail[i].y);
      ctx.strokeStyle = `rgba(255,255,255,${(i / trail.length) * 0.6})`;
      ctx.lineWidth = Math.max(1, 0.35 * b.s * (i / trail.length));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  // Players and ball, far to near so nearer ones overlap farther ones.
  // In perspective views they stand on the grass with a ground shadow.
  const lift = pv.isFlat ? 0 : 1;
  const items = s.players
    .filter((p) => p.active)
    .map((p) => ({ p, g: pv.project(p.x, p.y, 0), c: pv.project(p.x, p.y, lift * 0.95) }));
  const ballGround = pv.project(s.ball.x, s.ball.y, 0);
  items.push({ ball: true, g: ballGround, c: pv.project(s.ball.x, s.ball.y, lift * 0.3) });
  items.sort((a, b) => a.g.y - b.g.y);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const it of items) {
    const { g, c } = it;
    const r = it.ball ? Math.max(4 * dpr, 0.5 * c.s) : Math.max(6.5 * dpr, 0.95 * c.s);
    if (!pv.isFlat) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      ctx.beginPath();
      ctx.ellipse(g.x, g.y, r * 0.95, r * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 3 * dpr;
    ctx.shadowOffsetY = 1.5 * dpr;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fillStyle = it.ball ? '#fff' : TEAM_COLORS[it.p.team];
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = it.ball ? '#222' : 'rgba(255,255,255,0.9)';
    ctx.stroke();
    if (it.ball) continue;
    if (msg.poss.control && msg.poss.player === it.p.id) {
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 2.5 * dpr;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r + 3.5 * dpr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${Math.round(r * 1.05)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(it.p.num, c.x, c.y + 0.5);
  }

  if (now - lastHud >= HUD_INTERVAL) {
    lastHud = now;
    updateHud(msg);
  }
}

// ---------------------------------------------------------------- HUD

const fmtClock = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDist = (d) => (d >= 1000 ? `${(d / 1000).toFixed(2)} km` : `${Math.round(d)} m`);
const teamDot = (t) => `<span class="dot" style="background:${TEAM_COLORS[t]}"></span>`;

function updateHud(msg) {
  $('score-0').textContent = msg.score[0];
  $('score-1').textContent = msg.score[1];
  $('clock').textContent = `${fmtClock(msg.clock)} · ${msg.period === 2 ? '2nd' : '1st'} half`;

  const [home, away] = msg.possPct;
  $('poss-home').style.width = `${home}%`;
  $('poss-away').style.width = `${away}%`;
  $('poss-home-pct').textContent = `${teams[0]} ${home.toFixed(1)}%`;
  $('poss-away-pct').textContent = `${away.toFixed(1)}% ${teams[1]}`;

  const p = msg.poss;
  $('holder').innerHTML = p.control
    ? `${teamDot(p.team)}<strong>#${p.num} ${teams[p.team]}</strong> on the ball <span class="muted">· ${p.dist.toFixed(1)} m</span>`
    : `<span class="muted">Loose ball · nearest</span> ${teamDot(p.team)}#${p.num} ${teams[p.team]} <span class="muted">(${p.dist.toFixed(1)} m)</span>`;

  for (const z of zones) {
    $(`zone-${z.name}`)?.classList.toggle('active', !!msg.zones[z.name]);
    const el = $(`entries-${z.name}`);
    if (el) el.textContent = msg.entries[z.name];
  }

  for (const team of [0, 1]) {
    const rows = msg.players
      .filter((pl) => pl.team === team)
      .sort((a, b) => b.dist - a.dist)
      .map((pl) => `<tr${pl.active ? '' : ' class="off" title="Substituted off"'}><td><span class="num" style="background:${TEAM_COLORS[team]}">${pl.num}</span></td>`
        + `<td>${fmtDist(pl.dist)}</td><td>${(pl.speed * 3.6).toFixed(1)} km/h</td></tr>`)
      .join('');
    $(`dist-${team}`).innerHTML = `<tr><th colspan="3">${teams[team]}</th></tr>${rows}`;
  }

  const st = msg.stats;
  $('t-fps').textContent = `${st.fps.toFixed(1)} Hz`;
  $('t-lost').textContent = `${st.lost}${st.dropped ? ` (+${st.dropped} dropped)` : ''}`;
  $('t-edge').textContent = `${st.edgeLatencyMs.toFixed(1)} ms`;
  $('t-wire').textContent = wireLatency === null ? '–' : `${Math.max(0, wireLatency).toFixed(1)} ms`;
  $('t-proc').textContent = `${st.procUs} µs`;
  $('t-render').textContent = `${renderFps.toFixed(0)} fps`;
}

function describeEvent(ev) {
  const team = ev.team >= 0 ? teams[ev.team] : 'Unknown';
  if (ev.type === 'goal') {
    return { tag: 'GOAL', cls: 'goal', text: `${team} score <span class="muted">· confirmed at kick-off ${fmtClock(ev.confirmed)}</span>` };
  }
  const zone = zones.find((z) => z.name === ev.zone);
  return { tag: 'BOX', cls: '', text: `Ball into ${zone ? zone.label.toLowerCase() : ev.zone} · ${team} in possession` };
}

// Newest events first; `events` must already be newest-first.
function renderEvents(events, replace) {
  const list = $('events');
  if (replace) list.innerHTML = '';
  list.querySelector('.empty')?.remove();
  const html = events.map((ev) => {
    const d = describeEvent(ev);
    return `<li><time>${fmtClock(ev.clock)}</time><span class="tag ${d.cls}">${d.tag}</span><span>${d.text}</span></li>`;
  }).join('');
  list.insertAdjacentHTML('afterbegin', html);
  while (list.children.length > 40) list.lastElementChild.remove();
  if (!list.children.length) list.innerHTML = '<li class="empty">No events yet</li>';
}

new ResizeObserver(resize).observe(canvas);
resize();
initViews();
connect();
requestAnimationFrame(render);
