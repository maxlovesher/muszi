// Synthesises two short lo-fi albums and their sleeves in the browser, so the
// player can be tried without any music files to hand.

import { hexToRgb } from './color.js';

const SR = 32000;

const F_MAJ = {
  chords: [
    [53, 57, 60, 64],
    [52, 55, 59, 62],
    [50, 53, 57, 60],
    [48, 52, 55, 59],
  ],
  bass: [41, 40, 38, 36],
  scale: [65, 67, 69, 72, 74, 76, 77],
};

const A_MIN = {
  chords: [
    [57, 60, 64, 67],
    [53, 57, 60, 64],
    [48, 55, 60, 64],
    [55, 59, 62, 67],
  ],
  bass: [45, 41, 48, 43],
  scale: [69, 72, 74, 76, 79, 81],
};

const ALBUMS = [
  {
    title: 'Late Bus Home',
    artist: 'The Muszi House Band',
    colors: ['#f08a4b', '#2d1b4e', '#ffd9a8'],
    motif: 'sun',
    tracks: [
      { title: 'Late Bus Home', bpm: 78, seed: 3, ...F_MAJ },
      { title: 'Window Seat', bpm: 72, seed: 17, ...A_MIN },
    ],
  },
  {
    title: 'Paper Lanterns',
    artist: 'Nightjar',
    colors: ['#4fb8a4', '#0f2a3d', '#f4e3b1'],
    motif: 'lanterns',
    tracks: [
      { title: 'Paper Lanterns', bpm: 88, seed: 9, ...A_MIN },
      { title: 'Festival Night', bpm: 94, seed: 23, ...F_MAJ },
    ],
  },
];

export async function makeDemoRecords() {
  const out = [];
  for (const album of ALBUMS) {
    const cover = await drawCover(album);
    for (const [n, t] of album.tracks.entries()) {
      const buffer = await renderSong(t);
      const file = new File([encodeWav(buffer)], `${album.artist} - ${t.title}.wav`, { type: 'audio/wav' });
      out.push({ file, tags: { title: t.title, artist: album.artist, album: album.title, trackNo: n + 1, cover } });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- audio */

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

async function renderSong(r) {
  const beat = 60 / r.bpm;
  const bar = beat * 4;
  const bars = 12;
  const dur = bars * bar + 3.5;
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * SR), SR);
  let seed = r.seed;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const master = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 3;
  master.connect(comp).connect(ctx.destination);
  master.gain.setValueAtTime(0, 0);
  master.gain.linearRampToValueAtTime(0.9, 1.2);
  master.gain.setValueAtTime(0.9, dur - 3);
  master.gain.linearRampToValueAtTime(0, dur - 0.2);

  const noise = ctx.createBuffer(1, SR, SR);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = rnd() * 2 - 1;

  // Pads: detuned triangles through a dark filter with a slow tape wobble.
  const padBus = ctx.createBiquadFilter();
  padBus.type = 'lowpass';
  padBus.frequency.value = 1500;
  padBus.Q.value = 0.4;
  const padGain = ctx.createGain();
  padGain.gain.value = 0.55;
  padBus.connect(padGain).connect(master);
  const wobble = ctx.createOscillator();
  wobble.frequency.value = 0.35;
  const wobbleAmt = ctx.createGain();
  wobbleAmt.gain.value = 9;
  wobble.connect(wobbleAmt);
  wobble.start();

  // Lead with a dotted-eighth echo.
  const delay = ctx.createDelay(2);
  delay.delayTime.value = beat * 0.75;
  const fb = ctx.createGain();
  fb.gain.value = 0.32;
  const wet = ctx.createGain();
  wet.gain.value = 0.35;
  delay.connect(fb).connect(delay);
  delay.connect(wet).connect(master);
  const lead = ctx.createGain();
  lead.gain.value = 0.9;
  lead.connect(master);
  lead.connect(delay);

  const pad = (notes, t, len) => {
    notes.forEach((n, k) => {
      for (const det of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = midi(n);
        o.detune.value = det;
        wobbleAmt.connect(o.detune);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.05, t + 0.35);
        g.gain.setValueAtTime(0.05, t + len - 0.1);
        g.gain.linearRampToValueAtTime(0, t + len + 0.5);
        const pan = ctx.createStereoPanner();
        pan.pan.value = (k / 3 - 0.5) * 0.6 * Math.sign(det);
        o.connect(g).connect(pan).connect(padBus);
        o.start(t);
        o.stop(t + len + 0.6);
      }
    });
  };

  const bassNote = (n, t, len) => {
    const o = ctx.createOscillator();
    o.frequency.value = midi(n);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.42, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + len + 0.05);
  };

  const kick = (t) => {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.4);
  };

  const snare = (t) => {
    const n = ctx.createBufferSource();
    n.buffer = noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    n.connect(bp).connect(g).connect(master);
    n.start(t, rnd() * 0.5, 0.2);
    const body = ctx.createOscillator();
    body.frequency.value = 190;
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.15, t);
    bg.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    body.connect(bg).connect(master);
    body.start(t);
    body.stop(t + 0.1);
  };

  const hat = (t, level) => {
    const n = ctx.createBufferSource();
    n.buffer = noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    n.connect(hp).connect(g).connect(master);
    n.start(t, rnd() * 0.5, 0.06);
  };

  const pluck = (n, t) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    g.connect(lead);
    for (const [type, mult, lvl] of [['sine', 1, 1], ['triangle', 2, 0.25]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = midi(n) * mult;
      const og = ctx.createGain();
      og.gain.value = lvl;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + 1);
    }
  };

  const buildBar = (b) => {
    const t0 = b * bar;
    if (b === bars) {
      pad(r.chords[0], t0, 2.4);
      bassNote(r.bass[0] - 12, t0, 2.4);
      return;
    }
    const ci = b % r.chords.length;
    pad(r.chords[ci], t0, bar);
    for (const [pos, len] of [[0, 1.5], [2, 1], [3.5, 0.5]]) bassNote(r.bass[ci] - 12, t0 + pos * beat, len * beat);
    if (b === 0) return;
    kick(t0);
    kick(t0 + 2.5 * beat);
    snare(t0 + beat);
    snare(t0 + 3 * beat);
    for (let h = 0; h < 8; h++) hat(t0 + (h * 0.5 + (h % 2 ? 0.09 : 0)) * beat, h % 2 ? 0.035 : 0.06);
    if (b >= 4 && b < 14) {
      for (let s = 0; s < 8; s++) if (rnd() < 0.3) pluck(r.scale[Math.floor(rnd() * r.scale.length)], t0 + s * 0.5 * beat);
    }
  };

  // Build each bar just before it plays so only a handful of nodes are live
  // at once; scheduling everything up front makes the render ~10x slower.
  buildBar(0);
  for (let b = 1; b <= bars; b++) {
    ctx.suspend(b * bar - 0.1).then(() => {
      buildBar(b);
      ctx.resume();
    });
  }
  return ctx.startRendering();
}

