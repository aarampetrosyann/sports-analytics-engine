'use strict';

// Pitch renderer with a simple camera. The grass and markings are painted
// once into a top-down texture; each view projects that texture onto the
// screen (exactly for flat views, via small triangles for perspective ones)
// and caches the result until the view or canvas size changes.
//
// Pitch coordinates are meters with the origin at the top-left corner
// (x along the length, y across, as in the data). Internally the camera uses
// a right-handed world with z up: W = (x, H - y, z).

const DEG = Math.PI / 180;
const APRON = 4;         // m of grass around the touchlines
const THICKNESS = 1.6;   // m, depth of the pitch slab's visible edge
const TEX_SCALE = 14;    // texture px per meter
const MESH = [36, 24];   // perspective subdivision (cells along x, y)
const MOW_GRID = [11, 7]; // mowing-pattern cells along the length and width

const PITCH_VIEWS = {
  top: { label: 'Top', yaw: 90, pitch: 90 },
  portrait: { label: 'Portrait', yaw: 0, pitch: 90 },
  broadside: { label: 'Broadside', yaw: 90, pitch: 26, dist: 125 },
  end: { label: 'End', yaw: 0, pitch: 34, dist: 110 },
};

class PitchView {
  constructor(w = 105, h = 68) {
    this.w = w;
    this.h = h;
    this.layer = document.createElement('canvas');
    this.texture = null;
    this.viewName = 'top';
    this.cam = null;
    this.dpr = 1;
    this.width = 1;
    this.height = 1;
  }

  setPitch(w, h) {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.texture = null;
    this.layout();
  }

  setView(name) {
    if (!PITCH_VIEWS[name]) return;
    this.viewName = name;
    this.layout();
  }

  resize(width, height, dpr) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = dpr;
    this.layer.width = this.width;
    this.layer.height = this.height;
    this.layout();
  }

  get isFlat() {
    return PITCH_VIEWS[this.viewName].pitch === 90;
  }

  // ------------------------------------------------------------- camera

  layout() {
    const v = PITCH_VIEWS[this.viewName];
    const yaw = v.yaw * DEG;
    const el = v.pitch * DEG;
    const h = [Math.cos(yaw), Math.sin(yaw), 0];
    const f = [Math.cos(el) * h[0], Math.cos(el) * h[1], -Math.sin(el)];
    const r = [Math.sin(yaw), -Math.cos(yaw), 0];
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const center = [this.w / 2, this.h / 2, 0];
    const d = v.dist || 0;
    const eye = center.map((c, i) => c - f[i] * d);
    this.cam = { f, r, u, eye, ortho: !v.dist, k: 1, ox: 0, oy: 0 };

    // Fit the whole slab (top and bottom edges) into the canvas.
    const pad = 28 * this.dpr;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of this.slabCorners()) {
      for (const z of [0, -THICKNESS]) {
        const p = this.project(x, y, z);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    const k = Math.min((this.width - 2 * pad) / (maxX - minX), (this.height - 2 * pad) / (maxY - minY));
    this.cam.k = k;
    this.cam.ox = this.width / 2 - k * (minX + maxX) / 2;
    this.cam.oy = this.height / 2 - k * (minY + maxY) / 2;
    this.drawLayer();
  }

  // Screen position of a pitch point, plus `s`: screen pixels per meter there.
  project(x, y, z = 0) {
    const c = this.cam;
    const vx = x - c.eye[0], vy = (this.h - y) - c.eye[1], vz = z - c.eye[2];
    const sx = vx * c.r[0] + vy * c.r[1] + vz * c.r[2];
    const sy = vx * c.u[0] + vy * c.u[1] + vz * c.u[2];
    const s = c.ortho ? 1 : 1 / (vx * c.f[0] + vy * c.f[1] + vz * c.f[2]);
    return { x: c.ox + c.k * sx * s, y: c.oy - c.k * sy * s, s: c.k * s };
  }

  // Side i runs from slabCorners()[i] to [i + 1]: the far touchline, the
  // right goal line, the near touchline, the left goal line.
  sideFacesCamera(i) {
    const a = APRON;
    // Outward normal and a point on the side, in camera world coordinates.
    const sides = [
      [[0, 1, 0], [this.w / 2, this.h + a]],
      [[1, 0, 0], [this.w + a, this.h / 2]],
      [[0, -1, 0], [this.w / 2, -a]],
      [[-1, 0, 0], [-a, this.h / 2]],
    ];
    const [n, [px, py]] = sides[i];
    const c = this.cam;
    const toEye = c.ortho
      ? c.f.map((v) => -v)
      : [c.eye[0] - px, c.eye[1] - py, c.eye[2] + THICKNESS / 2];
    return n[0] * toEye[0] + n[1] * toEye[1] + n[2] * toEye[2] > 1e-6;
  }

  slabCorners() {
    const a = APRON;
    return [[-a, -a], [this.w + a, -a], [this.w + a, this.h + a], [-a, this.h + a]];
  }

  // Traces a pitch-plane polygon (array of [x, y]) as a screen path.
  tracePolygon(ctx, pts, z = 0) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const p = this.project(x, y, z);
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    });
    ctx.closePath();
  }

  // ------------------------------------------------------------- drawing

  drawLayer() {
    if (!this.texture) this.texture = makeGrassTexture(this.w, this.h);
    const g = this.layer.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.layer.width, this.layer.height);

    const corners = this.slabCorners();
    const top = corners.map(([x, y]) => this.project(x, y, 0));
    const bottom = corners.map(([x, y]) => this.project(x, y, -THICKNESS));

    // Only the sides facing the camera are drawn; the far ones are hidden
    // behind the slab (drawing them would show its inside).
    const sides = [0, 1, 2, 3].filter((i) => this.sideFacesCamera(i));

    // Slab body with a soft drop shadow: one path so the shadow is drawn once.
    g.save();
    g.beginPath();
    const sub = (pts) => {
      pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
    };
    sub(top);
    for (const i of sides) {
      const j = (i + 1) % 4;
      sub([top[i], top[j], bottom[j], bottom[i]]);
    }
    g.shadowColor = 'rgba(30, 40, 20, 0.35)';
    g.shadowBlur = 26 * this.dpr;
    g.shadowOffsetY = 14 * this.dpr;
    g.fillStyle = '#3d7a1c';
    g.fill('nonzero');
    g.restore();

    // Slab edges, darker towards the bottom.
    for (const i of sides) {
      const j = (i + 1) % 4;
      const grad = g.createLinearGradient(0, Math.min(top[i].y, top[j].y), 0, Math.max(bottom[i].y, bottom[j].y));
      grad.addColorStop(0, '#4f8f26');
      grad.addColorStop(1, '#2f6514');
      g.fillStyle = grad;
      g.beginPath();
      [top[i], top[j], bottom[j], bottom[i]].forEach((p, n) => (n ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
      g.fill();
    }

    this.drawTexture(g);
  }

  // Maps the top-down texture onto the projected pitch surface.
  drawTexture(g) {
    const [nx, ny] = this.isFlat ? [1, 1] : MESH;
    const a = APRON;
    const W = this.w + 2 * a, H = this.h + 2 * a;
    const tex = this.texture;
    const grid = [];
    for (let j = 0; j <= ny; j++) {
      const row = [];
      for (let i = 0; i <= nx; i++) {
        const x = -a + (W * i) / nx, y = -a + (H * j) / ny;
        row.push({ u: (x + a) * TEX_SCALE, v: (y + a) * TEX_SCALE, ...this.project(x, y, 0) });
      }
      grid.push(row);
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const p00 = grid[j][i], p10 = grid[j][i + 1], p11 = grid[j + 1][i + 1], p01 = grid[j + 1][i];
        drawTexturedTriangle(g, tex, p00, p10, p11, !this.isFlat);
        drawTexturedTriangle(g, tex, p00, p11, p01, !this.isFlat);
      }
    }
  }
}

