'use strict';

const TEAM_COLORS = ['#3b82f6', '#ef4444'];
const MARGIN = 4; // meters of surround drawn around the pitch
const HUD_INTERVAL = 200; // ms between sidebar refreshes
const STALE_AFTER = 1000; // ms without a frame before the stream counts as stalled
const TRAIL_LEN = 14;

const canvas = document.getElementById('pitch');
const ctx = canvas.getContext('2d');
const pitchLayer = document.createElement('canvas');
const $ = (id) => document.getElementById(id);
const smoothToggle = $('smooth');
const trailToggle = $('trail');

let pitch = { w: 105, h: 68 };
let zones = [];
let teams = ['Home', 'Away'];
let view = { scale: 1, ox: 0, oy: 0 };

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
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = pitchLayer.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = pitchLayer.height = Math.max(1, Math.round(rect.height * dpr));

  const fullW = pitch.w + MARGIN * 2;
  const fullH = pitch.h + MARGIN * 2;
  const scale = Math.min(canvas.width / fullW, canvas.height / fullH);
  view = {
    scale,
    ox: (canvas.width - pitch.w * scale) / 2,
    oy: (canvas.height - pitch.h * scale) / 2,
    dpr,
  };
  drawPitch();
}

const px = (x) => view.ox + x * view.scale;
const py = (y) => view.oy + y * view.scale;
const m = (d) => d * view.scale;

function drawPitch() {
  const g = pitchLayer.getContext('2d');
  const { w, h } = pitch;
  g.fillStyle = '#0b2a17';
  g.fillRect(0, 0, pitchLayer.width, pitchLayer.height);

  // Mowing stripes.
  const stripes = 14;
  for (let i = 0; i < stripes; i++) {
    g.fillStyle = i % 2 ? '#1c6b38' : '#1a6334';
    g.fillRect(px((w / stripes) * i), py(0), m(w / stripes) + 1, m(h));
  }

  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = Math.max(1.5, m(0.12));
  const rect = (x, y, rw, rh) => g.strokeRect(px(x), py(y), m(rw), m(rh));
  const circle = (x, y, r, a0 = 0, a1 = Math.PI * 2, fill = false) => {
    g.beginPath();
    g.arc(px(x), py(y), m(r), a0, a1);
    fill ? g.fill() : g.stroke();
  };

  rect(0, 0, w, h);
  g.beginPath();
  g.moveTo(px(w / 2), py(0));
  g.lineTo(px(w / 2), py(h));
  g.stroke();
  circle(w / 2, h / 2, 9.15);
  circle(w / 2, h / 2, 0.3, 0, Math.PI * 2, true);

  const boxW = 40.32, sixW = 18.32, goalW = 7.32;
  const arc = Math.acos(5.5 / 9.15);
  for (const side of [0, 1]) {
    const x0 = side ? w - 16.5 : 0;
    const x6 = side ? w - 5.5 : 0;
    const spot = side ? w - 11 : 11;
    rect(x0, (h - boxW) / 2, 16.5, boxW);
    rect(x6, (h - sixW) / 2, 5.5, sixW);
    circle(spot, h / 2, 0.3, 0, Math.PI * 2, true);
    if (side) circle(spot, h / 2, 9.15, Math.PI - arc, Math.PI + arc);
    else circle(spot, h / 2, 9.15, -arc, arc);
    rect(side ? w : -2, (h - goalW) / 2, 2, goalW);
  }
  for (const [cx, cy, a0] of [[0, 0, 0], [w, 0, Math.PI / 2], [w, h, Math.PI], [0, h, Math.PI * 1.5]]) {
    circle(cx, cy, 1, a0, a0 + Math.PI / 2);
  }
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

  ctx.drawImage(pitchLayer, 0, 0);
  if (!curr) return;

  const stale = now - curr.at > STALE_AFTER;
  if (socketOpen) setConn(stale ? 'stale' : 'live', stale ? 'No signal from edge' : 'Live');

  const msg = curr.msg;
  const s = sample(now);

  // Geofences: steady tint while the ball is inside, plus a flash on entry.
  for (const z of zones) {
    const flash = zoneFlash[z.name] ? Math.max(0, 1 - (now - zoneFlash[z.name]) / 800) : 0;
    const alpha = (msg.zones[z.name] ? 0.16 : 0) + flash * 0.3;
    if (alpha <= 0) continue;
    ctx.fillStyle = `rgba(250, 204, 21, ${alpha})`;
    ctx.fillRect(px(z.x0), py(z.y0), m(z.x1 - z.x0), m(z.y1 - z.y0));
  }

  if (trailToggle.checked && trail.length > 1) {
    ctx.lineCap = 'round';
    for (let i = 1; i < trail.length; i++) {
      ctx.strokeStyle = `rgba(255,255,255,${(i / trail.length) * 0.5})`;
      ctx.lineWidth = Math.max(1, m(0.35) * (i / trail.length));
      ctx.beginPath();
      ctx.moveTo(px(trail[i - 1].x), py(trail[i - 1].y));
      ctx.lineTo(px(trail[i].x), py(trail[i].y));
      ctx.stroke();
    }
  }

  const r = Math.max(7 * view.dpr, m(0.95));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.round(r * 1.05)}px ui-sans-serif, system-ui, sans-serif`;
  for (const p of s.players) {
    if (!p.active) continue; // substituted off
    const x = px(p.x), y = py(p.y);
    if (msg.poss.control && msg.poss.player === p.id) {
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 2.5 * view.dpr;
      ctx.beginPath();
      ctx.arc(x, y, r + 4 * view.dpr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = TEAM_COLORS[p.team];
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1.5 * view.dpr;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText(p.num, x, y + 0.5);
  }

  const br = Math.max(4 * view.dpr, m(0.5));
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 1.5 * view.dpr;
  ctx.beginPath();
  ctx.arc(px(s.ball.x), py(s.ball.y), br, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

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
connect();
requestAnimationFrame(render);
