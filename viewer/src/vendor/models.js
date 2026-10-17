/*
 * Vendored from "Orienteering 3D" (https://claude.ai/artifact/A8dqe89rvxzyN29Az3W29D),
 * MIT licensed, see LICENSE in this folder. Changes for otest: an ES module instead of a
 * window global, and the colour space API of current three.js.
 */
/* Procedural tree, bush and rock geometry for the Steinshøgda world.
 * Trees are built at unit height (y 0..1) and scaled per instance.
 * Every geometry carries position, normal, uv and color (colour = baked ambient occlusion).
 * OModels.build(THREE) -> { spruce: {trunk, foliage}, pine: {...}, birch: {...}, bush: {foliage}, rocks: [...], card }
 */
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  export const OModels = {
    build(THREE) {
      // ---- tiny mesh builder
      function Builder() { this.p = []; this.n = []; this.uv = []; this.c = []; this.idx = []; }
      Builder.prototype.v = function (x, y, z, nx, ny, nz, u, v, ao) {
        this.p.push(x, y, z); this.n.push(nx, ny, nz); this.uv.push(u, v); this.c.push(ao, ao, ao);
        return this.p.length / 3 - 1;
      };
      Builder.prototype.tri = function (a, b, c) { this.idx.push(a, b, c); };
      Builder.prototype.geo = function () {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
        g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
        g.setIndex(this.idx);
        g.computeBoundingSphere();
        return g;
      };

      // tapered trunk (u wraps around, v along the height in "texture metres" for a 15 m tree)
      function trunk(b, r0, r1, h, seg, vRepeat, curve) {
        const rings = 8;
        for (let j = 0; j <= rings; j++) {
          const t = j / rings, y = t * h, r = r0 + (r1 - r0) * t;
          const bend = curve ? curve * t * t : 0;
          for (let i = 0; i <= seg; i++) {
            const a = (i / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
            b.v(ca * r + bend, y, sa * r, ca, 0.15, sa, i / seg * 2, t * vRepeat, 0.55 + 0.45 * Math.min(1, t * 4));
          }
        }
        const base = b.p.length / 3 - (rings + 1) * (seg + 1);
        for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
          const a = base + j * (seg + 1) + i, c = a + seg + 1;
          b.tri(a, c, a + 1); b.tri(a + 1, c, c + 1);
        }
      }
      // a foliage card: quad from p0 along axis `d` (length L) with side vector `s` (half width W)
      // bent downwards by `droop`; normals point away from the crown centre (soft, volumetric light)
      function card(b, p0, d, s, L, W, droop, crownC, ao0, ao1, flipU) {
        const segs = 2, base = b.p.length / 3;
        for (let k = 0; k <= segs; k++) {
          const t = k / segs;
          const px = p0[0] + d[0] * L * t, py = p0[1] + d[1] * L * t - droop * L * t * t, pz = p0[2] + d[2] * L * t;
          for (const side of [-1, 1]) {
            const x = px + s[0] * W * side, y = py + s[1] * W * side, z = pz + s[2] * W * side;
            let nx = x - crownC[0], ny = (y - crownC[1]) * 0.6 + 0.35, nz = z - crownC[2];
            const nl = Math.hypot(nx, ny, nz) || 1;
            b.v(x, y, z, nx / nl, ny / nl, nz / nl, flipU ? 1 - t : t, side < 0 ? 0 : 1, ao0 + (ao1 - ao0) * t);
          }
        }
        for (let k = 0; k < segs; k++) {
          const a = base + k * 2;
          b.tri(a, a + 1, a + 2); b.tri(a + 1, a + 3, a + 2);
        }
      }
      // crossed vertical cards (for crown clumps)
      function clump(b, cx, cy, cz, size, R, crownC, ao) {
        const rot = R() * Math.PI;
        for (let k = 0; k < 3; k++) {
          const a = rot + k * Math.PI / 3, tilt = (R() - 0.5) * 0.9;
          const dx = Math.cos(a), dz = Math.sin(a);
          const up = [-dx * Math.sin(tilt), Math.cos(tilt), -dz * Math.sin(tilt)];
          const base = b.p.length / 3;
          const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
          corners.forEach(([u, v]) => {
            const x = cx + dx * u * size + up[0] * v * size, y = cy + up[1] * v * size, z = cz + dz * u * size + up[2] * v * size;
            let nx = x - crownC[0], ny = (y - crownC[1]) * 0.7 + 0.3, nz = z - crownC[2];
            const nl = Math.hypot(nx, ny, nz) || 1;
            b.v(x, y, z, nx / nl, ny / nl, nz / nl, (u + 1) / 2, (v + 1) / 2, ao * (0.8 + 0.2 * (v + 1) / 2));
          });
          b.tri(base, base + 1, base + 2); b.tri(base, base + 2, base + 3);
        }
      }

      // short roots spreading from the foot of the trunk into the ground
      function flare(b, R, r0, n) {
        const rot = R() * 6.283;
        for (let i = 0; i < n; i++) {
          const a = rot + i / n * 6.283 + (R() - 0.5) * 0.5, dx = Math.cos(a), dz = Math.sin(a);
          const L = r0 * (1.6 + R() * 1.4);
          tube(b, [dx * r0 * 0.4, r0 * 0.9, dz * r0 * 0.4], [dx * (r0 + L * 0.5), r0 * 0.15, dz * (r0 + L * 0.5)], r0 * 0.42, r0 * 0.28, 0.6);
          tube(b, [dx * (r0 + L * 0.5), r0 * 0.15, dz * (r0 + L * 0.5)], [dx * (r0 + L), -r0 * 0.5, dz * (r0 + L)], r0 * 0.28, r0 * 0.1, 0.55);
        }
      }
      // ------------------------------------------------------------- spruce
      // crownBase: share of the height without live branches. Spruce grown in the open keeps
      // branches to the ground; in a stand the lower branches die and only dry twigs remain.
      function spruce(seed, crownBase) {
        const R = rng(seed), bt = new Builder(), bf = new Builder();
        trunk(bt, 0.016, 0.002, 1.0, 7, 6, 0);
        flare(bt, R, 0.016, 5);
        const cb = crownBase || 0.06;
        const N = Math.round(20 * (1 - cb * 0.55)), crownC = [0, cb + (1 - cb) * 0.36, 0];
        for (let k = 0; k < N; k++) {
          const t = k / (N - 1), y = cb + (0.92 - cb) * t;
          const tt = Math.min(1, Math.max(0, (y - 0.06) / 0.86));    // position on a full-length crown
          const L = (0.205 * Math.pow(1 - tt, 0.85) + 0.022) * (cb > 0.1 ? 0.82 : 1);
          const nb = tt > 0.85 ? 4 : 7, rot = R() * 6.283;
          for (let i = 0; i < nb; i++) {
            const a = rot + (i / nb) * 6.283 + (R() - 0.5) * 0.4;
            const dx = Math.cos(a), dz = Math.sin(a);
            const rise = 0.12 - tt * 0.25 + (R() - 0.5) * 0.1;
            const dl = Math.hypot(1, rise);
            const d = [dx / dl, rise / dl, dz / dl];
            const roll = 0.75;
            for (const sg of [-1, 1]) {
              const s = [-dz * Math.cos(roll), sg * Math.sin(roll), dx * Math.cos(roll)];
              const ao0 = 0.35 + 0.35 * tt, ao1 = 0.8 + 0.2 * tt;
              card(bf, [dx * 0.01, y, dz * 0.01], d, s, L * (0.85 + R() * 0.3), L * 0.3, 0.3 + 0.2 * (1 - tt), crownC, ao0, ao1, sg > 0);
            }
          }
        }
        clump(bf, 0, 0.965, 0, 0.045, R, crownC, 1.0);
        // dry twigs on the bare lower trunk (thin, short, drooping; on the bark material)
        if (cb > 0.1) {
          const n = Math.round(cb * 110);
          for (let i = 0; i < n; i++) {
            const y = 0.12 + (cb - 0.12) * R(), a = R() * 6.283, L = 0.025 + 0.05 * R() * (0.4 + y / cb);
            const dx = Math.cos(a), dz = Math.sin(a), r = 0.0022, base = bt.p.length / 3;
            const tip = [dx * (0.012 + L), y - L * (0.15 + 0.25 * R()), dz * (0.012 + L)];
            for (let k = 0; k < 3; k++) {
              const b = k / 3 * 6.283, ox = -dz * Math.cos(b) * r, oz = dx * Math.cos(b) * r, oy = Math.sin(b) * r;
              bt.v(dx * 0.012 + ox, y + oy, dz * 0.012 + oz, -dz * Math.cos(b), Math.sin(b), dx * Math.cos(b), k / 3, 0, 0.45);
            }
            bt.v(tip[0], tip[1], tip[2], dx, 0, dz, 0.5, 0.3, 0.5);
            for (let k = 0; k < 3; k++) bt.tri(base + k, base + (k + 1) % 3, base + 3);
          }
        }
        return { trunk: bt.geo(), foliage: bf.geo() };
      }
      // ------------------------------------------------------------- pine
      // Scots pine: long clean trunk, grey and plated low down, thin orange bark higher up;
      // a high, flattish crown of branches that end in pads of needle tufts.
      function pad(b, cx, cy, cz, size, R, crownC, ao) {
        const rot = R() * Math.PI * 2;
        const quad = (pts, uvs) => {
          const base = b.p.length / 3;
          pts.forEach(([x, y, z], i) => {
            let nx = x - crownC[0], ny = (y - crownC[1]) * 0.8 + 0.45, nz = z - crownC[2];
            const nl = Math.hypot(nx, ny, nz) || 1;
            b.v(x, y, z, nx / nl, ny / nl, nz / nl, uvs[i][0], uvs[i][1], ao * (0.78 + 0.22 * uvs[i][1]));
          });
          b.tri(base, base + 1, base + 2); b.tri(base, base + 2, base + 3);
        };
        // a gently tilted horizontal spray, seen from below as tufts against the sky
        const tilt = (R() - 0.5) * 0.5, c = Math.cos(rot), s = Math.sin(rot), w = size * 1.15;
        const hp = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
          const lx = u * w, lz = v * w;
          return [cx + lx * c - lz * s, cy + lz * tilt + u * w * 0.12, cz + lx * s + lz * c];
        });
        quad(hp, [[0, 0], [1, 0], [1, 1], [0, 1]]);
        // two upright sprays crossing it, giving the pad some thickness from the side
        for (let k = 0; k < 2; k++) {
          const a = rot + k * Math.PI / 2 + (R() - 0.5) * 0.4, dx = Math.cos(a), dz = Math.sin(a), h = size * 0.7;
          quad([[cx - dx * w, cy - h * 0.35, cz - dz * w], [cx + dx * w, cy - h * 0.35, cz + dz * w],
                [cx + dx * w, cy + h, cz + dz * w], [cx - dx * w, cy + h, cz - dz * w]], [[0, 0], [1, 0], [1, 1], [0, 1]]);
        }
      }
      function tube(b, a, c, r0, r1, ao) {
        const seg = 4, base = b.p.length / 3;
        const dx = c[0] - a[0], dy = c[1] - a[1], dz = c[2] - a[2], L = Math.hypot(dx, dy, dz) || 1;
        // any vector not parallel to the axis
        let ux = -dz, uy = 0, uz = dx; let ul = Math.hypot(ux, uy, uz);
        if (ul < 1e-6) { ux = 1; uy = 0; uz = 0; ul = 1; }
        ux /= ul; uz /= ul;
        const vx = (dy * uz - dz * uy) / L, vy = (dz * ux - dx * uz) / L, vz = (dx * uy - dy * ux) / L;
        for (let j = 0; j <= 1; j++) for (let i = 0; i <= seg; i++) {
          const t = i / seg * 6.283, r = j ? r1 : r0, P = j ? c : a;
          const nx = Math.cos(t) * ux + Math.sin(t) * vx, ny = Math.cos(t) * uy + Math.sin(t) * vy, nz = Math.cos(t) * uz + Math.sin(t) * vz;
          b.v(P[0] + nx * r, P[1] + ny * r, P[2] + nz * r, nx, ny, nz, i / seg, j * L * 6, ao);
        }
        for (let i = 0; i < seg; i++) { const p0 = base + i, p1 = base + seg + 1 + i; b.tri(p0, p0 + 1, p1); b.tri(p0 + 1, p1 + 1, p1); }
      }
      function pine(seed) {
        const R = rng(seed), bt = new Builder(), bf = new Builder();
        const lean = (R() - 0.5) * 0.03;
        trunk(bt, 0.014, 0.0035, 0.93, 8, 6, lean);
        flare(bt, R, 0.014, 4);
        const cb = 0.55 + R() * 0.08, top = 0.97;
        const crownC = [lean * 0.7, cb + (top - cb) * 0.55, 0];
        const nB = 10 + Math.floor(R() * 4);
        for (let i = 0; i < nB; i++) {
          const f = i / (nB - 1), y = cb + (top - 0.04 - cb) * Math.pow(f, 0.85);
          const a = i * 2.39996 + (R() - 0.5) * 0.6, dx = Math.cos(a), dz = Math.sin(a);
          const L = (0.06 + 0.12 * Math.pow(1 - f, 0.7)) * (0.75 + 0.5 * R());
          const bx = lean * y * y;
          const mid = [bx + dx * L * 0.5, y + L * (0.12 + 0.2 * R()), dz * L * 0.5];
          const tip = [bx + dx * L, y + L * (0.3 + 0.35 * R()), dz * L];
          tube(bt, [bx, y, 0], mid, 0.0042 * (1 - f * 0.5), 0.0028, 0.85);
          tube(bt, mid, tip, 0.0028, 0.0014, 0.9);
          const ao = 0.62 + 0.38 * f;
          pad(bf, tip[0], tip[1] + 0.006, tip[2], 0.045 + 0.03 * R() + L * 0.2, R, crownC, ao);
          if (L > 0.1) pad(bf, mid[0] + dz * 0.02, mid[1] + 0.012, mid[2] - dx * 0.02, 0.035 + 0.02 * R(), R, crownC, ao * 0.85);
          if (R() < 0.5) pad(bf, (mid[0] + tip[0]) / 2 - dz * 0.03, (mid[1] + tip[1]) / 2 + 0.02, (mid[2] + tip[2]) / 2 + dx * 0.03, 0.03 + 0.02 * R(), R, crownC, ao * 0.92);
        }
        pad(bf, lean * 0.9, top, 0, 0.05, R, crownC, 1.0);
        pad(bf, lean * 0.9 + 0.02, top - 0.04, 0.015, 0.045, R, crownC, 0.95);
        // bark colour: grey, coarse plates low down, thin and orange in the crown
        const P = bt.p, C = bt.c;
        for (let i = 0; i < P.length / 3; i++) {
          const y = P[i * 3 + 1], f = Math.min(1, Math.max(0, (y - 0.3) / 0.35)), sm = f * f * (3 - 2 * f), ao = C[i * 3];
          C[i * 3] = ao * (0.5 + (1.32 - 0.5) * sm); C[i * 3 + 1] = ao * (0.5 + (0.88 - 0.5) * sm); C[i * 3 + 2] = ao * (0.52 + (0.62 - 0.52) * sm);
        }
        return { trunk: bt.geo(), foliage: bf.geo() };
      }
      // ------------------------------------------------------------- birch
      function birch(seed) {
        const R = rng(seed), bt = new Builder(), bf = new Builder();
        const lean = (R() - 0.5) * 0.05;
        trunk(bt, 0.011, 0.003, 0.95, 7, 5, lean);
        flare(bt, R, 0.011, 4);
        const crownC = [lean * 0.5, 0.66, 0];
        const n = 30;
        for (let i = 0; i < n; i++) {
          // points spread over an ellipsoid shell (denser outside)
          const u = R() * 2 - 1, a = R() * 6.283, sh = 0.55 + 0.45 * Math.sqrt(R());
          const rr = Math.sqrt(1 - u * u);
          const x = crownC[0] + Math.cos(a) * rr * 0.17 * sh, y = crownC[1] + u * 0.27 * sh, z = Math.sin(a) * rr * 0.17 * sh;
          if (y < 0.36) continue;
          clump(bf, x, y, z, 0.06 + R() * 0.035, R, crownC, 0.6 + 0.4 * (sh * (u * 0.5 + 0.5)));
        }
        return { trunk: bt.geo(), foliage: bf.geo() };
      }
      // ------------------------------------------------------------- bush (unit size ~1 m)
      function bush(seed) {
        const R = rng(seed), bf = new Builder(), crownC = [0, 0.35, 0];
        for (let i = 0; i < 11; i++) {
          const a = R() * 6.283, r = Math.sqrt(R()) * 0.35, y = 0.25 + R() * 0.4;
          clump(bf, Math.cos(a) * r, y, Math.sin(a) * r, 0.25 + R() * 0.12, R, crownC, 0.55 + 0.45 * (y / 0.65));
        }
        return { foliage: bf.geo() };
      }
      // ------------------------------------------------------------- rocks
      function rock(seed) {
        const R = rng(seed);
        let g = new THREE.IcosahedronGeometry(1, 3);
        const p = g.attributes.position;
        const ph = [R() * 10, R() * 10, R() * 10], sq = [0.8 + R() * 0.5, 0.55 + R() * 0.3, 0.8 + R() * 0.5];
        const f = (x, y, z) => {
          let s = 0, a = 1, fr = 1.3;
          for (let o = 0; o < 4; o++) {
            s += a * Math.sin(x * fr + ph[0] + o) * Math.sin(y * fr * 1.3 + ph[1]) * Math.sin(z * fr * 0.9 + ph[2] + o * 2);
            a *= 0.5; fr *= 2.1;
          }
          return s;
        };
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
          let k = 1 + 0.28 * f(x, y, z);
          // flatter facets: quantise a little
          k = Math.round(k * 7) / 7 * 0.35 + k * 0.65;
          let ny = y * sq[1] * k;
          if (ny < -0.25) ny = -0.25 + (ny + 0.25) * 0.3; // flat-ish bottom
          p.setXYZ(i, x * sq[0] * k, ny, z * sq[2] * k);
        }
        g.computeVertexNormals();
        const n = p.count, col = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { const ao = 0.6 + 0.4 * Math.min(1, (p.getY(i) + 0.3) / 0.6); col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = ao; }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        return g;
      }
      // ------------------------------------------------------------- ground cover card (3 crossed quads, ground at y=0)
      function coverCard() {
        const b = new Builder();
        for (let k = 0; k < 3; k++) {
          const a = k * Math.PI / 3, cx = Math.cos(a) * 0.5, cz = Math.sin(a) * 0.5;
          const base = b.p.length / 3;
          b.v(-cx, 0, -cz, 0, 1, 0, 0, 0, 0.55); b.v(cx, 0, cz, 0, 1, 0, 1, 0, 0.55);
          b.v(cx, 1, cz, 0, 1, 0, 1, 1, 1); b.v(-cx, 1, -cz, 0, 1, 0, 0, 1, 1);
          b.tri(base, base + 1, base + 2); b.tri(base, base + 2, base + 3);
        }
        return b.geo();
      }
      // fallen log (unit length along x, radius 1)
      function log() {
        const b = new Builder();
        const seg = 7;
        for (let j = 0; j <= 1; j++) for (let i = 0; i <= seg; i++) {
          const a = i / seg * 6.283;
          b.v(j - 0.5, Math.sin(a), Math.cos(a), 0, Math.sin(a), Math.cos(a), i / seg, j * 3, 0.75 + 0.25 * Math.max(0, Math.sin(a)));
        }
        for (let i = 0; i < seg; i++) { const a = i, c = seg + 1 + i; b.tri(a, c, a + 1); b.tri(a + 1, c, c + 1); }
        return b.geo();
      }
      // ------------------------------------------------------------- roots across a path (metres, half buried)
      function root(seed) {
        const R = rng(seed), b = new Builder();
        const L = 1.5 + R() * 1.1, r0 = 0.065 + R() * 0.035, n = 9;
        const pts = [];
        for (let i = 0; i <= n; i++) {
          const t = i / n, x = (t - 0.5) * L;
          const arch = (0.55 - 1.3 * Math.pow(2 * t - 1, 2)) * r0 * 1.5;      // rises out of the ground in the middle
          pts.push([x, arch, Math.sin(t * 3.1 + R() * 0.3) * 0.12 * L * (R() - 0.3)]);
        }
        for (let i = 0; i < n; i++) {
          const t = i / n, r = r0 * (0.55 + 0.45 * Math.sin(Math.PI * (t * 0.8 + 0.1)));
          tube(b, pts[i], pts[i + 1], r, r0 * (0.55 + 0.45 * Math.sin(Math.PI * ((i + 1) / n * 0.8 + 0.1))), 1.0);
        }
        // a thinner side root
        const k = 3 + Math.floor(R() * 3), a = pts[k], dirZ = R() < 0.5 ? -1 : 1;
        const c = [a[0] + 0.2 + R() * 0.3, a[1] - 0.02, a[2] + dirZ * (0.25 + R() * 0.3)];
        tube(b, a, c, r0 * 0.45, r0 * 0.15, 0.9);
        return b.geo();
      }
      // a dry fallen branch with a couple of side twigs (metres)
      function twig(seed) {
        const R = rng(seed), b = new Builder();
        const L = 0.6 + R() * 0.7, r = 0.012 + R() * 0.01;
        const a = [-L / 2, r, 0], m = [0, r * 1.2, (R() - 0.5) * 0.08], c = [L / 2, r * 0.6, (R() - 0.5) * 0.1];
        tube(b, a, m, r, r * 0.8, 0.9); tube(b, m, c, r * 0.8, r * 0.35, 0.95);
        for (let i = 0; i < 3; i++) {
          const t = 0.2 + R() * 0.6, p = [-L / 2 + L * t, r, (R() - 0.5) * 0.04], s = R() < 0.5 ? -1 : 1;
          tube(b, p, [p[0] + 0.08 + R() * 0.12, r * 0.5 + R() * 0.05, p[2] + s * (0.1 + R() * 0.15)], r * 0.45, r * 0.15, 0.95);
        }
        return b.geo();
      }
      return {
        root: [root(601), root(602), root(603)], twig: [twig(701), twig(702)], tube,
        // spruce: open-grown, stand, dense mature stand
        spruce: [spruce(101, 0.06), spruce(102, 0.32), spruce(103, 0.5)], pine: [pine(201), pine(202)], birch: [birch(301), birch(302)],
        bush: [bush(401)], rocks: [rock(501), rock(502), rock(503), rock(504)], card: coverCard(), log: log(),
      };
    },
  };