// Draws the part of `tex` inside triangle (a, b, c) with an affine map from
// texture (u, v) to screen (x, y). Slightly enlarged to hide seams.
function drawTexturedTriangle(g, tex, a, b, c, grow) {
  const du1 = b.u - a.u, dv1 = b.v - a.v, du2 = c.u - a.u, dv2 = c.v - a.v;
  const det = du1 * dv2 - du2 * dv1;
  if (Math.abs(det) < 1e-9) return;
  const dx1 = b.x - a.x, dy1 = b.y - a.y, dx2 = c.x - a.x, dy2 = c.y - a.y;
  const m11 = (dx1 * dv2 - dx2 * dv1) / det;
  const m12 = (dy1 * dv2 - dy2 * dv1) / det;
  const m21 = (dx2 * du1 - dx1 * du2) / det;
  const m22 = (dy2 * du1 - dy1 * du2) / det;
  const e = a.x - m11 * a.u - m21 * a.v;
  const f = a.y - m12 * a.u - m22 * a.v;

  g.save();
  g.beginPath();
  const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3;
  for (const [n, p] of [a, b, c].entries()) {
    let x = p.x, y = p.y;
    if (grow) {
      const dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy) || 1;
      x += (dx / l) * 0.7;
      y += (dy / l) * 0.7;
    }
    n ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.closePath();
  g.clip();
  g.setTransform(m11, m12, m21, m22, e, f);
  const u0 = Math.max(0, Math.floor(Math.min(a.u, b.u, c.u)) - 2);
  const v0 = Math.max(0, Math.floor(Math.min(a.v, b.v, c.v)) - 2);
  const u1 = Math.min(tex.width, Math.ceil(Math.max(a.u, b.u, c.u)) + 2);
  const v1 = Math.min(tex.height, Math.ceil(Math.max(a.v, b.v, c.v)) + 2);
  g.drawImage(tex, u0, v0, u1 - u0, v1 - v0, u0, v0, u1 - u0, v1 - v0);
  g.restore();
}

