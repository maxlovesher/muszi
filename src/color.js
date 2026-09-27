export function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

export function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

export function hslToHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255);
}

export const hexToHsl = (hex) => rgbToHsl(...hexToRgb(hex));

export const hsl = (h, s, l, a = 1) =>
  `hsl(${h.toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%${a < 1 ? ` / ${a}` : ''})`;

export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function hashColor(str = '') {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) | 0;
  return hslToHex(Math.abs(h) % 360, 0.55, 0.5);
}

// `label` is the colour covering most of the art (what a printed label or
// coloured vinyl would be matched to); `vibrant` is its most eye-catching one.
export async function analyzeCover(blob) {
  const bmp = await createImageBitmap(blob);
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, size, size);
  bmp.close?.();
  const { data } = ctx.getImageData(0, 0, size, size);

  const common = new Map();
  const vivid = new Map();
  const add = (map, key, r, g, b, w) => {
    const e = map.get(key) || { r: 0, g: 0, b: 0, w: 0 };
    e.r += r * w;
    e.g += g * w;
    e.b += b * w;
    e.w += w;
    map.set(key, e);
  };
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    add(common, key, r, g, b, 1);
    const [, s, l] = rgbToHsl(r, g, b);
    if (l > 0.12 && l < 0.9) add(vivid, key, r, g, b, 0.05 + s * s * (1 - Math.abs(l - 0.5) * 1.4));
  }
  const top = (map) => {
    let best = null;
    for (const e of map.values()) if (!best || e.w > best.w) best = e;
    return best && rgbToHex(best.r / best.w, best.g / best.w, best.b / best.w);
  };
  const label = top(common) || '#8a8a8a';
  return { label, vibrant: top(vivid) || label };
}

// Picks the most prominent *colourful* colour on a cover, falling back to the
// average when the art is essentially greyscale.
export async function dominantColor(blob) {
  const bmp = await createImageBitmap(blob);
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, size, size);
  bmp.close?.();
  const { data } = ctx.getImageData(0, 0, size, size);

  const buckets = new Map();
  let ar = 0;
  let ag = 0;
  let ab = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    ar += r;
    ag += g;
    ab += b;
    n++;
    const [, s, l] = rgbToHsl(r, g, b);
    if (l < 0.1 || l > 0.93) continue;
    const w = 0.08 + s * s * (1 - Math.abs(l - 0.5) * 1.5);
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const e = buckets.get(key) || { r: 0, g: 0, b: 0, w: 0 };
    e.r += r * w;
    e.g += g * w;
    e.b += b * w;
    e.w += w;
    buckets.set(key, e);
  }

  let best = null;
  for (const e of buckets.values()) if (!best || e.w > best.w) best = e;
  if (!best || best.w < n * 0.01) return rgbToHex(ar / n, ag / n, ab / n);
  return rgbToHex(best.r / best.w, best.g / best.w, best.b / best.w);
}
