// The "now playing" deck: a sleeve, a translucent record that slides out of it,
// and a minimal tonearm on a glass plate. Moving parts are separate layers
// driven by CSS transforms so the browser composites them instead of
// repainting the (filter-heavy) record every frame.

import { luminance } from './color.js';

const RAD = Math.PI / 180;

// Geometry in units of the record diameter, record centre at the origin.
export const G = {
  R: 0.5,
  labelR: 0.232,
  grooveOut: 0.472, // a side starts here…
  grooveIn: 0.258, // …and ends here
  pivot: { x: 0.476, y: -0.383 },
  stylus: { x: -0.026, y: 0.74 }, // relative to the pivot with the arm hanging straight down
  rest: 0,
};

// A true 33⅓ RPM looks frantic on screen; spin the record at a calmer
// fraction of real speed.
const SPIN_SCALE = 0.4;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function stylusAt(theta) {
  const a = theta * RAD;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return {
    x: G.pivot.x + G.stylus.x * c - G.stylus.y * s,
    y: G.pivot.y + G.stylus.x * s + G.stylus.y * c,
  };
}

export function radiusAt(theta) {
  const p = stylusAt(theta);
  return Math.hypot(p.x, p.y);
}

// radiusAt() falls monotonically over [0°, 48°], so bisect.
function angleAtRadius(r) {
  let lo = 0;
  let hi = 48;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (radiusAt(mid) > r) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const STEPS = 200;
const TABLE = Array.from({ length: STEPS + 1 }, (_, i) => angleAtRadius(G.grooveOut - (i / STEPS) * (G.grooveOut - G.grooveIn)));

export function angleForProgress(p) {
  const x = clamp(p || 0, 0, 1) * STEPS;
  const i = Math.floor(x);
  if (i >= STEPS) return TABLE[STEPS];
  const f = x - i;
  return TABLE[i] * (1 - f) + TABLE[i + 1] * f;
}

// null when the stylus is off the record.
export function progressForAngle(theta) {
  const r = radiusAt(theta);
  if (r > G.R - 0.004) return null;
  return clamp((G.grooveOut - r) / (G.grooveOut - G.grooveIn), 0, 1);
}

const MAX_ANGLE = angleForProgress(1) + 1.5;

/* ------------------------------------------------------------------ markup */

// Arm layers share a box around the pivot, in thousandths of the diameter.
const ARM_BOX = { x: -150, y: -150, w: 300, h: 970 };
const ARM_VB = `viewBox="${ARM_BOX.x} ${ARM_BOX.y} ${ARM_BOX.w} ${ARM_BOX.h}"`;

function armShapes(shadow) {
  const dark = shadow ? '' : 'fill="#1b1b1d"';
  const tube = shadow ? '' : 'fill="url(#dk-tube)"';
  return `
    <rect x="-8" y="0" width="16" height="615" rx="8" ${tube}/>
    <rect x="-13" y="598" width="26" height="36" rx="5" ${dark}/>
    <path d="M-15 628 L15 628 L21 690 L-4 750 L-46 746 L-34 690 Z" ${dark}/>
    <path d="M18 662 L44 650 L47 658 L21 675 Z" ${shadow ? '' : 'fill="#2c2c2f"'}/>
    <rect x="-66" y="-58" width="132" height="112" rx="16" ${dark}/>
    ${
      shadow
        ? ''
        : `<rect x="-56" y="-48" width="58" height="34" rx="8" fill="#2f2f33"/>
           <rect x="-66" y="-58" width="132" height="112" rx="16" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="2"/>
           <rect x="-30" y="736" width="12" height="12" rx="2" fill="#0b0b0c"/>`
    }`;
}

function armMarkup() {
  return `
<div class="arm-plate"></div>
<svg class="arm-shadow" ${ARM_VB} aria-hidden="true">
  <defs><filter id="dk-armBlur" x="-50%" y="-10%" width="200%" height="120%"><feGaussianBlur stdDeviation="9"/></filter></defs>
  <g fill="#000" filter="url(#dk-armBlur)">${armShapes(true)}</g>
</svg>
<svg class="arm" ${ARM_VB}>
  <defs>
    <linearGradient id="dk-tube" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#7b7f84"/><stop offset=".35" stop-color="#f4f5f7"/>
      <stop offset=".6" stop-color="#b9bdc2"/><stop offset="1" stop-color="#6a6e73"/>
    </linearGradient>
  </defs>
  ${armShapes(false)}
  <rect class="arm-hit" x="-70" y="-70" width="140" height="840" rx="50" fill="transparent"/>
</svg>`;
}

const SHEEN = (() => {
  const wedge = (a0, a1, r = 560) => {
    const p = (a) => `${(r * Math.cos(a * RAD)).toFixed(1)} ${(r * Math.sin(a * RAD)).toFixed(1)}`;
    return `M0 0 L${p(a0)} A${r} ${r} 0 0 1 ${p(a1)} Z`;
  };
  return `
  <defs>
    <mask id="dk-sheenMask">
      <circle r="496" fill="#fff"/><circle r="${G.labelR * 1000 + 4}" fill="#000"/>
    </mask>
    <filter id="dk-sheenBlur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="22"/></filter>
  </defs>
  <g mask="url(#dk-sheenMask)"><g filter="url(#dk-sheenBlur)" fill="#fff">
    <path d="${wedge(-58, -30)}" opacity=".28"/>
    <path d="${wedge(122, 150)}" opacity=".18"/>
    <path d="${wedge(-8, 4)}" opacity=".08"/>
  </g></g>`;
})();

let measureCtx;
function measure(text, weight, size) {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  measureCtx.font = `${weight} ${size}px Inter, system-ui, sans-serif`;
  return measureCtx.measureText(text).width;
}

function wrap(text, weight, size, maxW) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && measure(next, weight, size) > maxW) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

