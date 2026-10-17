/*
 * Vendored from "Orienteering 3D" (https://claude.ai/artifact/A8dqe89rvxzyN29Az3W29D),
 * MIT licensed, see LICENSE in this folder. Changes for otest: an ES module instead of a
 * window global, and the colour space API of current three.js.
 */
/* Procedural textures for the Steinshøgda world, painted on canvases at load time.
 * Everything is generated here so the page needs no image assets.
 * OTex.build(THREE, renderer) -> { bark: {...}, foliage: {...}, ground: {...}, ... } */

  // small deterministic RNG
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  const rgb = (r, g, b, a) => a === undefined ? `rgb(${r | 0},${g | 0},${b | 0})` : `rgba(${r | 0},${g | 0},${b | 0},${a})`;
  const jit = (R, c, j) => c.map((v) => Math.max(0, Math.min(255, v + (R() - 0.5) * 2 * j)));

  // value noise on a wrapping lattice (for tileable textures)
  function makeNoise(seed, period) {
    const R = rng(seed), P = period, g = new Float32Array(P * P);
    for (let i = 0; i < g.length; i++) g[i] = R();
    const at = (x, y) => g[((y % P + P) % P) * P + ((x % P + P) % P)];
    return (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
      const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
      return (at(xi, yi) * (1 - u) + at(xi + 1, yi) * u) * (1 - v) + (at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u) * v;
    };
  }
  function fbm(n, x, y, oct) {
    let s = 0, a = 0.5, f = 1, t = 0;
    for (let i = 0; i < oct; i++) { s += a * n(x * f, y * f); t += a; a *= 0.5; f *= 2; }
    return s / t;
  }
  // fill a canvas with a per-pixel function (tileable when the noise period divides the size)
  function pixelFill(c, fn) {
    const x = c.getContext('2d'), im = x.createImageData(c.width, c.height), d = im.data;
    for (let j = 0; j < c.height; j++) for (let i = 0; i < c.width; i++) {
      const o = (j * c.width + i) * 4, v = fn(i, j);
      d[o] = v[0]; d[o + 1] = v[1]; d[o + 2] = v[2]; d[o + 3] = v[3] === undefined ? 255 : v[3];
    }
    x.putImageData(im, 0, 0);
  }
  // draw something 9 times so it wraps around the edges of a tileable texture
  function wrapDraw(c, S, fn) {
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) { c.save(); c.translate(dx, dy); fn(); c.restore(); }
  }

  // ------------------------------------------------------------------ bark
  function barkSpruce() {
    const W = 256, H = 512, cv = canvas(W, H), c = cv.getContext('2d'), R = rng(11);
    const n = makeNoise(3, 32);
    pixelFill(cv, (i, j) => {
      const v = fbm(n, i / 16, j / 48, 4);
      const b = 70 + v * 60;
      return [b * 0.95, b * 0.82, b * 0.7];
    });
    // scales
    for (let k = 0; k < 900; k++) {
      const x = R() * W, y = R() * H, w = 6 + R() * 10, h = 4 + R() * 7;
      const t = 60 + R() * 70;
      c.fillStyle = rgb(t * 1.0, t * 0.85, t * 0.72, 0.85);
      c.beginPath(); c.ellipse(x, y, w, h, (R() - 0.5) * 0.4, 0, 6.283); c.fill();
      c.strokeStyle = rgb(30, 24, 20, 0.55); c.lineWidth = 1; c.stroke();
    }
    // lichen
    for (let k = 0; k < 120; k++) {
      c.fillStyle = rgb(120 + R() * 40, 135 + R() * 30, 100 + R() * 20, 0.35);
      c.beginPath(); c.arc(R() * W, R() * H, 2 + R() * 6, 0, 6.283); c.fill();
    }
    return cv;
  }
  function barkPine() {
    const W = 256, H = 512, cv = canvas(W, H), c = cv.getContext('2d'), R = rng(12);
    const n = makeNoise(4, 32);
    pixelFill(cv, (i, j) => {
      const v = fbm(n, i / 10, j / 30, 4);
      return [96 + v * 50, 62 + v * 30, 42 + v * 20];
    });
    for (let k = 0; k < 1400; k++) {
      const x = R() * W, y = R() * H, w = 3 + R() * 6, h = 6 + R() * 12, t = R();
      c.fillStyle = rgb(150 + t * 60, 92 + t * 34, 56 + t * 20, 0.55);
      c.beginPath(); c.ellipse(x, y, w, h, (R() - 0.5) * 0.3, 0, 6.283); c.fill();
    }
    for (let k = 0; k < 160; k++) { // dark furrows
      const x = R() * W, y = R() * H, l = 12 + R() * 40;
      c.strokeStyle = rgb(38, 26, 20, 0.6); c.lineWidth = 1.5 + R() * 1.5;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + (R() - 0.5) * 6, y + l); c.stroke();
    }
    return cv;
  }
  function barkBirch() {
    const W = 256, H = 512, cv = canvas(W, H), c = cv.getContext('2d'), R = rng(13);
    const n = makeNoise(5, 32);
    pixelFill(cv, (i, j) => {
      const v = fbm(n, i / 20, j / 30, 4);
      const b = 215 + v * 35;
      return [b, b * 0.98, b * 0.94];
    });
    for (let k = 0; k < 260; k++) { // lenticels
      const x = R() * W, y = R() * H, w = 4 + R() * 22, h = 1 + R() * 2.5;
      c.fillStyle = rgb(40 + R() * 30, 36 + R() * 25, 34 + R() * 20, 0.85);
      c.fillRect(x - w / 2, y, w, h);
    }
    for (let k = 0; k < 30; k++) { // dark patches
      c.fillStyle = rgb(35, 32, 30, 0.75);
      c.beginPath(); c.ellipse(R() * W, R() * H, 5 + R() * 18, 3 + R() * 10, R(), 0, 6.283); c.fill();
    }
    // darker, cracked foot of the trunk (v near 0 = bottom)
    const g = c.createLinearGradient(0, H, 0, H * 0.78);
    g.addColorStop(0, 'rgba(45,40,35,0.95)'); g.addColorStop(1, 'rgba(45,40,35,0)');
    c.fillStyle = g; c.fillRect(0, H * 0.78, W, H * 0.22);
    return cv;
  }

  // ------------------------------------------------------------------ foliage (RGBA)
  function spruceBranch() {
    // a spruce branch seen from above: main axis from the trunk (left) to the tip (right),
    // pinnate side shoots densely covered in short needles, with gaps between them
    const W = 256, H = 256, cv = canvas(W, H), c = cv.getContext('2d'), R = rng(21);
    const shoot = (x0, y0, ang, len, w0, lvl) => {
      const steps = Math.max(3, len / 3 | 0);
      let x = x0, y = y0, a = ang;
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const nx = x + Math.cos(a) * len / steps, ny = y + Math.sin(a) * len / steps;
        c.strokeStyle = rgb(62, 46, 32); c.lineWidth = Math.max(0.8, w0 * (1 - t));
        c.beginPath(); c.moveTo(x, y); c.lineTo(nx, ny); c.stroke();
        // needles: short, dense, mostly pointing forward and to both sides
        const nl = (lvl === 0 ? 5.5 : 4.2) * (1 - t * 0.35);
        const tip = t > 0.75;
        for (let k = 0; k < 6; k++) {
          const side = k % 2 ? 1 : -1, aa = a + side * (0.5 + R() * 0.7);
          const g = tip ? 95 + R() * 40 : 48 + R() * 38;
          c.strokeStyle = tip ? rgb(70 + R() * 25, g, 45 + R() * 15) : rgb(22 + R() * 18, g, 32 + R() * 18);
          c.lineWidth = 1.3;
          c.beginPath(); c.moveTo(nx, ny); c.lineTo(nx + Math.cos(aa) * nl, ny + Math.sin(aa) * nl); c.stroke();
        }
        if (lvl === 0 && s % 2 === 0 && s > 0 && s < steps - 2) {
          const sl = len * (0.36 - t * 0.22) * (0.8 + R() * 0.4);
          shoot(nx, ny, a - 0.75 - R() * 0.2, sl, 1.6, 1);
          shoot(nx, ny, a + 0.75 + R() * 0.2, sl, 1.6, 1);
        }
        x = nx; y = ny; a += (R() - 0.5) * 0.12;
      }
    };
    shoot(4, H / 2, 0, W - 14, 3.2, 0);
    return cv;
  }
  function pineTuft() {
    // Scots pine shoots: twigs fanning out from a branch end, each densely set with long, paired,
    // blue-green needles pointing forward; the youngest needles at the tips are lighter.
    const S = 256, cv = canvas(S, S), c = cv.getContext('2d'), R = rng(22);
    const shoots = [];
    for (let i = 0; i < 9; i++) {
      const a = -Math.PI / 2 + (i - 4) * 0.25 + (R() - 0.5) * 0.2;
      const L = 118 + R() * 46, x0 = S / 2 + (R() - 0.5) * 24, y0 = S - 4 - R() * 14;
      shoots.push({ a, L, x0, y0, bend: (R() - 0.5) * 0.5, depth: R() });
    }
    // far shoots first (darker), near shoots last
    shoots.sort((p, q) => p.depth - q.depth);
    const needle = (x, y, ang, len, col, w) => {
      const mx_ = x + Math.cos(ang) * len * 0.5 + Math.cos(ang + 1.57) * len * 0.06, my_ = y + Math.sin(ang) * len * 0.5 + Math.sin(ang + 1.57) * len * 0.06;
      c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round';
      c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(mx_, my_, x + Math.cos(ang) * len, y + Math.sin(ang) * len); c.stroke();
    };
    shoots.forEach((sh) => {
      const shade = 0.72 + 0.28 * sh.depth, steps = Math.round(sh.L / 2.6);
      let x = sh.x0, y = sh.y0, a = sh.a;
      const pts = [];
      for (let k = 0; k <= steps; k++) {
        pts.push([x, y, a]);
        const nx = x + Math.cos(a) * sh.L / steps, ny = y + Math.sin(a) * sh.L / steps;
        x = nx; y = ny; a += sh.bend / steps;
      }
      // twig
      c.strokeStyle = rgb(120 * shade, 82 * shade, 52 * shade); c.lineWidth = 2.6; c.lineCap = 'round';
      c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); pts.forEach(([px, py]) => c.lineTo(px, py)); c.stroke();
      // needle pairs along the outer two thirds, longest in the middle, short at the tip
      pts.forEach(([px, py, pa], k) => {
        const t = k / steps;
        if (t < 0.28) return;
        const len = (20 + 14 * Math.sin(Math.PI * Math.min(1, (t - 0.28) / 0.8))) * (0.85 + R() * 0.3) * (t > 0.92 ? 0.6 : 1);
        const young = t > 0.78;
        for (const sd of [-1, 1]) {
          const ang = pa + sd * (0.5 + R() * 0.45) - sd * 0.1;
          const g = (young ? 128 + R() * 30 : 92 + R() * 32) * shade;
          const col = young ? rgb(96 * shade + R() * 18, g, 78 * shade + R() * 12) : rgb(56 * shade + R() * 16, g * 0.96, 72 * shade + R() * 16);
          needle(px, py, ang, len, col, 1.25);
          needle(px + Math.cos(pa) * 1.2, py + Math.sin(pa) * 1.2, ang + sd * 0.12, len * 0.95, col, 1.1);
        }
      });
      // bud and a crown of short needles at the tip
      const [tx, ty, ta] = pts[pts.length - 1];
      for (let k = 0; k < 14; k++) needle(tx, ty, ta + (R() - 0.5) * 1.6, 10 + R() * 9, rgb(100 * shade, 140 * shade, 84 * shade), 1.1);
      c.fillStyle = rgb(128, 92, 62); c.beginPath(); c.ellipse(tx, ty, 1.8, 3.0, ta + 1.57, 0, 6.283); c.fill();
    });
    return cv;
  }
  function birchLeaves() {
    const W = 256, H = 256, cv = canvas(W, H), c = cv.getContext('2d'), R = rng(23);
    c.strokeStyle = rgb(70, 50, 40); c.lineWidth = 2;
    for (let b = 0; b < 7; b++) {
      c.beginPath(); c.moveTo(W / 2, H - 4);
      c.quadraticCurveTo(W / 2 + (R() - 0.5) * 120, H / 2, 20 + R() * (W - 40), 20 + R() * (H - 60)); c.stroke();
    }
    for (let k = 0; k < 520; k++) {
      const x = 16 + R() * (W - 32), y = 14 + R() * (H - 40), s = 7 + R() * 7, a = R() * 6.283;
      const dx = x - W / 2, dy = y - H / 2;
      if (dx * dx / (W * W * 0.2) + dy * dy / (H * H * 0.19) > 1) continue;
      const g = 100 + R() * 60;
      c.fillStyle = rgb(70 + R() * 45, g, 40 + R() * 30);
      c.save(); c.translate(x, y); c.rotate(a);
      c.beginPath(); c.moveTo(-s, 0); c.quadraticCurveTo(-s * 0.2, -s * 0.8, s, 0); c.quadraticCurveTo(-s * 0.2, s * 0.8, -s, 0); c.fill();
      c.strokeStyle = rgb(50, g * 0.75, 30, 0.6); c.lineWidth = 0.8; c.beginPath(); c.moveTo(-s, 0); c.lineTo(s, 0); c.stroke();
      c.restore();
    }
    return cv;
  }
  function bushLeaves() {
    // deciduous shrub (willow/hazel-like): twigs with clusters of narrow leaves and gaps between
    const W = 256, H = 256, cv = canvas(W, H), c = cv.getContext('2d'), R = rng(24);
    const tips = [];
    for (let b = 0; b < 9; b++) {
      const a = -Math.PI / 2 + (R() - 0.5) * 2.4, L = 70 + R() * 60;
      const x1 = W / 2 + Math.cos(a) * L, y1 = H - 6 + Math.sin(a) * L;
      c.strokeStyle = rgb(70, 52, 40); c.lineWidth = 2.2;
      c.beginPath(); c.moveTo(W / 2 + (R() - 0.5) * 20, H - 2); c.quadraticCurveTo(W / 2 + (x1 - W / 2) * 0.3, H - 40, x1, y1); c.stroke();
      tips.push([x1, y1], [(W / 2 + x1) / 2, (H + y1) / 2 - 10]);
    }
    tips.forEach(([x, y]) => {
      for (let k = 0; k < 26; k++) {
        const a = R() * 6.283, r = R() * 26, lx = x + Math.cos(a) * r, ly = y + Math.sin(a) * r * 0.8;
        const g = 72 + R() * 50, s = 5 + R() * 4;
        c.fillStyle = rgb(42 + R() * 30, g, 30 + R() * 20);
        c.save(); c.translate(lx, ly); c.rotate(a);
        c.beginPath(); c.ellipse(0, 0, s, s * 0.42, 0, 0, 6.283); c.fill(); c.restore();
      }
    });
    return cv;
  }
  // ground cover cards (bottom of the texture = ground)
  function coverCard(kind) {
    const S = 256, cv = canvas(S, S), c = cv.getContext('2d');
    const R = rng({ blueberry: 31, fern: 32, grass: 33, heather: 34, sedge: 35, dry: 36 }[kind]);
    const leaf = (x, y, rx, ry, rot, col) => { c.save(); c.translate(x, y); c.rotate(rot); c.fillStyle = col; c.beginPath(); c.ellipse(0, 0, rx, ry, 0, 0, 6.283); c.fill(); c.restore(); };
    if (kind === 'grass' || kind === 'sedge' || kind === 'dry') {
      const n = kind === 'grass' ? 60 : 80;
      for (let i = 0; i < n; i++) {
        const x0 = S / 2 + (R() - 0.5) * 170, lean = (R() - 0.5) * 140, top = 15 + R() * 140;
        let col;
        if (kind === 'grass') col = [62 + R() * 50, 92 + R() * 45, 34 + R() * 22];
        else if (kind === 'sedge') col = [100 + R() * 40, 104 + R() * 32, 48 + R() * 18];
        else col = [140 + R() * 40, 126 + R() * 32, 78 + R() * 24];
        // tapering blade
        const mx_ = x0 + lean * 0.25, my_ = S * 0.6, w = 1.5 + R() * 2.2;
        c.fillStyle = rgb(...col);
        c.beginPath(); c.moveTo(x0 - w, S); c.quadraticCurveTo(mx_ - w * 0.5, my_, x0 + lean, top);
        c.quadraticCurveTo(mx_ + w * 0.5, my_, x0 + w, S); c.closePath(); c.fill();
      }
    } else if (kind === 'fern') {
      for (let f = 0; f < 9; f++) {
        const base = -Math.PI / 2 + (f - 4) * 0.28 + (R() - 0.5) * 0.12, len = 150 + R() * 70;
        let x = S / 2, y = S, a = base;
        for (let t = 0; t < 1; t += 0.035) {
          a += (base < -Math.PI / 2 ? -1 : 1) * 0.022;
          const nx = x + Math.cos(a) * len * 0.035, ny = y + Math.sin(a) * len * 0.035;
          c.strokeStyle = rgb(60, 90, 35); c.lineWidth = 2; c.beginPath(); c.moveTo(x, y); c.lineTo(nx, ny); c.stroke();
          const w = (1 - t) * (1 - Math.abs(t - 0.35)) * 26 + 3, g = 100 + R() * 70;
          for (const sg of [1, -1]) {
            const px = nx + Math.cos(a + sg * 1.4) * w * 0.55, py = ny + Math.sin(a + sg * 1.4) * w * 0.55;
            leaf(px, py, w * 0.55, 3.2, a + sg * 1.4, rgb(55 + R() * 40, g, 35));
          }
          x = nx; y = ny;
        }
      }
    } else if (kind === 'blueberry') {
      for (let i = 0; i < 45; i++) { c.strokeStyle = rgb(60, 95, 40); c.lineWidth = 2; const x = S / 2 + (R() - 0.5) * 200; c.beginPath(); c.moveTo(S / 2 + (R() - 0.5) * 40, S); c.lineTo(x, S * 0.3 + R() * 90); c.stroke(); }
      for (let i = 0; i < 520; i++) {
        const x = 18 + R() * (S - 36), y = S * 0.2 + R() * S * 0.78, g = 90 + R() * 60;
        // dome-shaped clump: lower towards the sides, ragged top
        const dx = (x - S / 2) / (S / 2), top = S * (0.22 + 0.55 * dx * dx) + (R() - 0.5) * 30;
        if (y < top) continue;
        leaf(x, y, 6 + R() * 4, 3.5 + R() * 2, R() * 6.28, rgb(50 + R() * 35, g, 32 + R() * 18));
      }
      for (let i = 0; i < 14; i++) leaf(20 + R() * (S - 40), S * 0.45 + R() * S * 0.45, 4, 4, 0, '#2b3566');
    } else if (kind === 'heather') {
      for (let i = 0; i < 150; i++) {
        const x0 = S / 2 + (R() - 0.5) * 170, x1 = x0 + (R() - 0.5) * 60;
        const dx = (x0 - S / 2) / (S / 2), y1 = S * (0.3 + 0.45 * dx * dx) + R() * 70;
        c.strokeStyle = rgb(95 + R() * 30, 75 + R() * 30, 55 + R() * 20); c.lineWidth = 2;
        c.beginPath(); c.moveTo(x0, S); c.lineTo(x1, y1); c.stroke();
        for (let k = 0; k < 6; k++) {
          const t = k / 6, x = x0 + (x1 - x0) * t, y = S + (y1 - S) * t;
          leaf(x + (R() - 0.5) * 6, y, 2.8, 2.8, 0, R() < 0.45 ? rgb(150 + R() * 40, 85 + R() * 30, 140 + R() * 40) : rgb(75, 100 + R() * 30, 55));
        }
      }
    }
    return cv;
  }

  // ------------------------------------------------------------------ ground (tileable 512)
  function groundTex(kind) {
    const S = 512, cv = canvas(S, S), c = cv.getContext('2d');
    const seed = { forest: 41, grass: 42, soil: 43, gravel: 44, rock: 45, marsh: 46, field: 47, asphalt: 48 }[kind];
    const R = rng(seed), n = makeNoise(seed, 16), n2 = makeNoise(seed + 7, 64);
    const base = {
      forest: [78, 66, 44], grass: [92, 112, 52], soil: [104, 80, 56], gravel: [126, 118, 104],
      rock: [118, 116, 110], marsh: [72, 80, 48], field: [140, 128, 80], asphalt: [70, 70, 72],
    }[kind];
    pixelFill(cv, (i, j) => {
      const v = fbm(n, i / 32, j / 32, 4), w = fbm(n2, i / 8, j / 8, 3);
      const k = 0.7 + v * 0.45 + (w - 0.5) * 0.25;
      return [base[0] * k, base[1] * k, base[2] * k];
    });
    const D = (fn) => wrapDraw(c, S, fn);
    if (kind === 'forest') {
      for (let i = 0; i < 70; i++) { // moss cushions
        const x = R() * S, y = R() * S, r = 12 + R() * 40, g = 95 + R() * 40;
        D(() => { const gr = c.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, rgb(60, g, 35, 0.75)); gr.addColorStop(1, rgb(60, g, 35, 0)); c.fillStyle = gr; c.fillRect(x - r, y - r, 2 * r, 2 * r); });
      }
      for (let i = 0; i < 5500; i++) { // needles
        const x = R() * S, y = R() * S, a = R() * 6.28, l = 4 + R() * 7, t = R();
        const col = t < 0.5 ? rgb(130 + R() * 40, 90 + R() * 30, 50 + R() * 20) : rgb(85 + R() * 30, 62 + R() * 20, 40);
        D(() => { c.strokeStyle = col; c.lineWidth = 1.1; c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke(); });
      }
      for (let i = 0; i < 45; i++) { // twigs
        const x = R() * S, y = R() * S, a = R() * 6.28, l = 15 + R() * 40;
        D(() => { c.strokeStyle = rgb(60, 45, 32); c.lineWidth = 1.5 + R() * 1.5; c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke(); });
      }
      for (let i = 0; i < 18; i++) { // cones
        const x = R() * S, y = R() * S, a = R() * 6.28;
        D(() => { c.save(); c.translate(x, y); c.rotate(a); c.fillStyle = rgb(95, 62, 38); c.beginPath(); c.ellipse(0, 0, 9, 4, 0, 0, 6.28); c.fill(); c.restore(); });
      }
    } else if (kind === 'grass' || kind === 'field') {
      for (let i = 0; i < 9000; i++) {
        const x = R() * S, y = R() * S, a = -Math.PI / 2 + (R() - 0.5) * 1.2, l = 5 + R() * 10;
        const col = kind === 'grass' ? rgb(70 + R() * 70, 100 + R() * 60, 35 + R() * 30) : rgb(150 + R() * 50, 130 + R() * 40, 70 + R() * 30);
        D(() => { c.strokeStyle = col; c.lineWidth = 1.2; c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke(); });
      }
    } else if (kind === 'soil') {
      for (let i = 0; i < 700; i++) {
        const x = R() * S, y = R() * S, r = 1 + R() * 3, t = 80 + R() * 45;
        D(() => { c.fillStyle = rgb(t, t * 0.9, t * 0.78); c.beginPath(); c.ellipse(x, y, r, r * 0.8, R(), 0, 6.28); c.fill(); });
      }
      for (let i = 0; i < 14; i++) { // roots
        const x = R() * S, y = R() * S, a = R() * 6.28, l = 40 + R() * 80;
        D(() => { c.strokeStyle = rgb(80, 58, 40, 0.8); c.lineWidth = 3 + R() * 3; c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + Math.cos(a + 0.4) * l / 2, y + Math.sin(a + 0.4) * l / 2, x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke(); });
      }
    } else if (kind === 'gravel' || kind === 'asphalt') {
      const nStones = kind === 'gravel' ? 6000 : 2500;
      for (let i = 0; i < nStones; i++) {
        const x = R() * S, y = R() * S, r = kind === 'gravel' ? 1.5 + R() * 4 : 0.8 + R() * 1.6, t = (kind === 'gravel' ? 100 : 60) + R() * 70;
        D(() => { c.fillStyle = rgb(t, t * 0.97, t * 0.92); c.beginPath(); c.ellipse(x, y, r, r * 0.8, R(), 0, 6.28); c.fill(); });
      }
    } else if (kind === 'rock') {
      for (let i = 0; i < 9000; i++) { // granite speckle
        const x = R() * S, y = R() * S, t = R();
        const col = t < 0.3 ? rgb(40, 40, 42) : t < 0.6 ? rgb(190, 185, 178) : rgb(150, 120, 110);
        D(() => { c.fillStyle = col; c.fillRect(x, y, 1.5, 1.5); });
      }
      for (let i = 0; i < 40; i++) { // lichen
        const x = R() * S, y = R() * S, r = 6 + R() * 22;
        const col = R() < 0.5 ? rgb(170, 175, 140, 0.55) : rgb(110, 125, 80, 0.5);
        D(() => { c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, 6.28); c.fill(); });
      }
      for (let i = 0; i < 25; i++) { // cracks
        const x = R() * S, y = R() * S, a = R() * 6.28, l = 30 + R() * 90;
        D(() => { c.strokeStyle = rgb(45, 42, 40, 0.7); c.lineWidth = 1.2; c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke(); });
      }
    } else if (kind === 'marsh') {
      for (let i = 0; i < 160; i++) {
        const x = R() * S, y = R() * S, r = 10 + R() * 30, wet = R() < 0.25;
        const col = wet ? rgb(40, 50, 45, 0.7) : rgb(90 + R() * 30, 105 + R() * 25, 50, 0.5);
        D(() => { c.fillStyle = col; c.beginPath(); c.ellipse(x, y, r, r * 0.7, R(), 0, 6.28); c.fill(); });
      }
      for (let i = 0; i < 5000; i++) {
        const x = R() * S, y = R() * S, a = -Math.PI / 2 + (R() - 0.5) * 1.4, l = 4 + R() * 8;
        D(() => { c.strokeStyle = rgb(130 + R() * 40, 125 + R() * 30, 60); c.lineWidth = 1; c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke(); });
      }
    }
    return cv;
  }

  // ------------------------------------------------------------------ buildings
  function wallTex() {
    // white-ish vertical cladding with one window per 3 m module (the house colour is applied per vertex)
    const W = 256, H = 256, cv = canvas(W, H), c = cv.getContext('2d'), R = rng(51);
    c.fillStyle = '#f2f0ea'; c.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x += 12) {
      c.fillStyle = 'rgba(0,0,0,0.13)'; c.fillRect(x, 0, 2, H);
      c.fillStyle = `rgba(0,0,0,${0.02 + R() * 0.05})`; c.fillRect(x + 2, 0, 10, H);
    }
    // window
    const wx = 88, wy = 70, ww = 80, wh = 96;
    c.fillStyle = '#fbfbf8'; c.fillRect(wx - 8, wy - 8, ww + 16, wh + 16);
    const g = c.createLinearGradient(wx, wy, wx + ww, wy + wh);
    g.addColorStop(0, '#2e3c48'); g.addColorStop(0.5, '#5d7486'); g.addColorStop(1, '#22303a');
    c.fillStyle = g; c.fillRect(wx, wy, ww, wh);
    c.fillStyle = '#fbfbf8'; c.fillRect(wx + ww / 2 - 3, wy, 6, wh); c.fillRect(wx, wy + wh * 0.38, ww, 6);
    // sill shadow + foundation strip
    c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(wx - 8, wy + wh + 8, ww + 16, 4);
    return cv;
  }
  function roofTex() {
    const W = 256, H = 256, cv = canvas(W, H), c = cv.getContext('2d'), R = rng(52);
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, W, H);
    for (let y = 0; y < H; y += 16) {
      const off = (y / 16) % 2 ? 0 : 16;
      for (let x = -32; x < W; x += 32) {
        const t = 190 + R() * 50;
        c.fillStyle = rgb(t, t, t); c.fillRect(x + off, y, 30, 14);
        c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(x + off, y + 13, 30, 3);
      }
    }
    return cv;
  }
  function boardsTex() {
    // vertical boards with battens (barns, stabbur, outhouses); colour is applied per vertex
    const W = 256, H = 256, cv = canvas(W, H), c = cv.getContext('2d'), R = rng(53);
    c.fillStyle = '#f0ece6'; c.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x += 16) {
      c.fillStyle = `rgba(0,0,0,${0.03 + R() * 0.07})`; c.fillRect(x, 0, 16, H);
      c.fillStyle = 'rgba(0,0,0,0.22)'; c.fillRect(x, 0, 2, H);
      c.fillStyle = 'rgba(255,255,255,0.18)'; c.fillRect(x + 12, 0, 3, H);
    }
    for (let i = 0; i < 260; i++) { c.fillStyle = `rgba(0,0,0,${R() * 0.06})`; c.fillRect(R() * W, R() * H, 1 + R() * 2, 6 + R() * 30); }
    // white trim at the corners
    c.fillStyle = '#f7f5f0'; c.fillRect(0, 0, 6, H); c.fillRect(W - 6, 0, 6, H);
    return cv;
  }
  function logsTex() {
    // laft: horizontal round logs, a small white-framed window per module
    const W = 256, H = 256, cv = canvas(W, H), c = cv.getContext('2d'), R = rng(54);
    for (let y = 0; y < H; y += 21) {
      const g = c.createLinearGradient(0, y, 0, y + 21);
      g.addColorStop(0, '#9a9a9a'); g.addColorStop(0.35, '#f2f2f2'); g.addColorStop(0.8, '#bdbdbd'); g.addColorStop(1, '#5a5a5a');
      c.fillStyle = g; c.fillRect(0, y, W, 21);
      for (let i = 0; i < 18; i++) { c.fillStyle = `rgba(0,0,0,${R() * 0.08})`; c.fillRect(R() * W, y + 4 + R() * 12, 20 + R() * 60, 1); }
    }
    const wx = 92, wy = 78, ww = 72, wh = 84;
    c.fillStyle = '#f4f2ec'; c.fillRect(wx - 8, wy - 8, ww + 16, wh + 16);
    const g = c.createLinearGradient(wx, wy, wx + ww, wy + wh);
    g.addColorStop(0, '#26323b'); g.addColorStop(0.5, '#51677a'); g.addColorStop(1, '#1d2830');
    c.fillStyle = g; c.fillRect(wx, wy, ww, wh);
    c.fillStyle = '#f4f2ec'; c.fillRect(wx + ww / 2 - 3, wy, 6, wh); c.fillRect(wx, wy + wh * 0.45, ww, 5);
    return cv;
  }
  function claddingTex() {
    const W = 256, H = 256, cv = canvas(W, H), c = cv.getContext('2d');
    c.fillStyle = '#e8e8e6'; c.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x += 16) { c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(x, 0, 3, H); c.fillStyle = 'rgba(255,255,255,0.3)'; c.fillRect(x + 3, 0, 2, H); }
    // ribbon windows
    c.fillStyle = '#3a4752'; c.fillRect(0, 96, W, 40);
    c.fillStyle = '#e8e8e6'; for (let x = 0; x < W; x += 64) c.fillRect(x, 96, 4, 40);
    return cv;
  }

  // ------------------------------------------------------------------ build THREE textures
  export const OTex = {
    build(THREE, renderer) {
      const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      const tex = (cv, opt) => {
        const t = new THREE.CanvasTexture(cv);
        t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso;
        if (opt && opt.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
        if (opt && opt.clampS) { t.wrapS = THREE.ClampToEdgeWrapping; }
        return t;
      };
      const out = {
        bark: { spruce: tex(barkSpruce(), { repeat: 1 }), pine: tex(barkPine(), { repeat: 1 }), birch: tex(barkBirch(), { repeat: 1 }) },
        foliage: { spruce: tex(spruceBranch()), pine: tex(pineTuft()), birch: tex(birchLeaves()), bush: tex(bushLeaves()) },
        cover: {},
        ground: {},
        wall: tex(wallTex(), { repeat: 1 }), roof: tex(roofTex(), { repeat: 1 }), cladding: tex(claddingTex(), { repeat: 1 }),
        boards: tex(boardsTex(), { repeat: 1 }), logs: tex(logsTex(), { repeat: 1 }),
        canvases: {},
      };
      ['blueberry', 'fern', 'grass', 'heather', 'sedge', 'dry'].forEach((k) => { out.cover[k] = tex(coverCard(k)); });
      ['forest', 'grass', 'soil', 'gravel', 'rock', 'marsh', 'field', 'asphalt'].forEach((k) => {
        const cv = groundTex(k); out.canvases[k] = cv; out.ground[k] = tex(cv, { repeat: 1 });
      });
      return out;
    },
    // exposed for debugging / previews
    _painters: { barkSpruce, barkPine, barkBirch, spruceBranch, pineTuft, birchLeaves, bushLeaves, coverCard, groundTex, wallTex, roofTex },
  };
