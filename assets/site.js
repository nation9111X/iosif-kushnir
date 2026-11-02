/* Сайт-резюме: живая сцена на WebGL, талисман на CSS 3D, интерактивные демо.
   Без библиотек: сайт должен быстро открываться на слабом телефоне. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = document.documentElement;
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  // Тяжёлая работа идёт после первой отрисовки: сначала человек видит текст и снимок
  const afterPaint = (fn) => requestAnimationFrame(() => setTimeout(fn, 0));
  const rng = (seed) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /* ---------- Тема ---------- */
  const themeListeners = [];
  const applyTheme = (t) => {
    root.dataset.theme = t;
    $('meta[name="theme-color"]').content = t === 'light' ? '#EEF2F7' : '#090D13';
    $('#themeBtn').setAttribute('aria-label', t === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему');
    themeListeners.forEach((f) => f(t));
  };
  $('#themeBtn').addEventListener('click', () => {
    const t = root.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('theme', t); } catch (e) { /* приватный режим */ }
    applyTheme(t);
  });

  /* ---------- Меню на телефоне ---------- */
  const menuBtn = $('#menuBtn');
  const sheet = $('#sheet');
  const toggleMenu = (open) => {
    sheet.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
    root.classList.toggle('menu-open', open);
  };
  menuBtn.addEventListener('click', () => toggleMenu(sheet.hidden));
  sheet.addEventListener('click', (e) => { if (e.target.closest('a')) toggleMenu(false); });

  /* ---------- Состояние указателя и прокрутки ---------- */
  const input = { x: 0, y: 0, sx: 0, sy: 0, active: 0, rip: { x: 0, y: 0, t: -9 } };
  addEventListener('pointermove', (e) => {
    input.x = (e.clientX / innerWidth) * 2 - 1;
    input.y = -((e.clientY / innerHeight) * 2 - 1);
    input.active = 1;
  }, { passive: true });
  addEventListener('pointerdown', (e) => {
    input.rip = { x: (e.clientX / innerWidth) * 2 - 1, y: -((e.clientY / innerHeight) * 2 - 1), t: performance.now() / 1000 };
  }, { passive: true });
  addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') input.active = 0; }, { passive: true });
  addEventListener('deviceorientation', (e) => {
    if (e.gamma == null) return;
    input.x = clamp(e.gamma / 35, -1, 1);
    input.y = clamp((e.beta - 45) / 35, -1, 1);
  }, { passive: true });

  /* ---------- Сцена: точки складываются в формы, каждая форма значит что-то настоящее ---------- */
  const Field = (() => {
    const canvas = $('#field');
    const gl = canvas.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: true, depth: false, stencil: false });
    if (!gl) { root.classList.add('no-gl'); return null; }

    const isPhone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
    const weak = (navigator.deviceMemory || 4) <= 2 || (navigator.hardwareConcurrency || 4) <= 4;
    const N = isPhone ? (weak ? 1400 : 2600) : 6000;
    // Only the final silhouette needs this density; other scenes keep their budget.
    const mascotN = Math.max(N, (isPhone || innerWidth < 600) ? 4800 : 16000);
    let drawN = N;
    let dpr = Math.min(devicePixelRatio || 1, isPhone ? 1.5 : 2);
    const STATES = 8;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const program = (vs, fs) => {
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      return p;
    };

    const warp = `
      vec4 warp(vec4 c) {
        vec2 ndc = c.xy / c.w;
        vec2 dd = (ndc - uPtr) * vec2(uAsp, 1.);
        float pd = length(dd);
        ndc += dd / (pd + .001) * exp(-pd * pd * 12.) * .05 * uPtrA;
        if (uRipA < 1.6) {
          vec2 rr = (ndc - uRip) * vec2(uAsp, 1.);
          float d = length(rr), f = d - uRipA * 1.5;
          ndc += rr / (d + .001) * sin(f * 16.) * exp(-abs(f) * 6.) * (1. - uRipA / 1.6) * .05;
        }
        c.xy = ndc * c.w;
        return c;
      }`;

    const pointsProg = program(`
      attribute vec4 aA, aB, aS;
      uniform mat4 uM;
      uniform float uT, uTime, uPx, uDim, uAsp, uPtrA, uRipA, uSz, uMascot, uGrain;
      uniform vec2 uPtr, uRip;
      uniform vec3 uCold, uWarm;
      varying vec3 vC; varying float vA;
      ${warp}
      void main() {
        float t = clamp(uT * 1.5 - aS.x * .5, 0., 1.);
        t = t * t * (3. - 2. * t);
        vec3 p = mix(aA.xyz, aB.xyz, t);
        p += (aS.xyz - .5) * sin(t * 3.14159) * .9;
        p += mix(.014, .0015, uMascot) * vec3(sin(uTime * (.5 + aS.y) + aS.z * 6.28), cos(uTime * (.4 + aS.z) + aS.x * 6.28), sin(uTime * (.3 + aS.x) + aS.y * 6.28));
        float hA = floor(aA.w), hB = floor(aB.w);
        float bA = fract(aA.w) / .99, bB = fract(aB.w) / .99;
        float h = mix(hA, hB, t) / 15., b = mix(bA, bB, t);
        vC = mix(uCold, uWarm, h);
        vA = mix(.1, 1., b) * uDim;
        vec4 c = warp(uM * vec4(p, 1.));
        gl_Position = c;
        gl_PointSize = (1.1 + b * b * 3.6 * uSz) * uPx * (5.4 / c.w) * (.75 + aS.w * .5);
        gl_PointSize = mix(gl_PointSize, uGrain * uPx * (.9 + aS.w * .2), uMascot);
      }`, `
      precision mediump float;
      varying vec3 vC; varying float vA;
      void main() {
        float d = length(gl_PointCoord - .5);
        float a = smoothstep(.5, .16, d) * vA;
        gl_FragColor = vec4(vC * a, a);
      }`);

    const linesProg = program(`
      attribute vec3 aP; attribute vec2 aU;
      uniform mat4 uM;
      uniform float uTime, uAsp, uPtrA, uRipA;
      uniform vec2 uPtr, uRip;
      varying float vP, vH;
      ${warp}
      void main() {
        vP = fract(aU.x - uTime * .32 + aU.y);
        vH = aU.x;
        gl_Position = warp(uM * vec4(aP, 1.));
      }`, `
      precision mediump float;
      uniform float uAlpha, uBase;
      uniform vec3 uCold, uWarm;
      varying float vP, vH;
      void main() {
        float pulse = smoothstep(.12, 0., abs(vP - .5));
        float a = (uBase + pulse * .8) * uAlpha;
        vec3 c = mix(uCold, uWarm, pulse);
        gl_FragColor = vec4(c * a, a);
      }`);

    const U = {};
    const uni = (p, names) => names.forEach((n) => { U[p === pointsProg ? 'p' + n : 'l' + n] = gl.getUniformLocation(p, n); });
    uni(pointsProg, ['uMascot', 'uGrain', 'uSz', 'uM', 'uT', 'uTime', 'uPx', 'uDim', 'uAsp', 'uPtrA', 'uRipA', 'uPtr', 'uRip', 'uCold', 'uWarm']);
    uni(linesProg, ['uM', 'uTime', 'uAsp', 'uPtrA', 'uRipA', 'uPtr', 'uRip', 'uCold', 'uWarm', 'uAlpha', 'uBase']);
    const aA = gl.getAttribLocation(pointsProg, 'aA');
    const aB = gl.getAttribLocation(pointsProg, 'aB');
    const aS = gl.getAttribLocation(pointsProg, 'aS');
    const aP = gl.getAttribLocation(linesProg, 'aP');
    const aU = gl.getAttribLocation(linesProg, 'aU');

    const posBuf = gl.createBuffer();
    const mascotBuf = gl.createBuffer();
    const seedBuf = gl.createBuffer();
    const netBuf = gl.createBuffer();
    const ringBuf = gl.createBuffer();
    let netCount = 0, ringCount = 0;

    // Постоянные случайные значения точки: разброс при перелёте и размер
    {
      const r = rng(7);
      const s = new Float32Array(Math.max(N, mascotN) * 4);
      for (let i = 0; i < s.length; i++) s[i] = r();
      gl.bindBuffer(gl.ARRAY_BUFFER, seedBuf);
      gl.bufferData(gl.ARRAY_BUFFER, s, gl.STATIC_DRAW);
    }

    const build = (aspect) => {
      const portrait = aspect < 1;
      const hh = 1.72;
      const hw = Math.min(hh * aspect, 2.9);
      const data = new Float32Array(N * 4 * STATES);
      const r = rng(19);
      const M = Math.floor(N * 0.74);
      const dust = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        dust[i * 3] = (r() * 2 - 1) * hw * 1.3;
        dust[i * 3 + 1] = (r() * 2 - 1) * hh * 1.3;
        dust[i * 3 + 2] = r() * 2.6 - 1.8;
      }
      const perm = Array.from({ length: N }, (_, i) => i);
      const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
      const enc = (b, h) => Math.round(h * 15) + clamp(b, 0, 1) * 0.99;

      // Записывает форму в буфер: сначала точные точки (люди), потом форма, остальное становится пылью
      const write = (state, shape, exact = []) => {
        const off = state * N * 4;
        const used = new Uint8Array(N);
        const put = (i, x, y, z, w) => {
          const o = off + i * 4;
          data[o] = x;
          data[o + 1] = y;
          data[o + 2] = z;
          data[o + 3] = w;
        };
        exact.forEach((p, i) => {
          put(i, p[0], p[1], p[2], enc(p[3], p[4]));
          used[i] = 1;
        });
        const free = shuffle(perm.slice(exact.length));
        const pts = shape.length > free.length ? shuffle(shape).slice(0, free.length) : shape;
        pts.forEach((p, k) => {
          const i = free[k];
          put(i, p[0], p[1], p[2], enc(p[3], p[4]));
          used[i] = 1;
        });
        for (let i = 0; i < N; i++) {
          if (used[i]) continue;
          put(i, dust[i * 3], dust[i * 3 + 1], dust[i * 3 + 2], enc(0.04 + (i % 7) * 0.016, 0));
        }
      };

      const gauss = () => (r() + r() + r() - 1.5) / 1.5;
      const rect = (pts, o, e1, e2, n, b, h, skip) => {
        const c = Math.max(2, Math.round(Math.sqrt(n)));
        for (let i = 0; i <= c; i++) for (let j = 0; j <= c; j++) {
          const u = i / c, v = j / c;
          if (skip && skip(u, v)) continue;
          pts.push([o[0] + e1[0] * u + e2[0] * v, o[1] + e1[1] * u + e2[1] * v, o[2] + e1[2] * u + e2[2] * v, b, h]);
        }
      };
      const line = (pts, a, b, n, br, h) => {
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          pts.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), br, h]);
        }
      };

      /* 0. Сырые выгрузки проходят через сеть и выходят упорядоченной таблицей */
      const net = () => {
        const pts = [];
        const flow = portrait ? hh * 0.98 : hw * 0.96;
        const perp = portrait ? hw * 0.92 : hh * 0.78;
        const at = (v, p, z) => (portrait ? [p, -v, z] : [v, p, z]);
        const counts = [5, 8, 10, 8, 4];
        const layers = counts.map((c, k) => {
          const v = lerp(-0.52, 0.52, k / (counts.length - 1)) * flow;
          return Array.from({ length: c }, (_, i) => {
            const a = (i / c) * Math.PI * 2 + k * 0.7;
            const rad = 0.55 + r() * 0.4;
            return at(v + gauss() * 0.04, Math.cos(a) * perp * rad, Math.sin(a) * 0.85 * rad);
          });
        });
        const edges = [];
        const halo = Math.max(2, Math.floor((M * 0.12) / 35));
        layers.forEach((l, k) => {
          const h = k / (layers.length - 1);
          l.forEach((p) => {
            pts.push([p[0], p[1], p[2], 1, h]);
            for (let i = 0; i < halo; i++) pts.push([p[0] + gauss() * 0.09, p[1] + gauss() * 0.09, p[2] + gauss() * 0.09, 0.3, h]);
            if (k < layers.length - 1) layers[k + 1].forEach((q) => { if (r() < 0.55) edges.push([p, q]); });
          });
        });
        // Хаос на входе
        const rawN = Math.floor(M * 0.38);
        for (let i = 0; i < rawN; i++) {
          const v = -(0.66 + r() * 0.36) * flow;
          const p = at(v, gauss() * perp * 1.25, gauss() * 1.3);
          pts.push([p[0], p[1], p[2], 0.2 + r() * 0.5, 0]);
        }
        // Порядок на выходе
        const gridN = Math.floor(M * 0.32);
        const side = Math.round(Math.sqrt(gridN / 3));
        for (let a = 0; a < 3; a++) for (let i = 0; i < side; i++) for (let j = 0; j < side; j++) {
          const v = (0.68 + a * 0.13) * flow;
          const p = at(v, ((i / (side - 1)) * 2 - 1) * perp * 0.82, ((j / (side - 1)) * 2 - 1) * 0.72);
          pts.push([p[0], p[1], p[2], 0.72, 1]);
        }
        // Связи между слоями для линий
        const lines = [];
        edges.forEach(([a, b]) => {
          const s = r();
          lines.push(a[0], a[1], a[2], 0, s, b[0], b[1], b[2], 0.45, s);
        });
        return { pts, lines };
      };

      /* 1. Три должности: три поднимающиеся площадки */
      const stairs = () => {
        const pts = [];
        const pw = portrait ? hw * 0.44 : Math.min(hw * 0.24, 0.62);
        const xs = portrait ? [-0.42, 0.02, 0.42] : [-1.1, 0, 1.1];
        const ys = portrait ? [-0.72, 0.02, 0.76] : [-0.86, -0.02, 0.86];
        const floor = portrait ? -1.16 : -1.42;
        xs.forEach((xk, k) => {
          const x = xk * (portrait ? hw : Math.min(hw * 0.62, 1.5) / 1.1);
          const y = ys[k];
          const h = k / 2;
          const n = M * (0.3 + k * 0.03);
          rect(pts, [x - pw, y, -pw], [pw * 2, 0, 0], [0, 0, pw * 2], n * 0.62, 0.55 + k * 0.2, h);
          const legs = [[-pw, pw], [pw, pw], [-pw, -pw], [pw, -pw]];
          legs.forEach(([a, c]) => line(pts, [x + a, y, c], [x + a, floor, c], Math.round((n * 0.09) | 0), 0.5, h));
        });
        return pts;
      };

      /* 2. Два потока данных сливаются в десять модулей отдела */
      const system = () => {
        const pts = [];
        const towers = [];
        const flowN = Math.floor(M * 0.42);
        const bez = (a, b, c, t) => [
          (1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * b[0] + t * t * c[0],
          (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * b[1] + t * t * c[1],
        ];
        let streams;
        if (portrait) {
          for (let i = 0; i < 10; i++) {
            const row = i < 5 ? 0 : 1;
            towers.push([((i % 5) / 4 - 0.5) * hw * 1.62, row ? -1.34 : -0.42, row ? 0.25 : -0.25]);
          }
          streams = [[[-hw * 1.2, 1.7], [-hw * 0.2, 1.3], [0, 0.42]], [[hw * 1.2, 1.7], [hw * 0.2, 1.3], [0, 0.42]]];
        } else {
          const span = Math.min(hw * 0.68, 1.75);
          for (let i = 0; i < 10; i++) towers.push([lerp(-0.1, span, i / 9), -1.05, 0]);
          streams = [[[-hw * 1.25, 1.3], [-hw * 0.55, 1.05], [-0.34, -0.1]], [[-hw * 1.25, -1.3], [-hw * 0.55, -1.05], [-0.34, -0.1]]];
        }
        for (let i = 0; i < flowN; i++) {
          const s = streams[i % 2];
          const t = Math.pow(r(), 0.8);
          const p = bez(s[0], s[1], s[2], t);
          const w = (1 - t) * 0.26 + 0.03;
          pts.push([p[0] + gauss() * w, p[1] + gauss() * w, gauss() * w * 1.4, 0.22 + t * 0.55, 0]);
        }
        const tw = portrait ? hw * 0.1 : Math.min(hw * 0.042, 0.075);
        const per = Math.floor((M * 0.58) / 10);
        towers.forEach((b, i) => {
          const H = (portrait ? 0.52 : 1.15) + Math.sin(i * 1.7 + 1) * (portrait ? 0.22 : 0.42);
          const each = per / 4;
          [[-tw, tw, tw, tw], [tw, tw, tw, -tw], [tw, -tw, -tw, -tw], [-tw, -tw, -tw, tw]].forEach(([x1, z1, x2, z2]) => {
            rect(pts, [b[0] + x1, b[1], b[2] + z1], [x2 - x1, 0, z2 - z1], [0, H, 0], each, 0.8, 1);
          });
          rect(pts, [b[0] - tw, b[1] + H, b[2] - tw], [tw * 2, 0, 0], [0, 0, tw * 2], per * 0.1, 1, 1);
        });
        return pts;
      };

      /* 6. Лайт-Пак: коробка с открытыми клапанами, из которой поднимается заказ */
      const box = () => {
        const pts = [];
        const s = Math.min(hw * 0.68, 1.1);
        const W = s, H = s * 0.72, D = s * 0.8;
        const y0 = -0.55;
        const faceN = (M * 0.56) / 9;
        const c = [
          [-W, y0 - H, D], [W, y0 - H, D], [W, y0 - H, -D], [-W, y0 - H, -D],
          [-W, y0 + H, D], [W, y0 + H, D], [W, y0 + H, -D], [-W, y0 + H, -D],
        ];
        const f = 0.55;
        rect(pts, c[0], [W * 2, 0, 0], [0, H * 2, 0], faceN * 1.5, 0.68, 0.9);
        rect(pts, c[1], [0, 0, -D * 2], [0, H * 2, 0], faceN * 1.1, 0.54, 0.9);
        rect(pts, c[3], [0, 0, D * 2], [0, H * 2, 0], faceN * 0.8, 0.3, 0.9);
        rect(pts, c[2], [-W * 2, 0, 0], [0, H * 2, 0], faceN * 0.8, 0.26, 0.9);
        rect(pts, c[4], [W * 2, 0, 0], [0, f * H, f * D * 1.3], faceN, 0.7, 1);
        rect(pts, c[7], [W * 2, 0, 0], [0, f * H, -f * D * 1.3], faceN, 0.7, 1);
        rect(pts, c[4], [0, 0, -D * 2], [-f * W, f * H, 0], faceN, 0.7, 1);
        rect(pts, c[5], [0, 0, -D * 2], [f * W, f * H, 0], faceN, 0.7, 1);
        const edgeN = Math.floor((M * 0.28) / 12);
        [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]
          .forEach(([a, b]) => line(pts, c[a], c[b], edgeN, 1, 1));
        const riseN = Math.floor(M * 0.07);
        for (let i = 0; i < riseN; i++) {
          const t = r();
          pts.push([gauss() * W * 0.35 * (1 - t * 0.5), y0 + H * 0.6 + t * 1.7, gauss() * D * 0.35 * (1 - t * 0.5), 0.3 + (1 - t) * 0.5, 0]);
        }
        return pts;
      };

      /* 3. Ровно 200 участников вокруг одного ответственного */
      const people = () => {
        const counts = [7, 14, 21, 28, 35, 44, 51];
        const R = portrait ? hw * 0.92 : 1.25;
        const out = [[0, 0, 0.02, 1, 1]];
        counts.forEach((c, k) => {
          const rad = ((k + 1) / 7) * R;
          for (let i = 0; i < c; i++) {
            const a = (i / c) * Math.PI * 2 + k * 0.4;
            out.push([Math.cos(a) * rad, Math.sin(a) * rad, 0, 0.92, 0]);
          }
        });
        const halo = [];
        for (let i = 0; i < 34; i++) halo.push([gauss() * 0.055, gauss() * 0.055, gauss() * 0.055, 0.72, 1]);
        return { exact: out, halo };
      };

      /* 5. Академия: 25 модулей и 114 уроков, программа идёт змейкой от начала к финалу */
      const academy = () => {
        const spanX = portrait ? hw * 1.5 : 1.9;
        const spanY = portrait ? hh * 0.95 : 1.9;
        const centers = [];
        for (let row = 0; row < 5; row++) for (let k = 0; k < 5; k++) {
          const col = row % 2 ? 4 - k : k;
          centers.push([(col / 4 - 0.5) * spanX, (0.5 - row / 4) * spanY, 0]);
        }
        const exact = [];
        const path = [];
        const rad = Math.min(spanX, spanY) * 0.055;
        const link = Math.floor((M * 0.3) / 24);
        centers.forEach((c, m) => {
          const n = m < 14 ? 5 : 4; // 14×5 + 11×4 = 114 уроков
          const h = m / 24;
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + m;
            exact.push([c[0] + Math.cos(a) * rad, c[1] + Math.sin(a) * rad, 0, 1, h]);
          }
          if (m < 24) line(path, c, centers[m + 1], link, 0.26, h);
        });
        return { exact, path };
      };

      /* 4. Метод: семь шагов по кругу, четвёртый выполняет ИИ */
      const loop = () => {
        const pts = [];
        const R = Math.min(hw * 0.84, 1.28);
        const lines = [];
        const pos = (a) => [Math.cos(a) * R, Math.sin(a) * R, 0];
        for (let k = 0; k < 7; k++) {
          const a = Math.PI / 2 - (k / 7) * Math.PI * 2;
          const p = pos(a);
          const h = k === 3 ? 1 : 0.15;
          const hl = Math.floor((M * 0.3) / 7);
          pts.push([p[0], p[1], p[2], 1, h]);
          for (let i = 0; i < hl; i++) pts.push([p[0] + gauss() * 0.08, p[1] + gauss() * 0.08, gauss() * 0.08, 0.66, h]);
          const b = Math.PI / 2 - ((k + 1) / 7) * Math.PI * 2;
          for (let s = 0; s < 14; s++) {
            const u0 = s / 14, u1 = (s + 1) / 14;
            const p0 = pos(lerp(a, b, u0)), p1 = pos(lerp(a, b, u1));
            lines.push(p0[0], p0[1], 0, (k + u0) / 7, 0, p1[0], p1[1], 0, (k + u1) / 7, 0);
          }
        }
        const arc = Math.floor(M * 0.34);
        for (let i = 0; i < arc; i++) {
          const a = r() * Math.PI * 2;
          const p = pos(a);
          pts.push([p[0] + gauss() * 0.05, p[1] + gauss() * 0.05, gauss() * 0.05, 0.42, 0.1]);
        }
        const inner = Math.floor(M * 0.12);
        for (let i = 0; i < inner; i++) {
          const a = r() * Math.PI * 2, d = Math.sqrt(r()) * R * 0.72;
          pts.push([Math.cos(a) * d, Math.sin(a) * d, gauss() * 0.3, 0.13, 0]);
        }
        return { pts, lines };
      };

      /* 7. Плотный фронтальный силуэт. Сквозные глаза не засоряются задними гранями. */
      const mascot = () => {
        const pts = [];
        const u = Math.min((hw * (portrait ? 1.62 : 1.84)) / 16, 0.2);
        const X = (x) => (x - 8) * u, Y = (y) => (5 - y) * u;
        const inside = (x, y) => {
          const head = x >= 2 && x <= 14 && y >= 0 && y <= 8;
          const arms = y >= 4 && y <= 6 && x >= 0 && x <= 16;
          const legs = y >= 8 && y <= 10 && [3, 5, 10, 12].some(a => x >= a && x <= a + 1);
          const eyes = y >= 2.1 && y <= 4 && ((x >= 4 && x <= 5) || (x >= 11 && x <= 12));
          return (head || arms || legs) && !eyes;
        };
        // Stratified grains cover the whole mask instead of clustering on cube seams.
        const step = Math.sqrt(108 / mascotN) * .97;
        for (let y = step / 2; y < 10; y += step) for (let x = step / 2; x < 16; x += step) {
          const px = x + (r() - .5) * step * .55;
          const py = y + (r() - .5) * step * .55;
          if (inside(px, py)) pts.push([X(px), Y(py), 0, .78 + r() * .2, 1]);
        }
        return shuffle(pts);
      };

      const n0 = net();
      write(0, n0.pts);
      write(1, stairs());
      write(2, system());
      const crowd = people();
      write(3, crowd.halo, crowd.exact);
      const l6 = loop();
      write(4, l6.pts);
      const ac = academy();
      write(5, ac.path, ac.exact);
      write(6, box());
      const grains = mascot();
      write(7, grains.slice(0, N));
      const dense = new Float32Array(mascotN * 4);
      // Preserve the first N destinations across the morph into the final scene.
      dense.set(data.subarray(7 * N * 4, 8 * N * 4));
      for (let i = N; i < mascotN; i++) {
        const p = grains[i % grains.length];
        dense.set([p[0], p[1], p[2], enc(p[3], p[4])], i * 4);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, mascotBuf);
      gl.bufferData(gl.ARRAY_BUFFER, dense, gl.STATIC_DRAW);

      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, netBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(n0.lines), gl.STATIC_DRAW);
      netCount = n0.lines.length / 5;
      gl.bindBuffer(gl.ARRAY_BUFFER, ringBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(l6.lines), gl.STATIC_DRAW);
      ringCount = l6.lines.length / 5;
    };

    const mat = new Float32Array(16);
    const setMatrix = (aspect, rx, ry, ox, oy) => {
      const f = 1 / Math.tan((38 * Math.PI) / 360);
      const zn = 0.1, zf = 30;
      const cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
      const dz = -5;
      const a = f / aspect, b = f, c = (zf + zn) / (zn - zf), d = (2 * zf * zn) / (zn - zf);
      // P * T(0,0,dz) * Rx * Ry
      mat[0] = a * cy; mat[1] = b * sx * sy; mat[2] = -c * cx * sy; mat[3] = cx * sy;
      mat[4] = 0; mat[5] = b * cx; mat[6] = c * sx; mat[7] = -sx;
      mat[8] = a * sy; mat[9] = b * -sx * cy; mat[10] = c * cx * cy; mat[11] = -cx * cy;
      mat[12] = a * ox; mat[13] = b * oy; mat[14] = c * dz + d; mat[15] = -dz;
    };

    let W = 0, H = 0, aspect = 1, builtPortrait = null, builtAspect = 0, ready = false;
    const resize = () => {
      const w = innerWidth;
      const h = Math.max(innerHeight, document.documentElement.clientHeight);
      if (w === W && Math.abs(h - H) < 130) return;
      W = w; H = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      aspect = w / h;
      gl.viewport(0, 0, canvas.width, canvas.height);
      if (!ready) return;
      if (builtPortrait !== aspect < 1 || Math.abs(aspect - builtAspect) > 0.12) {
        build(aspect);
        builtPortrait = aspect < 1;
        builtAspect = aspect;
      }
    };

    const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
    const palettes = {
      dark: { cold: hex('#7FD4E8'), warm: hex('#F2875C'), dim: 1, add: true },
      light: { cold: hex('#0B6F87'), warm: hex('#C24E20'), dim: 0.92, add: false },
    };
    let pal = palettes.dark;
    themeListeners.push((t) => { pal = palettes[t] || palettes.dark; });

    const tilt = [-0.12, -0.42, -0.08, -0.72, -0.16, -0.22, -0.32, -0.06];
    const sizes = [1, 1, 1, 1.5, 1.35, 1.35, 1.1, 1];
    const yaw = [0.2, 0.42, 0.3, 0.2, 0.12, 0.36, 0.62, 0.04];
    const offs = (loc, size, stride, off) => gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);

    const render = (time, s, t, spin) => {
      if (!ready) return;
      // stateAt keeps the last stop as [6, 1]; use the dense final buffer there.
      if (s === 6 && t >= .999) { s = 7; t = 0; }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      if (pal.add) gl.blendFunc(gl.ONE, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      const next = Math.min(s + 1, STATES - 1);
      const mascotMix = s === 7 ? 1 : s === 6 ? sstep(.55, 1, t) : 0;
      const sway = (x) => Math.sin(time * 0.22) * x;
      const ry = lerp(sway(yaw[s]), sway(yaw[next]), t) + input.sx * lerp(.28, .05, mascotMix) + spin * (1 - mascotMix);
      const rx = lerp(tilt[s], tilt[next], t) + input.sy * lerp(.12, .03, mascotMix);
      // Форма держится в свободной части экрана: над заголовком на телефоне, правее текста на компьютере
      const place = (st) => {
        if (st === 0) return [0, 0];
        if (aspect < 1) return [0, st === 7 ? .82 : st === 6 ? 0.42 : st === 1 ? 0.44 : 0.56];
        return [Math.min(1.72 * aspect, 2.9) * 0.34, 0.1];
      };
      const pa = place(s), pb = place(next);
      setMatrix(aspect, rx, ry, lerp(pa[0], pb[0], t), lerp(pa[1], pb[1], t));

      const ripAge = performance.now() / 1000 - input.rip.t;

      gl.useProgram(pointsProg);
      gl.uniformMatrix4fv(U.puM, false, mat);
      gl.uniform1f(U.puT, t);
      gl.uniform1f(U.puMascot, mascotMix);
      const mascotUnit = Math.min((Math.min(1.72 * aspect, 2.9) * (aspect < 1 ? 1.62 : 1.84)) / 16, .2);
      gl.uniform1f(U.puGrain, Math.max(1.5, H * .2904 * mascotUnit * Math.sqrt(108 / mascotN) * 1.25));
      gl.uniform1f(U.puSz, lerp(sizes[s], sizes[next], t));
      gl.uniform1f(U.puTime, time);
      gl.uniform1f(U.puPx, dpr);
      gl.uniform1f(U.puAsp, aspect);
      gl.uniform1f(U.puPtrA, input.active * lerp(1, .15, mascotMix));
      gl.uniform1f(U.puRipA, ripAge);
      gl.uniform2f(U.puPtr, input.sx, input.sy);
      gl.uniform2f(U.puRip, input.rip.x, input.rip.y);
      gl.uniform3fv(U.puCold, pal.cold);
      gl.uniform3fv(U.puWarm, pal.warm);
      const heroDim = aspect < 1 ? 0.62 : 0.82;
      gl.uniform1f(U.puDim, pal.dim * lerp(s === 0 ? heroDim : 1, 1, s === 0 ? t : 1));

      gl.bindBuffer(gl.ARRAY_BUFFER, s === 7 ? mascotBuf : posBuf);
      gl.enableVertexAttribArray(aA);
      gl.enableVertexAttribArray(aB);
      offs(aA, 4, 0, s === 7 ? 0 : s * N * 16);
      offs(aB, 4, 0, s === 7 ? 0 : next * N * 16);
      gl.bindBuffer(gl.ARRAY_BUFFER, seedBuf);
      gl.enableVertexAttribArray(aS);
      offs(aS, 4, 0, 0);
      const pointCount = s === 7 ? mascotN : drawN;
      gl.drawArrays(gl.POINTS, 0, pointCount);
      if (canvas.dataset.pointCount !== String(pointCount)) canvas.dataset.pointCount = String(pointCount);
      if (canvas.dataset.scene !== String(s)) canvas.dataset.scene = String(s);

      // Линии видны, только когда форма уже собрана
      const lineFor = (buf, count, alpha, base) => {
        if (alpha < 0.01 || !count) return;
        gl.useProgram(linesProg);
        gl.uniformMatrix4fv(U.luM, false, mat);
        gl.uniform1f(U.luTime, time);
        gl.uniform1f(U.luAsp, aspect);
        gl.uniform1f(U.luPtrA, input.active);
        gl.uniform1f(U.luRipA, ripAge);
        gl.uniform2f(U.luPtr, input.sx, input.sy);
        gl.uniform2f(U.luRip, input.rip.x, input.rip.y);
        gl.uniform3fv(U.luCold, pal.cold);
        gl.uniform3fv(U.luWarm, pal.warm);
        gl.uniform1f(U.luAlpha, alpha);
        gl.uniform1f(U.luBase, base);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(aP);
        gl.enableVertexAttribArray(aU);
        offs(aP, 3, 20, 0);
        offs(aU, 2, 20, 12);
        gl.drawArrays(gl.LINES, 0, count);
      };
      if (s === 0) lineFor(netBuf, netCount, Math.pow(1 - t, 4) * (aspect < 1 ? 0.5 : 0.42), 0.09);
      if (s === 3) lineFor(ringBuf, ringCount, Math.pow(t, 6), 0.4);
      if (s === 4) lineFor(ringBuf, ringCount, Math.pow(1 - t, 4), 0.4);
    };

    // Снижаем нагрузку, если устройство не тянет
    const degrade = () => {
      drawN = Math.max(420, Math.floor(drawN * 0.6));
      dpr = 1;
      W = 0;
      resize();
    };

    resize();
    afterPaint(() => {
      ready = true;
      build(aspect);
      builtPortrait = aspect < 1;
      builtAspect = aspect;
    });
    return { render, resize, degrade, states: STATES, count: N, canvas, get drawN() { return drawN; } };
  })();

  /* ---------- Привязка сцены к прокрутке ---------- */
  const stops = [];
  const panels = [];
  let docH = 1;
  const measure = () => {
    const sy = scrollY;
    stops.length = 0;
    $$('[data-state]').forEach((el) => {
      const r = el.getBoundingClientRect();
      stops.push({ state: +el.dataset.state, y: r.top + sy + r.height / 2 });
    });
    stops.sort((a, b) => a.y - b.y);
    panels.length = 0;
    $$('.panel').forEach((el) => {
      const r = el.getBoundingClientRect();
      panels.push([r.top + sy, r.bottom + sy]);
    });
    docH = document.documentElement.scrollHeight;
    Bot.measure();
    $$('.rail-tick').forEach((t) => t.remove());
    const rail = $('#rail');
    stops.slice(1).forEach((s) => {
      const tick = document.createElement('i');
      tick.className = 'rail-tick';
      tick.style.left = `${clamp(((s.y - innerHeight / 2) / Math.max(1, docH - innerHeight)) * 100, 0, 100)}%`;
      rail.appendChild(tick);
    });
  };
  const stateAt = (scroll) => {
    const vh = innerHeight;
    const y = scroll + vh / 2;
    if (!stops.length || y <= stops[0].y) return [0, 0];
    for (let i = 0; i < stops.length - 1; i++) {
      const next = stops[i + 1];
      if (y < next.y) {
        return [stops[i].state, sstep(next.y - vh * 1.05, next.y - vh * 0.14, y)];
      }
    }
    return [Math.max(0, stops[stops.length - 1].state - 1), 1];
  };

  /* ---------- Талисман: идёт по шкале прокрутки вместе с читателем ---------- */
  const Bot = (() => {
    const el = $('#bot');
    const body3d = $('.bot-3d', el);
    const hit = $('.bot-hit', el);
    const bubble = $('#say');
    const U_PX = 7;
    const WIDTH = 16 * U_PX, HEIGHT = 10 * U_PX;
    const legs = [];
    let eyes = [];

    const face = (parent, cls, w, h, tf, x = 0, y = 0) => {
      const f = document.createElement('i');
      f.className = `bot-f ${cls}`;
      f.style.cssText = `width:${w}px;height:${h}px;left:${x}px;top:${y}px;transform:${tf}`;
      parent.appendChild(f);
      return f;
    };
    const box = (x, y, z, w, h, d) => {
      const u = U_PX;
      const b = document.createElement('i');
      b.className = 'bot-b';
      b.style.cssText = `left:${x * u}px;top:${y * u}px;width:${w * u}px;height:${h * u}px;transform:translateZ(${z * u}px)`;
      const W = w * u, H = h * u, D = d * u;
      const front = face(b, 'fr', W, H, `translateZ(${D / 2}px)`);
      face(b, 'bk', W, H, `rotateY(180deg) translateZ(${D / 2}px)`);
      face(b, 'sd', D, H, `rotateY(-90deg) translateZ(${W / 2}px)`, (W - D) / 2, 0);
      face(b, 'sd', D, H, `rotateY(90deg) translateZ(${W / 2}px)`, (W - D) / 2, 0);
      face(b, 'tp', W, D, `rotateX(90deg) translateZ(${H / 2}px)`, 0, (H - D) / 2);
      face(b, 'bt', W, D, `rotateX(-90deg) translateZ(${H / 2}px)`, 0, (H - D) / 2);
      body3d.appendChild(b);
      return { b, front, z: z * u };
    };

    const torso = box(2, 0, 0, 12, 8, 7);
    box(0, 4, 0, 2, 2, 3);
    box(14, 4, 0, 2, 2, 3);
    [[3, 1.4], [5, -1.4], [10, -1.4], [12, 1.4]].forEach(([x, z]) => legs.push(box(x, 8, z, 1, 2, 2)));
    eyes = [2, 9].map((x) => {
      const e = document.createElement('i');
      e.className = 'bot-eye';
      e.style.cssText = `left:${x * U_PX}px;top:${2 * U_PX}px;width:${U_PX}px;height:${2 * U_PX}px`;
      torso.front.appendChild(e);
      return e;
    });

    const st = {
      x: 0, y: 0, scale: 1, ry: 0, rx: -0.15, spin: 0,
      hop: -260, hopV: 0, phase: 0, walk: 0, squash: 0,
      spotX: 0, spotY: 0, spotScale: 1, sayT: 0, shown: false,
    };

    const measureBot = () => {
      const s = $('#botSpot');
      if (!s) return;
      const r = s.getBoundingClientRect();
      st.spotX = r.left + r.width / 2;
      st.spotY = r.bottom + scrollY;
      st.spotScale = innerWidth < 980 ? 0.68 : 0.92;
    };

    let bubbleW = 0;
    const say = (text, ms = 3200) => {
      bubble.textContent = text;
      bubbleW = bubble.offsetWidth;
      bubble.classList.add('on');
      st.sayT = performance.now() + ms;
    };

    const tips = [
      'Я талисман Claude Code. Иосиф делает свои системы вместе с такими инструментами.',
      'Точки на лице собраны из настоящего снимка. На фоне каждая форма показывает факт из резюме.',
      'На телефоне можно коснуться экрана: сцена отреагирует.',
      'Контакты в самом конце. Или в меню сверху.',
    ];
    let tipI = 0;
    hit.addEventListener('click', () => {
      if (st.hop >= -0.5) st.hopV = -520;
      st.spin += Math.PI * 2;
      say(tips[tipI++ % tips.length]);
    });

    // Моргание
    if (!REDUCED) {
      const blink = () => {
        eyes.forEach((e) => e.classList.add('shut'));
        setTimeout(() => eyes.forEach((e) => e.classList.remove('shut')), 130);
        setTimeout(blink, 2200 + Math.random() * 3200);
      };
      setTimeout(blink, 1800);
    }

    const frame = (dt, scroll, vel) => {
      const vw = innerWidth, vh = innerHeight;
      const prog = clamp(scroll / Math.max(1, docH - vh), 0, 1);
      const s0 = Math.max(0, st.spotY - vh * 0.5);
      const m = sstep(s0, s0 + vh * 0.55, scroll);

      const railScale = vw < 560 ? 0.36 : 0.44;
      const pad = 16 + (WIDTH * railScale) / 2;
      const railX = pad + prog * (vw - pad * 2);
      const railB = 0;

      const heroY = st.spotY - scroll - vh;
      const scale = lerp(st.spotScale, railScale, m);
      const cx = lerp(st.spotX, railX, m);
      let by = lerp(heroY, -railB, m) - Math.sin(m * Math.PI) * 46;

      // Прыжок и падение при загрузке
      if (!REDUCED) {
        st.hopV += 1500 * dt;
        st.hop += st.hopV * dt;
        if (st.hop > 0) {
          if (st.hopV > 240) st.squash = Math.min(1, st.hopV / 900);
          st.hop = 0;
          st.hopV = st.hopV > 240 ? -st.hopV * 0.26 : 0;
        }
        st.squash *= Math.exp(-dt * 11);
      } else st.hop = 0;
      by += st.hop * lerp(1, 0.55, m);

      // Походка привязана к прокрутке: ноги идут ровно столько, сколько читатель листает
      const moving = clamp(Math.abs(vel) / 500, 0, 1);
      st.walk = lerp(st.walk, m > 0.5 ? moving : 0, 1 - Math.exp(-dt * 9));
      st.phase += Math.abs(vel) * dt * 0.05;
      const ang = Math.sin(st.phase) * 42 * st.walk;
      legs.forEach((l, i) => {
        const a = i % 2 ? ang : -ang;
        l.b.style.transform = `translateZ(${l.z}px) rotateX(${a.toFixed(1)}deg)`;
      });
      const bob = Math.abs(Math.cos(st.phase)) * 4 * st.walk;

      // Куда смотрит: при ходьбе в сторону движения, в покое на указатель
      const dir = vel >= 0 ? 1 : -1;
      const targetY = lerp(input.sx * 0.55 + Math.sin(performance.now() / 1700) * 0.16, dir * 0.95, st.walk);
      const targetX = lerp(-0.2 - input.sy * 0.25, -0.1, st.walk);
      const k = 1 - Math.exp(-dt * 7);
      st.ry = lerp(st.ry, targetY, k);
      st.rx = lerp(st.rx, targetX, k);
      st.spin *= Math.exp(-dt * 3.2);

      const left = cx - (WIDTH * scale) / 2;
      const sq = st.squash;
      el.style.transform = `translate3d(${left.toFixed(1)}px,${(by - bob).toFixed(1)}px,0) scale(${(scale * (1 + sq * 0.16)).toFixed(3)},${(scale * (1 - sq * 0.2)).toFixed(3)})`;
      body3d.style.transform = `rotateX(${st.rx.toFixed(3)}rad) rotateY(${(st.ry + st.spin).toFixed(3)}rad)`;

      // Реплика над талисманом
      if (bubble.classList.contains('on')) {
        const head = vh + by - HEIGHT * scale;
        const bx = clamp(cx - bubbleW / 2, 12, vw - bubbleW - 12);
        bubble.style.transform = `translate3d(${bx.toFixed(1)}px,${(head - 12).toFixed(1)}px,0) translateY(-100%)`;
        if (performance.now() > st.sayT) bubble.classList.remove('on');
      }
      $('#railFill').style.transform = `scaleX(${prog.toFixed(4)})`;
    };

    return { frame, measure: measureBot, say, st };
  })();

  /* ---------- Реплики при входе в разделы ---------- */
  {
    const seen = new Set();
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => {
        if (!e.isIntersecting || seen.has(e.target)) return;
        seen.add(e.target);
        Bot.say(e.target.dataset.say);
      });
    }, { threshold: 0.45 });
    $$('[data-say]').forEach((el) => io.observe(el));
  }

  /* ---------- Появление блоков: без скриптов всё и так видно ---------- */
  {
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    $$('.rv').forEach((el) => io.observe(el));
  }

  /* ---------- Счётчики в больших цифрах ---------- */
  {
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => {
        if (!e.isIntersecting || REDUCED) return;
        io.unobserve(e.target);
        const el = e.target;
        const to = +el.dataset.count;
        const dec = (el.dataset.count.split('.')[1] || '').length;
        const suffix = el.dataset.suffix || '';
        const prefix = el.dataset.prefix || '';
        const t0 = performance.now();
        const step = (now) => {
          const p = clamp((now - t0) / 1100, 0, 1);
          const v = to * (1 - Math.pow(1 - p, 3));
          el.textContent = prefix + v.toFixed(dec).replace('.', ',') + suffix;
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    }, { threshold: 0.6 });
    $$('[data-count]').forEach((el) => io.observe(el));
  }

  /* ---------- Вторая половина лица: точки из настоящего снимка ---------- */
  const Face = (() => {
    const canvas = $('#faceDots');
    const photo = $('.p-real');
    const box = $('#portrait');
    const fail = () => { root.classList.add('no-dots'); return null; };
    if (!Field) return fail();
    const gl = canvas.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: true, depth: false, stencil: false });
    if (!gl) return fail();

    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, `
      attribute vec2 aHome; attribute vec3 aCol; attribute vec4 aD; // aD: яркость, контур, случайное, удалённость от шва
      uniform vec2 uSize; uniform float uTime, uIn, uOut, uDot, uPx, uLight;
      uniform vec2 uPtr; uniform float uPtrA; uniform vec3 uRip;
      uniform vec3 uCold, uWarm;
      varying vec3 vC; varying float vA;
      void main() {
        float t = aD.w, rnd = aD.z;
        float k = clamp(uIn * 1.7 - rnd * .7, 0., 1.);
        k = 1. - pow(1. - k, 3.);
        vec2 from = aHome + vec2(-260. - rnd * 340., (rnd - .5) * 620.);
        vec2 p = mix(from, aHome, k);
        p += vec2(sin(uTime * .9 + rnd * 40.), cos(uTime * .7 + rnd * 70.)) * (.35 + t * 1.5);
        // Волна идёт от шва наружу: сеть как будто считает лицо заново
        float scan = fract(uTime / 6.5) * 1.5 - .1;
        float wave = exp(-pow((t - scan) * 9., 2.));
        p.x -= wave * 3.;
        // Указатель и касание
        vec2 dd = p - uPtr;
        float pd = length(dd);
        p += dd / (pd + .001) * exp(-pd * pd / 2300.) * 26. * uPtrA;
        if (uRip.z < 1.5) {
          vec2 rr = p - uRip.xy;
          float d = length(rr), f = d - uRip.z * 260.;
          p += rr / (d + .001) * sin(f * .09) * exp(-abs(f) * .022) * (1. - uRip.z / 1.5) * 13.;
        }
        // При прокрутке точки разлетаются и уходят в сеть
        p += vec2(-200. - rnd * 300., (rnd - .62) * 460.) * uOut * uOut;
        vec2 clip = p / uSize * 2. - 1.;
        gl_Position = vec4(clip.x, -clip.y, 0., 1.);
        float lum = uLight > .5 ? 1. - aD.x : aD.x;
        float edge = aD.y;
        gl_PointSize = uDot * (.34 + .66 * lum + edge * .55 + wave * .35) * uPx;
        vec3 c = mix(aCol, uCold, smoothstep(.03, .36, t));
        c = mix(c, uWarm, clamp(edge * .85 * smoothstep(.05, .3, t) + wave * .75, 0., 1.));
        vC = c;
        vA = clamp((.3 + lum * .7 + edge) * k, 0., 1.) * (1. - uOut);
      }`));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying vec3 vC; varying float vA;
      void main() {
        float d = length(gl_PointCoord - .5);
        float a = smoothstep(.5, .32, d) * vA;
        gl_FragColor = vec4(vC * a, a);
      }`));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const loc = {};
    ['uSize', 'uTime', 'uIn', 'uOut', 'uDot', 'uPx', 'uLight', 'uPtr', 'uPtrA', 'uRip', 'uCold', 'uWarm'].forEach((n) => { loc[n] = gl.getUniformLocation(prog, n); });
    const buf = gl.createBuffer();
    const a = { h: gl.getAttribLocation(prog, 'aHome'), c: gl.getAttribLocation(prog, 'aCol'), d: gl.getAttribLocation(prog, 'aD') };

    const isPhone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
    const weak = (navigator.deviceMemory || 4) <= 2 || (navigator.hardwareConcurrency || 4) <= 4;
    let count = 0, dot = 4, dpr = 1, cw = 0, ch = 0, ready = false, t0 = 0, visible = true, lastW = 0, lastH = 0;
    const OVERLAP = 16; // точки чуть заходят на снимок, чтобы шов растворялся

    const build = () => {
      const r = box.getBoundingClientRect();
      if (!r.width) return;
      const half = r.width / 2;
      lastW = r.width;
      lastH = r.height;
      cw = half + OVERLAP;
      ch = r.height;
      dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);

      // Снимок сжимаем до сетки: каждая ячейка становится точкой
      const step = isPhone ? (weak ? 6 : 4.6) : 4.4;
      const gw = Math.ceil(half / step);
      const gh = Math.ceil(ch / step);
      const off = document.createElement('canvas');
      off.width = gw;
      off.height = gh;
      const g = off.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingQuality = 'high';
      g.drawImage(photo, 0, 0, gw, gh);
      const px = g.getImageData(0, 0, gw, gh).data;
      const L = new Float32Array(gw * gh);
      for (let i = 0; i < gw * gh; i++) {
        L[i] = ((0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255) * (px[i * 4 + 3] / 255);
      }
      const at = (x, y) => L[clamp(y, 0, gh - 1) * gw + clamp(x, 0, gw - 1)];
      const rand = rng(11);
      const out = [];
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const al = px[i * 4 + 3] / 255;
        if (al < 0.3) continue;
        const sx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
        const sy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
        const edge = clamp(Math.hypot(sx, sy) * 0.9 - 0.14, 0, 1);
        const lum = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
        const t = (x + 0.5) / gw;
        const rnd = rand();
        // Зеркально: снимок справа от шва, точки слева
        const jit = t * t * 2.4;
        out.push(
          half - (x + 0.5) * step + (rand() - 0.5) * jit, (y + 0.5) * step + (rand() - 0.5) * jit,
          px[i * 4] / 255, px[i * 4 + 1] / 255, px[i * 4 + 2] / 255,
          lum / 255, edge, rnd, t,
        );
      }
      // Несколько рядов за швом: снимок постепенно проявляется из точек
      const over = Math.ceil(OVERLAP / step);
      for (let y = 0; y < gh; y++) for (let x = 0; x < over; x++) {
        const i = y * gw + x;
        if (px[i * 4 + 3] / 255 < 0.3) continue;
        const lum = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
        out.push(
          half + (x + 0.5) * step, (y + 0.5) * step,
          px[i * 4] / 255, px[i * 4 + 1] / 255, px[i * 4 + 2] / 255,
          lum / 255, 0, rand(), 0,
        );
      }
      count = out.length / 9;
      dot = step * 1.08;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(a.h);
      gl.enableVertexAttribArray(a.c);
      gl.enableVertexAttribArray(a.d);
      gl.vertexAttribPointer(a.h, 2, gl.FLOAT, false, 36, 0);
      gl.vertexAttribPointer(a.c, 3, gl.FLOAT, false, 36, 8);
      gl.vertexAttribPointer(a.d, 4, gl.FLOAT, false, 36, 20);
      ready = true;
      if (!t0) t0 = performance.now();
    };

    const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
    const pal = {
      dark: { cold: hex('#7FD4E8'), warm: hex('#F2875C') },
      light: { cold: hex('#0B6F87'), warm: hex('#C24E20') },
    };
    let theme = root.dataset.theme === 'light' ? 'light' : 'dark';
    let dirty = true;
    themeListeners.push((t) => { theme = t === 'light' ? 'light' : 'dark'; dirty = true; });

    // Если браузер не даёт прочитать снимок, показываем запасное зеркало
    const start = () => {
      const run = () => {
        try { build(); } catch (e) { canvas.style.display = 'none'; fail(); }
      };
      (photo.decode ? photo.decode().catch(() => {}) : Promise.resolve()).then(() => afterPaint(run));
    };
    if (photo.complete && photo.naturalWidth) start();
    else {
      photo.addEventListener('load', start, { once: true });
      photo.addEventListener('error', fail, { once: true });
    }

    new IntersectionObserver((es) => {
      visible = es[0].isIntersecting;
      dirty = true;
    }).observe(box);

    // Указатель в координатах холста
    const ptr = { x: -999, y: -999, sx: -999, sy: -999, a: 0, sa: 0 };
    addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      ptr.x = e.clientX - r.left;
      ptr.y = e.clientY - r.top;
      ptr.a = ptr.x > -60 && ptr.x < r.width + 60 && ptr.y > -60 && ptr.y < r.height + 60 ? 1 : 0;
      if (ptr.sx < -900) { ptr.sx = ptr.x; ptr.sy = ptr.y; }
    }, { passive: true });
    addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') ptr.a = 0; }, { passive: true });
    const rip = { x: 0, y: 0, t: -9 };
    addEventListener('pointerdown', (e) => {
      const r = canvas.getBoundingClientRect();
      rip.x = e.clientX - r.left;
      rip.y = e.clientY - r.top;
      rip.t = performance.now() / 1000;
    }, { passive: true });

    const frame = (scroll) => {
      if (!ready || !visible) return;
      const r = box.getBoundingClientRect();
      if (Math.abs(r.width - lastW) > 1 || Math.abs(r.height - lastH) > 1) { build(); dirty = true; }
      if (!visible) return;
      if (REDUCED && !dirty) return;
      dirty = false;
      const now = performance.now();
      const time = REDUCED ? 0 : now / 1000;
      const uIn = REDUCED ? 1 : clamp((now - t0) / 1900, 0, 1);
      const uOut = REDUCED ? 0 : sstep(innerHeight * 0.1, r.height * 0.95 + innerHeight * 0.1, scroll);
      ptr.sx = lerp(ptr.sx, ptr.x, 0.14);
      ptr.sy = lerp(ptr.sy, ptr.y, 0.14);
      ptr.sa = lerp(ptr.sa, ptr.a, 0.08);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform2f(loc.uSize, cw, ch);
      gl.uniform1f(loc.uTime, time);
      gl.uniform1f(loc.uIn, uIn);
      gl.uniform1f(loc.uOut, uOut);
      gl.uniform1f(loc.uDot, dot);
      gl.uniform1f(loc.uPx, dpr);
      gl.uniform1f(loc.uLight, theme === 'light' ? 1 : 0);
      gl.uniform2f(loc.uPtr, ptr.sx, ptr.sy);
      gl.uniform1f(loc.uPtrA, ptr.sa);
      gl.uniform3f(loc.uRip, rip.x, rip.y, now / 1000 - rip.t);
      gl.uniform3fv(loc.uCold, pal[theme].cold);
      gl.uniform3fv(loc.uWarm, pal[theme].warm);
      gl.drawArrays(gl.POINTS, 0, count);
    };
    return { frame, get count() { return count; } };
  })();

  /* ---------- Демо: аналитика отдела одной кнопкой (условные данные) ---------- */
  {
    const demo = $('#demo');
    const S = { mod: 0, period: 'week', view: 'chat', nonce: 1, busy: false };
    const PER = { day: 1, week: 5, month: 21, all: 63 };
    const LETTERS = ['А', 'Б', 'В', 'Г', 'Д'];
    const STAGES = ['Новые', 'В работе', 'Согласование', 'Заезд'];

    const data = () => {
      const r = rng(S.mod * 97 + S.nonce * 13 + 5);
      const mult = PER[S.period];
      const make = (name, size) => {
        const chats = Math.round((16 + r() * 26) * size * mult);
        const resp = 2 + r() * 11;
        const leads = Math.round((24 + r() * 72) * size);
        const parts = [r() * 0.3 + 0.1, r() * 0.4 + 0.3, r() * 0.2 + 0.1, r() * 0.15 + 0.05];
        const sum = parts.reduce((a, b) => a + b, 0);
        const kpi = Math.round(clamp(62 + (chats / (size * mult) - 16) * 1.3 - resp * 1.4 + r() * 12, 42, 118));
        return { name, chats, resp, leads, kpi, parts: parts.map((p) => p / sum) };
      };
      const rows = S.mod === 0
        ? Array.from({ length: 10 }, (_, i) => make(`Модуль ${i + 1}`, 5))
        : LETTERS.map((l) => make(`Рекрутёр ${l}`, 1));
      const free = rows.slice().sort((a, b) => a.leads - b.leads).slice(0, 2).map((x) => x.name);
      return {
        rows,
        free,
        toAssign: Math.round(6 + r() * 30) * (S.mod === 0 ? 4 : 1),
        offStaff: Math.round(2 + r() * 9) * (S.mod === 0 ? 4 : 1),
        leadId: 10000 + Math.round(r() * 80000),
      };
    };
    const fmt = (v) => v.toLocaleString('ru-RU');

    const render = () => {
      const d = data();
      const avg = (f) => d.rows.reduce((a, x) => a + f(x), 0) / d.rows.length;
      const tot = (f) => d.rows.reduce((a, x) => a + f(x), 0);
      const tiles = S.view === 'chat'
        ? [['Обработано чатов', fmt(tot((x) => x.chats))], ['Среднее время ответа', `${avg((x) => x.resp).toFixed(1).replace('.', ',')} мин`], ['Средний KPI', `${Math.round(avg((x) => x.kpi))}%`]]
        : [['Лидов в работе', fmt(tot((x) => x.leads))], ['Можно распределить', fmt(d.toAssign)], ['На внештатных', fmt(d.offStaff)]];
      $('#dTiles').innerHTML = tiles.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

      const head = S.view === 'chat'
        ? `<div class="d-row d-head"><span>${S.mod ? 'Рекрутёр' : 'Модуль'}</span><span>Чатов</span><span>Ответ</span><span>KPI</span></div>`
        : `<div class="d-row d-head d-lead"><span>${S.mod ? 'Рекрутёр' : 'Модуль'}</span><span>Лидов</span><span>Стадии</span></div>`;
      const rows = d.rows.map((x) => {
        const open = S.mod ? '' : ` data-open="${x.name.replace('Модуль ', '')}"`;
        const tag = S.mod ? 'div' : 'button';
        const type = S.mod ? '' : ' type="button"';
        return S.view === 'chat'
          ? `<${tag}${type} class="d-row"${open}><span>${x.name}</span><span>${fmt(x.chats)}</span><span>${x.resp.toFixed(1).replace('.', ',')}</span><span class="d-kpi"><i style="width:${Math.min(100, x.kpi / 1.2)}%"></i><b>${x.kpi}%</b></span></${tag}>`
          : `<${tag}${type} class="d-row d-lead"${open}><span>${x.name}</span><span>${fmt(x.leads)}</span><span class="d-stack" aria-label="Распределение по стадиям">${x.parts.map((p, i) => `<i class="s${i}" style="width:${(p * 100).toFixed(1)}%"></i>`).join('')}</span></${tag}>`;
      }).join('');
      $('#dTable').innerHTML = head + rows;

      const extra = $('#dExtra');
      if (S.view === 'lead') {
        extra.innerHTML = `
          <p class="d-legend">${STAGES.map((n, i) => `<span><i class="s${i}"></i>${n}</span>`).join('')}</p>
          <ul class="d-flags">
            <li><b>${fmt(d.toAssign)} новых заявок</b> можно распределить: меньше всего загружены ${d.free.join(' и ')}.</li>
            <li><b>${fmt(d.offStaff)} лидов</b> закреплены за сотрудниками, которые не ведут обработку. Их нужно перенаправить.</li>
            <li><button type="button" class="d-link" id="dLink">Лид №${d.leadId} ↗</button> Каждая строка ведёт на карточку в Bitrix24.</li>
          </ul>`;
        $('#dLink').addEventListener('click', () => { Bot.say('В настоящей системе здесь откроется карточка лида.'); });
      } else {
        extra.innerHTML = `<p class="d-note">Показатели сравниваются внутри модуля и по всему отделу. KPI считается автоматически по заложенным правилам.</p>`;
      }
      $$('[data-mod]', demo).forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.mod === S.mod)));
      $$('[data-period]', demo).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.period === S.period)));
      $$('[data-view]', demo).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === S.view)));
    };

    const modBar = $('#dMods');
    modBar.innerHTML = `<button type="button" data-mod="0">Весь отдел</button>${Array.from({ length: 10 }, (_, i) => `<button type="button" data-mod="${i + 1}">${i + 1}</button>`).join('')}`;

    demo.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.mod != null) { S.mod = +b.dataset.mod; render(); }
      if (b.dataset.period) { S.period = b.dataset.period; render(); }
      if (b.dataset.view) { S.view = b.dataset.view; render(); }
      if (b.dataset.open) { S.mod = +b.dataset.open; render(); }
    });

    const run = () => {
      if (S.busy) return;
      S.busy = true;
      const btn = $('#dRun');
      const label = $('#dStatus');
      demo.classList.add('running');
      btn.disabled = true;
      label.textContent = 'Обрабатываю выгрузки Bitrix24 и Chat2Desk…';
      setTimeout(() => {
        S.nonce++;
        render();
        demo.classList.remove('running');
        btn.disabled = false;
        label.textContent = 'Свод обновлён. Нажатий: одно.';
        S.busy = false;
      }, REDUCED ? 0 : 1100);
    };
    $('#dRun').addEventListener('click', run);
    render();
    new IntersectionObserver((es, io) => {
      if (es[0].isIntersecting) { io.disconnect(); run(); }
    }, { threshold: 0.35 }).observe(demo);
  }

  /* ---------- Демо: турнирная сетка (условный пример) ---------- */
  {
    const wrap = $('#bracket');
    const btn = $('#bRun');
    const names = ['Участник 1', 'Участник 2', 'Участник 3', 'Участник 4'];
    let nonce = 3, timers = [];
    const judge = (r) => Array.from({ length: 3 }, () => 5 + Math.floor(r() * 6));
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const f1 = (v) => v.toFixed(1).replace('.', ',');

    const cell = (name, score, cls = '') => `<div class="b-cell ${cls}"><span>${name}</span><b>${score ?? ''}</b></div>`;
    const draw = (st) => {
      const semi = names.map((n, i) => {
        const sc = st.semi && st.semi[i];
        const won = st.semi && st.fin && st.fin.includes(i);
        return cell(n, sc != null ? f1(sc) : '', st.semi ? (won ? 'won' : 'out') : '');
      }).join('');
      const fin = [0, 1].map((k) => {
        if (!st.fin) return cell('Ожидает', '', 'empty');
        const i = st.fin[k];
        const sc = st.finS && st.finS[k];
        const cls = st.champ != null ? (st.champ === i ? 'won' : 'out') : '';
        return cell(names[i], sc != null ? f1(sc) : '', cls);
      }).join('');
      const champ = st.champ != null ? cell(names[st.champ], '', 'won champ') : cell('Ожидает', '', 'empty');
      wrap.innerHTML = `
        <div class="b-col"><h4>Полуфинал</h4>${semi}</div>
        <div class="b-col b-mid"><h4>Финал</h4>${fin}</div>
        <div class="b-col b-mid"><h4>Победитель</h4>${champ}</div>`;
      const sum = $('#bSum');
      if (st.champ != null) {
        const rows = names.map((n, i) => {
          const total = st.semi[i] + (st.fin.includes(i) ? st.finS[st.fin.indexOf(i)] : 0);
          const max = st.fin.includes(i) ? 20 : 10;
          return { n, k: total / max };
        }).sort((a, b) => b.k - a.k);
        sum.innerHTML = `Коэффициент эффективности: ${rows.map((x) => `<span>${x.n.replace('Участник ', '№')} — ${x.k.toFixed(2).replace('.', ',')}</span>`).join('')}`;
      } else sum.textContent = 'Коэффициент эффективности появится после финала.';
    };
    const play = () => {
      timers.forEach(clearTimeout);
      timers = [];
      nonce++;
      const r = rng(nonce * 41);
      const semi = names.map(() => avg(judge(r)));
      if (semi[0] === semi[1]) semi[0] += 0.3;
      if (semi[2] === semi[3]) semi[2] += 0.3;
      const fin = [semi[0] > semi[1] ? 0 : 1, semi[2] > semi[3] ? 2 : 3];
      const finS = [avg(judge(r)), avg(judge(r))];
      if (finS[0] === finS[1]) finS[0] += 0.3;
      const champ = finS[0] > finS[1] ? fin[0] : fin[1];
      const gap = REDUCED ? 0 : 620;
      draw({});
      timers.push(setTimeout(() => draw({ semi, fin }), gap));
      timers.push(setTimeout(() => draw({ semi, fin, finS }), gap * 2));
      timers.push(setTimeout(() => draw({ semi, fin, finS, champ }), gap * 3));
    };
    btn.addEventListener('click', play);
    const r0 = rng(99);
    const semi0 = names.map(() => avg(judge(r0)));
    if (semi0[0] === semi0[1]) semi0[0] += 0.3;
    if (semi0[2] === semi0[3]) semi0[2] += 0.3;
    const fin0 = [semi0[0] > semi0[1] ? 0 : 1, semi0[2] > semi0[3] ? 2 : 3];
    const finS0 = [avg(judge(r0)), avg(judge(r0))];
    if (finS0[0] === finS0[1]) finS0[0] += 0.3;
    draw({ semi: semi0, fin: fin0, finS: finS0, champ: finS0[0] > finS0[1] ? fin0[0] : fin0[1] });
    new IntersectionObserver((es, io) => {
      if (es[0].isIntersecting) { io.disconnect(); play(); }
    }, { threshold: 0.5 }).observe(wrap);
  }

  /* ---------- До и после ---------- */
  {
    const ba = $('#ba');
    if (ba) {
      const range = $('input', ba);
      const set = (v) => ba.style.setProperty('--pos', `${v}%`);
      range.addEventListener('input', () => { ba.dataset.touched = '1'; set(range.value); });
      set(range.value);
      new IntersectionObserver((es, io) => {
        if (!es[0].isIntersecting || REDUCED) return;
        io.disconnect();
        const t0 = performance.now();
        const sweep = (now) => {
          if (ba.dataset.touched) return;
          const p = (now - t0) / 2600;
          if (p >= 1) { range.value = 50; set(50); return; }
          const v = 50 + Math.sin(p * Math.PI * 2) * 34;
          range.value = v;
          set(v);
          requestAnimationFrame(sweep);
        };
        requestAnimationFrame(sweep);
      }, { threshold: 0.5 }).observe(ba);
    }
  }

  /* ---------- Живой пример кнопки магазина ---------- */
  {
    const btn = $('.lv-btn');
    if (btn) {
      const label = $('span', btn);
      btn.addEventListener('click', () => {
        btn.classList.add('done');
        label.textContent = '✓ Добавлено';
        setTimeout(() => {
          btn.classList.remove('done');
          label.textContent = 'В корзину';
        }, 1400);
      });
    }
  }

  /* ---------- Метод: подсветка шага по мере чтения ---------- */
  {
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => { if (e.isIntersecting) e.target.classList.add('lit'); });
    }, { threshold: 0.7, rootMargin: '0px 0px -12% 0px' });
    $$('.step').forEach((el) => io.observe(el));
  }

  /* ---------- Копирование контактов ---------- */
  $$('[data-copy]').forEach((b) => {
    const label = b.textContent;
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        b.textContent = 'Скопировано';
      } catch (e) {
        const range = document.createRange();
        range.selectNodeContents(b.previousElementSibling);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        b.textContent = 'Выделено';
      }
      setTimeout(() => { b.textContent = label; }, 1600);
    });
  });

  const animationIO = new IntersectionObserver(entries => {
    entries.forEach(e => e.target.classList.toggle('animation-away', !e.isIntersecting));
  });
  document.querySelectorAll('.spec .open i, .demo').forEach(el => animationIO.observe(el));

  /* ---------- Главный цикл ---------- */
  let last = performance.now(), smooth = scrollY, vel = 0, prevScroll = scrollY;
  let frames = 0, spent = 0, checks = 0, spinKick = 0;
  let forced = 3;
  let raf = 0, wakeUntil = 0;
  const sayEl = $('#say');
  function wake() {
    wakeUntil = performance.now() + 1800;
    if (!raf && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(loop); }
  }
  themeListeners.push(() => { forced = 3; wake(); });
  const loop = (now) => {
    raf = 0;
    if (document.hidden) { last = now; return; }
    const scroll = scrollY;
    const covered = panels.some(([a, b]) => a <= scroll && b >= scroll + innerHeight);
    const active = now < wakeUntil || Math.abs(scroll - smooth) > .15 || Math.abs(vel) > 1 || Math.abs(Bot.st.spin) > .005 || Math.abs(Bot.st.hopV) > 1 || sayEl.classList.contains('on');
    // Full interaction rate; quieter scenes render at 30 fps rather than at monitor refresh rate.
    if (now - last < (active ? 15 : 32)) { raf = requestAnimationFrame(loop); return; }
    root.dataset.renderActive = 'true';
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const k = 1 - Math.exp(-dt * 7);
    smooth = lerp(smooth, scroll, REDUCED ? 1 : k);
    const instant = dt > 0 ? (scroll - prevScroll) / dt : 0;
    prevScroll = scroll;
    vel = lerp(vel, instant, 1 - Math.exp(-dt * 10));
    input.sx = lerp(input.sx, input.x, 0.06);
    input.sy = lerp(input.sy, input.y, 0.06);

    Bot.frame(dt, scroll, vel);
    if (Face) Face.frame(scroll);

    if (Field) {
      // Панель с текстом закрывает экран целиком: рисовать сцену незачем
      const vh = innerHeight;
      const covered = panels.some(([a, b]) => a <= scroll && b >= scroll + vh);
      if (!covered || forced > 0) {
        forced = Math.max(0, forced - 1);
        const [s, t] = stateAt(smooth);
        spinKick = lerp(spinKick, clamp(vel / 2600, -0.5, 0.5), 0.05);
        const time = REDUCED ? 0 : now / 1000;
        Field.render(time, s, t, spinKick);
        if (!REDUCED && active && checks < 2) {
          frames++;
          spent += dt;
          if (frames >= 90) {
            if (spent / frames > 1 / 38) { Field.degrade(); checks++; }
            else checks = 2;
            frames = 0;
            spent = 0;
          }
        }
      }
    }
    if ((!covered && !REDUCED) || active || (Field && forced > 0)) raf = requestAnimationFrame(loop);
    else root.dataset.renderActive = 'false';
  };

  // Stop completely on settled text panels and in hidden tabs; resume on real input.
  ['scroll','pointermove','pointerdown','pointerup','deviceorientation','resize','keydown'].forEach(type => addEventListener(type, wake, { passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; root.dataset.renderActive = 'false'; }
    else { forced = 3; wake(); }
  });
  applyTheme(root.dataset.theme || 'dark');
  measure();
  addEventListener('resize', () => { if (Field) Field.resize(); measure(); forced = 3; }, { passive: true });
  addEventListener('load', measure);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  if ('ResizeObserver' in window) new ResizeObserver(() => measure()).observe(document.body);
  setTimeout(() => Bot.say('Листайте ↓'), 2200);
  wake();

  // Служебная точка для автоматической проверки сайта
  window.__site = { Field, stateAt, stops };
})();
