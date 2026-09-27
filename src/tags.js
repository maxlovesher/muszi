// Minimal tag reader: ID3v2.2–2.4 (MP3) and Vorbis comments (FLAC).
// Anything else falls back to parsing "Artist - Title" out of the file name.

export async function readTags(file) {
  const out = { title: '', artist: '', album: '', trackNo: 0, cover: null };
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
      const size = synchsafe(head, 6);
      const buf = new Uint8Array(await file.slice(0, 10 + size).arrayBuffer());
      parseID3(buf, out);
    } else if (head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) {
      await parseFLAC(file, out);
    }
  } catch (err) {
    console.warn('Could not read tags for', file.name, err);
  }
  const guess = fromFilename(file.name);
  out.title ||= guess.title;
  out.artist ||= guess.artist;
  out.trackNo ||= parseInt(file.name, 10) || 0;
  return out;
}

export function fromFilename(name) {
  let base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  base = base.replace(/^\d{1,3}\s*[-.)]\s*/, '');
  const parts = base.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { artist: '', title: base };
}

/* ---------------------------------------------------------------- ID3 */

const synchsafe = (b, i) => ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

function unsync(b) {
  const out = new Uint8Array(b.length);
  let j = 0;
  for (let i = 0; i < b.length; i++) {
    out[j++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

function parseID3(buf, out) {
  const ver = buf[3];
  const flags = buf[5];
  let b = buf;
  if (flags & 0x80 && ver < 4) b = unsync(b);
  const end = Math.min(b.length, 10 + synchsafe(buf, 6));
  let pos = 10;
  if (flags & 0x40) pos += ver === 4 ? synchsafe(b, pos) : u32(b, pos) + 4;

  const v22 = ver === 2;
  const idLen = v22 ? 3 : 4;
  const hdr = v22 ? 6 : 10;

  while (pos + hdr <= end) {
    const id = String.fromCharCode(...b.subarray(pos, pos + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const size = v22 ? (b[pos + 3] << 16) | (b[pos + 4] << 8) | b[pos + 5] : ver === 4 ? synchsafe(b, pos + 4) : u32(b, pos + 4);
    const fflags = v22 ? 0 : b[pos + 9];
    let data = b.subarray(pos + hdr, pos + hdr + size);
    pos += hdr + size;
    if (!size) continue;
    if (ver === 4 && fflags & 0x01) data = data.subarray(4);
    if (ver === 4 && fflags & 0x02) data = unsync(data);

    switch (id) {
      case 'TIT2':
      case 'TT2':
        out.title ||= text(data);
        break;
      case 'TPE1':
      case 'TP1':
        out.artist ||= text(data);
        break;
      case 'TPE2':
      case 'TP2':
        out.albumArtist ||= text(data);
        break;
      case 'TALB':
      case 'TAL':
        out.album ||= text(data);
        break;
      case 'TRCK':
      case 'TRK':
        out.trackNo ||= parseInt(text(data), 10) || 0;
        break;
      case 'APIC':
      case 'PIC':
        if (!out.cover) out.cover = picture(data, v22);
        break;
    }
  }
  out.artist ||= out.albumArtist || '';
  delete out.albumArtist;
}

function decode(enc, bytes) {
  let label = 'iso-8859-1';
  if (enc === 3) label = 'utf-8';
  else if (enc === 2) label = 'utf-16be';
  else if (enc === 1) {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      label = 'utf-16be';
      bytes = bytes.subarray(2);
    } else {
      label = 'utf-16le';
      if (bytes[0] === 0xff && bytes[1] === 0xfe) bytes = bytes.subarray(2);
    }
  }
  return new TextDecoder(label).decode(bytes).split('\0')[0].trim();
}

const text = (data) => decode(data[0], data.subarray(1));

function picture(data, v22) {
  const enc = data[0];
  let p;
  let mime;
  if (v22) {
    const fmt = String.fromCharCode(data[1], data[2], data[3]).toLowerCase();
    mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
    p = 4;
  } else {
    const z = data.indexOf(0, 1);
    mime = String.fromCharCode(...data.subarray(1, z)).toLowerCase();
    p = z + 1;
  }
  p += 1; // picture type
  if (enc === 1 || enc === 2) {
    while (p + 1 < data.length && !(data[p] === 0 && data[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < data.length && data[p] !== 0) p++;
    p += 1;
  }
  if (!mime.includes('/')) mime = mime === 'png' ? 'image/png' : 'image/jpeg';
  if (p >= data.length) return null;
  return new Blob([data.slice(p)], { type: mime });
}

/* ---------------------------------------------------------------- FLAC */

async function parseFLAC(file, out) {
  let pos = 4;
  for (let i = 0; i < 128; i++) {
    const h = new Uint8Array(await file.slice(pos, pos + 4).arrayBuffer());
    if (h.length < 4) break;
    const last = h[0] & 0x80;
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 4 || (type === 6 && !out.cover)) {
      const d = new Uint8Array(await file.slice(pos + 4, pos + 4 + len).arrayBuffer());
      if (type === 4) vorbisComments(d, out);
      else flacPicture(d, out);
    }
    pos += 4 + len;
    if (last) break;
  }
}

function vorbisComments(d, out) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const utf8 = new TextDecoder('utf-8');
  let p = 0;
  p += 4 + dv.getUint32(p, true);
  const n = dv.getUint32(p, true);
  p += 4;
  for (let i = 0; i < n && p + 4 <= d.length; i++) {
    const len = dv.getUint32(p, true);
    p += 4;
    const s = utf8.decode(d.subarray(p, p + len));
    p += len;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const key = s.slice(0, eq).toUpperCase();
    const val = s.slice(eq + 1).trim();
    if (key === 'TITLE') out.title ||= val;
    else if (key === 'ARTIST') out.artist ||= val;
    else if (key === 'ALBUMARTIST') out.artist ||= val;
    else if (key === 'ALBUM') out.album ||= val;
    else if (key === 'TRACKNUMBER') out.trackNo ||= parseInt(val, 10) || 0;
  }
}

function flacPicture(d, out) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let p = 4;
  const ml = dv.getUint32(p);
  p += 4;
  const mime = String.fromCharCode(...d.subarray(p, p + ml)) || 'image/jpeg';
  p += ml;
  p += 4 + dv.getUint32(p);
  p += 16;
  const len = dv.getUint32(p);
  p += 4;
  out.cover = new Blob([d.slice(p, p + len)], { type: mime });
}
