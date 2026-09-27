// Routes the <audio> element through Web Audio so we can mix in surface noise
// and a needle-drop thump. Created lazily on the first user gesture.

export class VinylFX {
  constructor(audio) {
    this.audio = audio;
    this.ctx = null;
    this.crackleOn = true;
    this.needleDown = false;
    this.volume = 0.9;
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const src = ctx.createMediaElementSource(this.audio);
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      src.connect(this.master).connect(ctx.destination);
      this.audio.volume = 1;

      this.noise = this.#makeCrackle(ctx);
      this.noiseGain = ctx.createGain();
      this.noiseGain.gain.value = 0;
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 7000;
      const loop = ctx.createBufferSource();
      loop.buffer = this.noise;
      loop.loop = true;
      loop.connect(tone).connect(this.noiseGain).connect(this.master);
      loop.start();

      this.ctx = ctx;
      this.#update();
    } catch (err) {
      console.warn('Web Audio unavailable, playing without effects', err);
      this.ctx = null;
    }
  }

  setCrackle(on) {
    this.crackleOn = on;
    this.#update();
  }

  setNeedle(down) {
    this.needleDown = down;
    this.#update();
  }

  setVolume(v) {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    else this.audio.volume = v;
  }

  // Low thud plus a click, like a stylus landing.
  thump() {
    if (!this.ctx || !this.crackleOn) return;
    const { ctx } = this;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(75, t);
    osc.frequency.exponentialRampToValueAtTime(32, t + 0.14);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.22);

    const click = ctx.createBufferSource();
    click.buffer = this.noise;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(1.6, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    click.connect(cg).connect(this.master);
    click.start(t, Math.random() * 5, 0.06);
  }

  #update() {
    if (!this.ctx) return;
    const g = this.crackleOn && this.needleDown ? 0.6 : 0;
    this.noiseGain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.06);
  }

  #makeCrackle(ctx) {
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 7);
    const buf = ctx.createBuffer(2, len, sr);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);

    // Warm hiss.
    for (const d of [L, R]) {
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        lp += 0.07 * (w - lp);
        d[i] = lp * 0.02 + w * 0.0022;
      }
    }

    // Pops and ticks.
    const pops = 7 * 10;
    for (let k = 0; k < pops; k++) {
      const big = Math.random() < 0.1;
      const amp = (big ? 0.45 : 0.1) * (0.3 + Math.random() * 0.7) * (Math.random() < 0.5 ? -1 : 1);
      const tau = big ? 30 + Math.random() * 50 : 3 + Math.random() * 12;
      const at = Math.floor(Math.random() * (len - tau * 6));
      const pan = Math.random();
      for (let j = 0; j < tau * 5; j++) {
        const v = amp * Math.exp(-j / tau) * (j < 2 ? 1 : Math.random() * 1.6 - 0.8);
        L[at + j] += v * (1 - pan * 0.6);
        R[at + j] += v * (0.4 + pan * 0.6);
      }
    }
    return buf;
  }
}