// Paints the grass and markings top-down, TEX_SCALE px per meter.
function makeGrassTexture(w, h) {
  const a = APRON;
  const tex = document.createElement('canvas');
  tex.width = Math.round((w + 2 * a) * TEX_SCALE);
  tex.height = Math.round((h + 2 * a) * TEX_SCALE);
  const g = tex.getContext('2d');

  g.fillStyle = '#66a832';
  g.fillRect(0, 0, tex.width, tex.height);

  // Work in meters from here on, origin at the pitch's top-left corner.
  g.setTransform(TEX_SCALE, 0, 0, TEX_SCALE, a * TEX_SCALE, a * TEX_SCALE);

  // Mowing pattern: a crisp checkerboard that tiles the pitch exactly from
  // corner to corner and continues into the apron. On 105 x 68 m an 11 x 7
  // grid gives near-square 9.55 x 9.71 m cells; odd counts put the centre
  // spot in the middle of a cell and give all four corners the same shade.
  const [cols, rows] = MOW_GRID;
  const cw = w / cols, ch = h / rows;
  g.fillStyle = 'rgba(22, 74, 4, 0.16)';
  for (let i = -Math.ceil(a / cw); i < cols + Math.ceil(a / cw); i++) {
    for (let j = -Math.ceil(a / ch); j < rows + Math.ceil(a / ch); j++) {
      if ((i + j) % 2 === 0) continue;
      g.fillRect(i * cw, j * ch, cw, ch);
    }
  }

  // Sunlit patches around the centre circle and penalty spots.
  const glow = (x, y, r, alpha) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(218, 242, 112, ${alpha})`);
    grad.addColorStop(1, 'rgba(218, 242, 112, 0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
  };
  glow(w / 2, h / 2, 24, 0.3);
  glow(11, h / 2, 14, 0.26);
  glow(w - 11, h / 2, 14, 0.26);
  glow(w / 4, h / 2, 26, 0.1);
  glow((3 * w) / 4, h / 2, 26, 0.1);

  // Gentle darkening towards the edges and corners.
  const vignette = g.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, w * 0.68);
  vignette.addColorStop(0, 'rgba(0, 30, 0, 0)');
  vignette.addColorStop(1, 'rgba(0, 30, 0, 0.24)');
  g.fillStyle = vignette;
  g.fillRect(-a, -a, w + 2 * a, h + 2 * a);

  // Grass grain: per-pixel noise, deterministic so it never shimmers.
  g.setTransform(1, 0, 0, 1, 0, 0);
  const img = g.getImageData(0, 0, tex.width, tex.height);
  const px = img.data;
  let seed = 1234567;
  for (let i = 0; i < px.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = ((seed >> 8) % 23) - 11;
    px[i] += n * 0.6;
    px[i + 1] += n;
    px[i + 2] += n * 0.4;
  }
  g.putImageData(img, 0, 0);

  // Markings.
  g.setTransform(TEX_SCALE, 0, 0, TEX_SCALE, a * TEX_SCALE, a * TEX_SCALE);
  g.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  g.fillStyle = 'rgba(255, 255, 255, 0.92)';
  g.lineWidth = 0.14;
  const circle = (x, y, r, a0 = 0, a1 = Math.PI * 2, fill = false) => {
    g.beginPath();
    g.arc(x, y, r, a0, a1);
    fill ? g.fill() : g.stroke();
  };
  g.strokeRect(0, 0, w, h);
  g.beginPath();
  g.moveTo(w / 2, 0);
  g.lineTo(w / 2, h);
  g.stroke();
  circle(w / 2, h / 2, 9.15);
  circle(w / 2, h / 2, 0.3, 0, Math.PI * 2, true);

  const boxW = 40.32, sixW = 18.32, goalW = 7.32;
  const arc = Math.acos(5.5 / 9.15);
  for (const side of [0, 1]) {
    const spot = side ? w - 11 : 11;
    g.strokeRect(side ? w - 16.5 : 0, (h - boxW) / 2, 16.5, boxW);
    g.strokeRect(side ? w - 5.5 : 0, (h - sixW) / 2, 5.5, sixW);
    circle(spot, h / 2, 0.3, 0, Math.PI * 2, true);
    if (side) circle(spot, h / 2, 9.15, Math.PI - arc, Math.PI + arc);
    else circle(spot, h / 2, 9.15, -arc, arc);
    // Goal frame and net behind the line.
    const gx = side ? w : -2;
    g.fillStyle = 'rgba(255, 255, 255, 0.22)';
    g.fillRect(gx, (h - goalW) / 2, 2, goalW);
    g.fillStyle = 'rgba(255, 255, 255, 0.92)';
    g.strokeRect(gx, (h - goalW) / 2, 2, goalW);
  }
  for (const [cx, cy, a0] of [[0, 0, 0], [w, 0, Math.PI / 2], [w, h, Math.PI], [0, h, Math.PI * 1.5]]) {
    circle(cx, cy, 1, a0, a0 + Math.PI / 2);
  }
  return tex;
}