function encodeWav(buf) {
  const ch = buf.numberOfChannels;
  const len = buf.length;
  const bytes = len * ch * 2;
  const dv = new DataView(new ArrayBuffer(44 + bytes));
  const tag = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  dv.setUint32(4, 36 + bytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true);
  dv.setUint32(24, buf.sampleRate, true);
  dv.setUint32(28, buf.sampleRate * ch * 2, true);
  dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true);
  tag(36, 'data');
  dv.setUint32(40, bytes, true);
  const chans = Array.from({ length: ch }, (_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return dv.buffer;
}

/* ---------------------------------------------------------------- sleeve */

const rgba = (hex, a) => `rgba(${hexToRgb(hex).join(',')},${a})`;

async function drawCover(r) {
  try {
    await document.fonts.load('italic 64px "Instrument Serif"');
  } catch {
    /* fall back to Georgia */
  }
  const S = 600;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  const [accent, bg, light] = r.colors;

  const g = x.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, bg);
  g.addColorStop(1, '#05060a');
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);

  if (r.motif === 'sun') {
    const sg = x.createLinearGradient(0, 130, 0, 470);
    sg.addColorStop(0, light);
    sg.addColorStop(1, accent);
    x.fillStyle = sg;
    x.beginPath();
    x.arc(300, 300, 170, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = g;
    for (let i = 0; i < 7; i++) x.fillRect(110, 318 + i * 22, 380, 3 + i * 2.4);
    x.fillStyle = 'rgba(0,0,0,.55)';
    x.beginPath();
    x.moveTo(0, 470);
    x.bezierCurveTo(160, 430, 260, 500, 400, 462);
    x.bezierCurveTo(480, 440, 540, 452, 600, 440);
    x.lineTo(600, 600);
    x.lineTo(0, 600);
    x.fill();
  } else {
    const lanterns = [
      [180, 210, 64],
      [390, 160, 48],
      [300, 330, 84],
      [470, 360, 38],
      [120, 420, 30],
    ];
    for (const [cx, cy, rad] of lanterns) {
      const glow = x.createRadialGradient(cx, cy, 0, cx, cy, rad * 2.6);
      glow.addColorStop(0, rgba(light, 0.5));
      glow.addColorStop(1, rgba(light, 0));
      x.fillStyle = glow;
      x.fillRect(0, 0, S, S);
    }
    for (const [cx, cy, rad] of lanterns) {
      x.strokeStyle = rgba(light, 0.35);
      x.lineWidth = 1.5;
      x.beginPath();
      x.moveTo(cx, 0);
      x.lineTo(cx, cy - rad);
      x.stroke();
      const body = x.createRadialGradient(cx - rad * 0.3, cy - rad * 0.3, rad * 0.1, cx, cy, rad);
      body.addColorStop(0, light);
      body.addColorStop(1, accent);
      x.fillStyle = body;
      x.beginPath();
      x.ellipse(cx, cy, rad * 0.82, rad, 0, 0, Math.PI * 2);
      x.fill();
      x.strokeStyle = 'rgba(0,0,0,.16)';
      for (const k of [0.35, 0.7]) {
        x.beginPath();
        x.ellipse(cx, cy, rad * 0.82 * k, rad, 0, 0, Math.PI * 2);
        x.stroke();
      }
    }
  }

  const img = x.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 20;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  x.putImageData(img, 0, 0);

  x.fillStyle = light;
  x.font = 'italic 66px "Instrument Serif", Georgia, serif';
  x.fillText(r.title, 40, 540);
  x.globalAlpha = 0.75;
  x.font = '600 16px Manrope, system-ui, sans-serif';
  if ('letterSpacing' in x) x.letterSpacing = '4px';
  x.fillText(r.artist.toUpperCase(), 43, 572);
  x.globalAlpha = 1;

  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
}