// Largest size at which `text` fits in maxLines lines of maxW.
function fit(text, { weight, size, min, maxW, maxLines }) {
  for (let s = size; s >= min; s -= 2) {
    const lines = wrap(text, weight, s, maxW);
    if (lines.length <= maxLines && lines.every((l) => measure(l, weight, s) <= maxW)) return { size: s, lines };
  }
  const lines = wrap(text, weight, min, maxW).slice(0, maxLines);
  const last = lines.length - 1;
  let cut = lines[last];
  while (cut.length > 1 && measure(`${cut}…`, weight, min) > maxW) cut = cut.slice(0, -1);
  if (cut !== lines[last] || wrap(text, weight, min, maxW).length > maxLines) lines[last] = `${cut.trimEnd()}…`;
  return { size: min, lines };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function hash(str = '') {
  let h = 2166136261;
  for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function textLines({ lines, size }, weight, cy, extra = '') {
  const lh = size * 1.08;
  const top = cy - ((lines.length - 1) * lh) / 2;
  return lines
    .map((l, i) => `<text x="0" y="${(top + i * lh).toFixed(1)}" font-size="${size}" font-weight="${weight}" ${extra}>${esc(l)}</text>`)
    .join('');
}

function barcode(seed) {
  let x = -34;
  let s = seed % 2147483646 || 1;
  let bars = '';
  while (x < 34) {
    s = (s * 16807) % 2147483647;
    const w = 1 + (s % 3);
    bars += `<rect x="${x}" y="0" width="${w}" height="20"/>`;
    x += w + 1 + ((s >> 3) % 3);
  }
  return bars;
}

function recordMarkup(track, opts) {
  const seed = hash(track?.id || 'blank');
  const label = track?.label || '#ecebe8';
  const vibrant = track?.vibrant || label;
  const light = luminance(label) > 0.42;
  const ink = light ? '#141414' : '#ffffff';
  let style = opts.vinyl || 'cover';
  if (style === 'cover' && !track?.coverUrl) style = track ? 'color' : 'clear';
  const layout = opts.label === 'h' || opts.label === 'v' ? opts.label : seed % 2 ? 'v' : 'h';
  const rpm = opts.rpm === 45 ? '45 RPM' : '33⅓ RPM';

  const material = {
    cover: { base: label, baseO: 0.5, art: 0.78, tint: 0.22, smoke: null },
    clear: { base: '#efefef', baseO: 0.42, art: 0, tint: 0, smoke: ['#1c1c1c', 0.55] },
    color: { base: vibrant, baseO: 0.78, art: 0, tint: 0, smoke: ['#ffffff', 0.28] },
    black: { base: '#0d0d0e', baseO: 1, art: 0, tint: 0, smoke: null },
  }[style];

  const grooves = (() => {
    let s = seed % 2147483646 || 1;
    let out = '';
    const col = style === 'black' ? '#fff' : light && style !== 'color' ? '#000' : '#fff';
    for (let r = G.labelR * 1000 + 10; r < 492; r += 3.1) {
      s = (s * 16807) % 2147483647;
      out += `<circle r="${r.toFixed(1)}" stroke="${col}" stroke-opacity="${(0.015 + (s % 100) / 2600).toFixed(3)}"/>`;
    }
    for (const r of [312, 368, 421]) out += `<circle r="${r}" stroke="#000" stroke-opacity=".12" stroke-width="3"/>`;
    return `<g fill="none" stroke-width="1">${out}</g>`;
  })();

  const smokeColor = material.smoke ? material.smoke[0] : '#000000';
  const [sr, sg, sb] = [1, 3, 5].map((i) => (parseInt(smokeColor.slice(i, i + 2), 16) / 255).toFixed(3));

  const title = track?.title || 'Muszi';
  const artist = track?.artist || (track ? 'Unknown artist' : 'Put a record on');
  let main;
  if (layout === 'v') {
    const t = fit(title, { weight: 800, size: 46, min: 26, maxW: 330, maxLines: 2 });
    const a = fit(artist, { weight: 500, size: 30, min: 20, maxW: 300, maxLines: 1 });
    main = `<g transform="rotate(-90)" text-anchor="middle" dominant-baseline="central">
      ${textLines(t, 800, t.lines.length > 1 ? -80 : -64)}
      ${textLines(a, 500, 86, 'opacity=".85"')}
      <g transform="translate(0 166)">${barcode(seed)}</g>
    </g>`;
  } else {
    const t = fit(title, { weight: 800, size: 44, min: 26, maxW: 340, maxLines: 2 });
    const a = fit(artist, { weight: 600, size: 28, min: 20, maxW: 300, maxLines: 1 });
    main = `<g text-anchor="middle" dominant-baseline="central">
      ${textLines(t, 800, -74)}
      ${textLines(a, 600, 70, 'opacity=".85"')}
      <text y="138" font-size="10" font-weight="600" letter-spacing="2" opacity=".7">• MUSZI VINYL •</text>
      <g transform="translate(0 150)">${barcode(seed)}</g>
    </g>`;
  }

  const arcs = [
    [-128, `© Muszi Studio ${new Date().getFullYear()}`],
    [-40, 'Pressed in your browser'],
    [52, `Side A · ${rpm} · Stereo`],
    [140, 'Made for slow evenings'],
  ]
    .map(
      ([rot, s]) =>
        `<g transform="rotate(${rot})"><text font-size="12.5" font-weight="500" letter-spacing=".4"><textPath href="#dk-arc" startOffset="50%" text-anchor="middle">${esc(s)}</textPath></text></g>`,
    )
    .join('');

  return `
  <defs>
    <clipPath id="dk-clip"><circle r="500"/></clipPath>
    <path id="dk-arc" d="M -201 0 A 201 201 0 0 1 201 0"/>
    <filter id="dk-marble" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.0042" numOctaves="3" seed="${seed % 97}" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="720" xChannelSelector="R" yChannelSelector="G" result="d"/>
      <feGaussianBlur in="d" stdDeviation="7"/>
    </filter>
    <filter id="dk-smoke" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">
      <feTurbulence type="turbulence" baseFrequency="0.0024 0.0042" numOctaves="4" seed="${seed % 89}" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 ${sr}  0 0 0 0 ${sg}  0 0 0 0 ${sb}  -8 0 0 0 1.1" result="veins"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 ${sr}  0 0 0 0 ${sg}  0 0 0 0 ${sb}  -2.2 0 0 0 0.55" result="haze"/>
      <feGaussianBlur in="haze" stdDeviation="14" result="hazeSoft"/>
      <feMerge><feMergeNode in="hazeSoft"/><feMergeNode in="veins"/></feMerge>
    </filter>
    <radialGradient id="dk-rim" r="500" cx="0" cy="0" gradientUnits="userSpaceOnUse">
      <stop offset=".9" stop-color="#fff" stop-opacity="0"/>
      <stop offset=".975" stop-color="#fff" stop-opacity="${style === 'black' ? 0.05 : 0.22}"/>
      <stop offset="1" stop-color="#fff" stop-opacity="${style === 'black' ? 0.12 : 0.35}"/>
    </radialGradient>
    <radialGradient id="dk-spindle" cx=".35" cy=".3" r=".8">
      <stop offset="0" stop-color="#fdfdfd"/><stop offset=".55" stop-color="#b3b7bc"/><stop offset="1" stop-color="#5d6166"/>
    </radialGradient>
  </defs>
  <g clip-path="url(#dk-clip)">
    <circle r="500" fill="${material.base}" fill-opacity="${material.baseO}"/>
    ${
      material.art && track?.coverUrl
        ? `<image href="${esc(track.coverUrl)}" x="-620" y="-620" width="1240" height="1240" preserveAspectRatio="xMidYMid slice" filter="url(#dk-marble)" opacity="${material.art}"/>`
        : ''
    }
    ${material.tint ? `<circle r="500" fill="${label}" fill-opacity="${material.tint}"/>` : ''}
    ${material.smoke ? `<rect x="-500" y="-500" width="1000" height="1000" filter="url(#dk-smoke)" opacity="${material.smoke[1]}"/>` : ''}
    ${grooves}
    <circle r="500" fill="url(#dk-rim)"/>
  </g>
  <g class="lbl" fill="${ink}">
    <circle r="${G.labelR * 1000}" fill="${label}"/>
    ${light ? `<circle r="${G.labelR * 1000 - 5}" fill="none" stroke="#121212" stroke-width="9"/>` : ''}
    <circle r="44" fill="${ink}" opacity=".06"/>
    ${arcs}
    ${main}
    <circle r="15" fill="url(#dk-spindle)"/>
    <circle r="15" fill="none" stroke="#000" stroke-opacity=".25"/>
  </g>`;
}

function sleeveMarkup(track) {
  if (track?.coverUrl) return `<img class="sleeve-img" src="${esc(track.coverUrl)}" alt="" draggable="false" />`;
  const title = track ? track.album || track.title : 'Muszi';
  const sub = track ? track.artist || '' : 'Drop your music in';
  return `<div class="sleeve-gen" style="--c:${track?.label || '#6d6a66'}">
    <span class="sleeve-gen-title">${esc(title)}</span>
    <span class="sleeve-gen-sub">${esc(sub)}</span>
  </div>`;
}

/* ------------------------------------------------------------------ class */

export class Deck {
  constructor(root, callbacks = {}) {
    this.root = root;
    this.cb = callbacks;
    root.innerHTML = `
      <div class="record-slot">
        <div class="rec-shadow"></div>
        <svg class="rec-spin" viewBox="-500 -500 1000 1000" role="img" aria-label="Record"></svg>
        <svg class="rec-sheen" viewBox="-500 -500 1000 1000" aria-hidden="true">${SHEEN}</svg>
      </div>
      <div class="sleeve-slot"><div class="sleeve"></div></div>
      ${armMarkup()}`;

    const q = (s) => root.querySelector(s);
    this.recordSlot = q('.record-slot');
    this.spinEl = q('.rec-spin');
    this.sleeveSlot = q('.sleeve-slot');
    this.sleeve = q('.sleeve');
    this.plate = q('.arm-plate');
    this.arm = q('.arm');
    this.armShadow = q('.arm-shadow');

    this.progress = () => 0;
    this.onFrame = null;
    this.opts = { vinyl: 'cover', label: 'auto', rpm: 33 };
    this.track = null;

    this.rot = 0;
    this.rpm = 33;
    this.rpmNow = 0;
    this.spinning = false;

    this.armAngle = G.rest;
    this.armTarget = G.rest;
    this.armMode = 'hold'; // hold | move | follow | drag
    this.lift = 0;
    this.liftTarget = 0;
    this.pending = { arrive: null, lower: null };

    this.#bind();
    this.layout();
    this.setTrack(null);
    new ResizeObserver(() => this.layout()).observe(root);

    this.last = performance.now();
    requestAnimationFrame(this.#tick);
  }

  /* --- layout --- */

  layout() {
    const vw = this.root.clientWidth || innerWidth;
    const vh = this.root.clientHeight || innerHeight;
    const dock = 116;
    let D;
    let rx;
    let ry;
    let S;
    let sx;
    let sy;
    if (vw / vh >= 1.05) {
      D = Math.min((vh - dock - 36) * 0.98, vw * 0.52);
      rx = Math.min(vw * 0.66, vw - 0.62 * D - 12);
      ry = (vh - dock) / 2 + 18;
      S = 0.9 * D;
      sx = rx - 0.84 * D;
      sy = ry - 0.02 * D;
    } else {
      // Sleeve above, record below; centre the pair between the top buttons
      // and the dock.
      const top = 70;
      const bottom = vh - dock - 70;
      D = Math.min(vw * 0.84, (bottom - top) / 1.55);
      S = 0.82 * D;
      rx = vw * 0.43;
      ry = top + (bottom - top - 1.53 * D) / 2 + 1.03 * D;
      sx = rx - 0.28 * D;
      sy = ry - 0.62 * D;
    }
    this.D = D;
    const px = (v) => `${v.toFixed(1)}px`;
    const set = (el, x, y, w, h) => Object.assign(el.style, { left: px(x), top: px(y), width: px(w), height: px(h) });

    set(this.recordSlot, rx - D / 2, ry - D / 2, D, D);
    set(this.sleeveSlot, sx - S / 2, sy - S / 2, S, S);

    const pX = rx + G.pivot.x * D;
    const pY = ry + G.pivot.y * D;
    const u = D / 1000;
    for (const el of [this.arm, this.armShadow]) {
      set(el, pX + ARM_BOX.x * u, pY + ARM_BOX.y * u, ARM_BOX.w * u, ARM_BOX.h * u);
      el.style.transformOrigin = `${px(-ARM_BOX.x * u)} ${px(-ARM_BOX.y * u)}`;
    }
    set(this.plate, pX - 0.107 * D, pY - 0.09 * D, 0.228 * D, 0.3 * D);
    this.plate.style.borderRadius = px(0.05 * D);

    // Where the record goes when it slides back into the sleeve, and how far
    // the pair slides off-screen during a swap.
    this.root.style.setProperty('--shx', px(sx - rx));
    this.root.style.setProperty('--shy', px(sy - ry));
    this.root.style.setProperty('--away', px(-(sx + S * 0.75 + 40)));
  }

  /* --- content --- */

  setOptions(opts) {
    Object.assign(this.opts, opts);
    this.setRpm(this.opts.rpm);
    this.#paintRecord();
  }

  setTrack(track) {
    this.track = track;
    this.sleeve.innerHTML = sleeveMarkup(track);
    this.#paintRecord();
  }

  #paintRecord() {
    this.spinEl.innerHTML = recordMarkup(this.track, this.opts);
  }

  /* --- motion API --- */

  setSpinning(on) {
    this.spinning = on;
  }

  setRpm(rpm) {
    this.rpm = rpm === 45 ? 45 : 33;
  }

  angleFor(p) {
    return angleForProgress(p);
  }

  armOnRecord() {
    return progressForAngle(this.armAngle) !== null;
  }

  atRest() {
    return Math.abs(this.armAngle - G.rest) < 0.1 && this.liftTarget === 0 && this.armMode !== 'drag';
  }

  isLifted() {
    return this.liftTarget > 0.5;
  }

  // Lift, swing to `angle` and hover there. Resolves true on arrival, false
  // if something else took the arm first.
  moveArm(angle) {
    this.#settle('arrive', false);
    this.#settle('lower', false);
    this.liftTarget = 1;
    this.armTarget = angle;
    this.armMode = 'move';
    if (document.hidden) {
      this.armAngle = angle;
      this.lift = 1;
      this.armMode = 'hold';
      return Promise.resolve(true);
    }
    return new Promise((res) => (this.pending.arrive = res));
  }

  lower() {
    this.#settle('lower', false);
    this.liftTarget = 0;
    if (document.hidden) {
      this.lift = 0;
      return Promise.resolve(true);
    }
    return new Promise((res) => (this.pending.lower = res));
  }

  lift() {
    this.#settle('lower', false);
    this.liftTarget = 1;
  }

  async toRest() {
    if (this.atRest()) return true;
    if (!(await this.moveArm(G.rest))) return false;
    return this.lower();
  }

  follow() {
    this.#settle('arrive', false);
    this.armMode = 'follow';
  }

  // Record slides back into its sleeve, then both slide away to the left.
  async swapOut() {
    this.root.classList.add('is-sheathed');
    if (!document.hidden) await wait(460);
    this.root.classList.add('is-away');
    if (!document.hidden) await wait(360);
  }

  async swapIn() {
    this.root.classList.remove('is-away');
    if (!document.hidden) await wait(420);
    this.root.classList.remove('is-sheathed');
    if (!document.hidden) await wait(520);
  }

  /* --- internals --- */

  #settle(kind, value) {
    const r = this.pending[kind];
    this.pending[kind] = null;
    r?.(value);
  }

  // Pointer position in record units (record centre = 0,0; diameter = 1).
  #point(e) {
    const r = this.recordSlot.getBoundingClientRect();
    const size = r.width || 1;
    return { x: (e.clientX - r.left) / size - 0.5, y: (e.clientY - r.top) / size - 0.5 };
  }

  #bind() {
    const hit = this.root.querySelector('.arm-hit');

    hit.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      hit.setPointerCapture(e.pointerId);
      this.#settle('arrive', false);
      this.#settle('lower', false);
      this.armMode = 'drag';
      this.liftTarget = 1;
      document.body.classList.add('arm-dragging');
      this.cb.onLift?.();
    });

    hit.addEventListener('pointermove', (e) => {
      if (this.armMode !== 'drag') return;
      const p = this.#point(e);
      const vx = p.x - G.pivot.x;
      const vy = p.y - G.pivot.y;
      // Angle that points the stylus (not the tube) at the pointer.
      const theta = (Math.atan2(-vx, vy) - Math.atan2(-G.stylus.x, G.stylus.y)) / RAD;
      this.armAngle = clamp(theta, G.rest, MAX_ANGLE);
    });

    const release = () => {
      if (this.armMode !== 'drag') return;
      this.armMode = 'hold';
      document.body.classList.remove('arm-dragging');
      this.cb.onDrop?.(progressForAngle(this.armAngle));
    };
    hit.addEventListener('pointerup', release);
    hit.addEventListener('pointercancel', release);

    // Tap the record to play/pause, tap the sleeve to open its album.
    const tap = (el, fn) => {
      let start = null;
      el.addEventListener('pointerdown', (e) => (start = { x: e.clientX, y: e.clientY, t: performance.now() }));
      el.addEventListener('pointerup', (e) => {
        if (!start) return;
        const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
        if (moved < 6 && performance.now() - start.t < 500) fn();
        start = null;
      });
    };
    tap(this.spinEl, () => this.cb.onRecordTap?.());
    tap(this.sleeveSlot, () => this.cb.onSleeveTap?.());

    // rAF stops in background tabs; finish in-flight motion so awaiting code
    // (e.g. auto-advancing to the next track) doesn't stall.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      if (this.armMode === 'move') {
        this.armAngle = this.armTarget;
        this.armMode = 'hold';
      }
      this.lift = this.liftTarget;
      this.#settle('arrive', true);
      if (this.liftTarget === 0) this.#settle('lower', true);
    });
  }

  #tick = (now) => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;

    const target = this.spinning ? this.rpm : 0;
    const k = this.spinning ? 3.2 : 1.3;
    this.rpmNow += (target - this.rpmNow) * (1 - Math.exp(-dt * k));
    if (!this.spinning && this.rpmNow < 0.05) this.rpmNow = 0;
    this.rot = (this.rot + this.rpmNow * 6 * SPIN_SCALE * dt) % 360;

    if (this.armMode === 'follow') {
      const t = angleForProgress(this.progress());
      this.armAngle += (t - this.armAngle) * (1 - Math.exp(-dt * 10));
    } else if (this.armMode === 'move') {
      const d = this.armTarget - this.armAngle;
      if (this.lift > 0.6 || Math.abs(d) < 0.2) {
        const mag = Math.min(Math.abs(d), Math.max(Math.abs(d) * (1 - Math.exp(-dt * 4.5)), 6 * dt));
        this.armAngle += Math.sign(d) * mag;
        if (Math.abs(this.armTarget - this.armAngle) < 0.05) {
          this.armAngle = this.armTarget;
          this.armMode = 'hold';
          this.#settle('arrive', true);
        }
      }
    }

    const lk = this.liftTarget > this.lift ? 14 : 6;
    this.lift += (this.liftTarget - this.lift) * (1 - Math.exp(-dt * lk));
    if (this.liftTarget === 0 && this.lift < 0.03) {
      this.lift = 0;
      this.#settle('lower', true);
    }

    this.spinEl.style.transform = `rotate(${this.rot.toFixed(2)}deg)`;
    const a = this.armAngle.toFixed(3);
    this.arm.style.transform = `rotate(${a}deg)`;
    const o = (0.006 + this.lift * 0.016) * this.D;
    this.armShadow.style.transform = `translate(${o.toFixed(1)}px, ${(o * 1.5).toFixed(1)}px) rotate(${a}deg)`;
    this.armShadow.style.opacity = (0.42 - this.lift * 0.14).toFixed(3);

    this.onFrame?.(dt);
    requestAnimationFrame(this.#tick);
  };
}
