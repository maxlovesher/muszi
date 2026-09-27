// A crate of record sleeves seen from the front: every sleeve stands on its
// edge facing the centre of the view, so you see the covers fanned out on both
// sides and the spines nearest you. Scroll, drag or use the arrow keys to dig.

import { luminance } from './color.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// The view rests in the gap between two sleeves, so none is seen edge-on.
const snap = (v) => Math.round(v - 0.5) + 0.5;

export class Crate3D {
  constructor(root, { onOpen } = {}) {
    this.root = root;
    this.onOpen = onOpen;
    root.innerHTML = '<div class="c3-stage"></div>';
    this.stage = root.firstElementChild;
    this.items = [];
    this.els = [];
    this.offset = 0;
    this.target = 0;
    this.active = false;
    this.dirty = true;
    this.#bind();
    new ResizeObserver(() => this.#measure()).observe(root);
    this.#measure();
  }

  setItems(items, { keepPosition = false } = {}) {
    const prevKey = this.items[Math.round(snap(this.target) + 0.5)]?.key;
    this.items = items;
    this.els = items.map((it) => this.#make(it));
    this.stage.replaceChildren(...this.els);
    let start = snap(items.length / 2 - 0.5);
    if (keepPosition && prevKey) {
      const i = items.findIndex((it) => it.key === prevKey);
      if (i >= 0) start = i - 0.5;
    }
    this.offset = this.target = this.#clampT(start);
    this.dirty = true;
    this.#render();
  }

  // Spine/face colour can arrive later (e.g. once remote cover art is analysed).
  setColor(key, color) {
    const i = this.items.findIndex((it) => it.key === key);
    const el = this.els[i];
    if (!el) return;
    this.items[i].color = color;
    el.querySelector('.c3-face').style.setProperty('--c', color);
    const spine = el.querySelector('.c3-spine');
    spine.style.setProperty('--c', color);
    spine.style.setProperty('--ink', luminance(color) > 0.45 ? '#111' : '#fff');
  }

  show() {
    if (this.active) return;
    this.active = true;
    this.last = performance.now();
    requestAnimationFrame(this.#tick);
  }

  hide() {
    this.active = false;
  }

  step(dir) {
    this.target = this.#clampT(snap(this.target) + dir);
  }

  // The sleeve just right of centre is the one "in hand".
  openCurrent() {
    const it = this.items[Math.round(snap(this.target) + 0.5)];
    if (it) this.onOpen?.(it);
  }

  #clampT(v) {
    return clamp(v, -0.5, Math.max(-0.5, this.items.length - 0.5));
  }

  #measure() {
    const w = this.root.clientWidth || innerWidth;
    const h = this.root.clientHeight || innerHeight;
    this.size = Math.min(h * 0.72, w * 1.05, 760);
    this.spacing = this.size * 0.16;
    this.root.style.setProperty('--S', `${this.size.toFixed(1)}px`);
    this.stage.style.perspective = `${(this.size * 5).toFixed(0)}px`;
    this.dirty = true;
    this.#render();
  }

  #make(it) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'c3';
    el.setAttribute('aria-label', `${it.title}${it.sub ? `, ${it.sub}` : ''}`);

    const inner = document.createElement('span');
    inner.className = 'c3-in';

    const face = document.createElement('span');
    face.className = 'c3-face';
    face.style.setProperty('--c', it.color);
    if (it.mosaic?.length >= 4) {
      face.classList.add('is-mosaic');
      for (const src of it.mosaic.slice(0, 4)) face.append(img(src));
    } else if (it.cover) {
      face.append(img(it.cover));
    } else {
      const gen = document.createElement('span');
      gen.className = 'c3-gen';
      gen.textContent = it.title;
      face.append(gen);
    }

    const spine = document.createElement('span');
    spine.className = 'c3-spine';
    spine.style.setProperty('--c', it.color);
    spine.style.setProperty('--ink', luminance(it.color) > 0.45 ? '#111' : '#fff');
    const text = document.createElement('span');
    text.className = 'c3-spine-text';
    const b = document.createElement('b');
    b.textContent = it.title;
    text.append(b, ` ${it.sub || ''}`);
    spine.append(text);

    inner.append(face, spine);
    el.append(inner);
    return el;
  }

  #bind() {
    let drag = null;
    let suppressClick = false;
    let snapTimer;

    const snapSoon = () => {
      clearTimeout(snapTimer);
      snapTimer = setTimeout(() => (this.target = this.#clampT(snap(this.target))), 140);
    };

    this.root.addEventListener(
      'wheel',
      (e) => {
        if (!this.items.length) return;
        e.preventDefault();
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        const unit = e.deltaMode === 1 ? 1 / 3 : 1 / 110;
        this.target = clamp(this.target + delta * unit, -0.9, this.items.length - 0.1);
        snapSoon();
      },
      { passive: false },
    );

    this.root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.items.length) return;
      drag = { x: e.clientX, off: this.target, t: performance.now(), v: 0, lastX: e.clientX, lastT: performance.now(), moved: false };
    });
    window.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 6) drag.moved = true;
      if (!drag.moved) return;
      const now = performance.now();
      drag.v = (e.clientX - drag.lastX) / Math.max(1, now - drag.lastT);
      drag.lastX = e.clientX;
      drag.lastT = now;
      this.target = this.offset = clamp(drag.off - dx / this.spacing, -1, this.items.length);
      this.dirty = true;
    });
    window.addEventListener('pointerup', () => {
      if (!drag) return;
      if (drag.moved) {
        suppressClick = true;
        setTimeout(() => (suppressClick = false), 0);
        const fling = (-drag.v * 220) / this.spacing;
        this.target = this.#clampT(snap(this.target + fling));
      }
      drag = null;
    });

    this.stage.addEventListener('click', (e) => {
      if (suppressClick) return;
      const el = e.target.closest('.c3');
      if (!el) return;
      const i = this.els.indexOf(el);
      if (i >= 0) this.onOpen?.(this.items[i]);
    });
  }

  #tick = (now) => {
    if (!this.active) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const d = this.target - this.offset;
    if (Math.abs(d) > 0.0005) {
      this.offset += d * (1 - Math.exp(-dt * 11));
      this.dirty = true;
    }
    this.#render();
    requestAnimationFrame(this.#tick);
  };

  #render() {
    if (!this.dirty) return;
    this.dirty = false;
    const { spacing } = this;
    this.els.forEach((el, i) => {
      const d = i - this.offset;
      const ad = Math.abs(d);
      if (ad > 12) {
        el.style.visibility = 'hidden';
        return;
      }
      el.style.visibility = '';
      // Edge-on at the centre, opening up quickly, then fanning out slowly.
      const a = 90 - 9 * Math.min(ad, 1) - 1.1 * Math.max(ad - 1, 0);
      const left = d < 0;
      el.classList.toggle('is-left', left);
      el.style.transform = `translate3d(${(d * spacing).toFixed(1)}px, 0, 0) rotateY(${left ? a : -a}deg)`;
      el.style.zIndex = String(100 - Math.round(ad * 2));
    });
  }
}

function img(src) {
  const i = new Image();
  i.src = src;
  i.alt = '';
  i.decoding = 'async';
  i.draggable = false;
  return i;
}
