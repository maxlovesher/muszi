import { Deck } from './deck.js';
import { Crate3D } from './crate.js';
import { readTags } from './tags.js';
import { library } from './library.js';
import { analyzeCover, hashColor, hexToHsl, hsl } from './color.js';
import { VinylFX } from './fx.js';
import { Spotify } from './spotify.js';

const $ = (sel) => document.querySelector(sel);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ------------------------------------------------------------ persistence */

const SETTINGS_KEY = 'muszi:settings';
const PLAYLISTS_KEY = 'muszi:playlists';

function readJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode, quota… */
  }
}

const settings = {
  vinyl: 'cover',
  label: 'auto',
  rpm: 33,
  crackle: true,
  volume: 0.9,
  shuffle: false,
  repeat: 'off',
  tab: 'albums',
  source: 'local',
  queue: [],
  base: [],
  currentId: null,
  queueLabel: '',
  lastTime: 0,
  ...readJSON(SETTINGS_KEY, {}),
};
if (!['cover', 'clear', 'color', 'black'].includes(settings.vinyl)) settings.vinyl = 'cover';
if (!['off', 'all', 'one'].includes(settings.repeat)) settings.repeat = 'off';
if (!['auto', 'h', 'v'].includes(settings.label)) settings.label = 'auto';
if (settings.source !== 'spotify') settings.source = 'local';

let playlists = readJSON(PLAYLISTS_KEY, []);
const saveSettings = () => writeJSON(SETTINGS_KEY, settings);
const savePlaylists = () => writeJSON(PLAYLISTS_KEY, playlists);

/* ------------------------------------------------------------ state */

const audio = new Audio();
audio.preload = 'auto';
for (const k of ['preservesPitch', 'mozPreservesPitch', 'webkitPreservesPitch']) if (k in audio) audio[k] = false;

const fx = new VinylFX(audio);
fx.setCrackle(settings.crackle);
fx.setVolume(settings.volume);

let tracks = []; // import order
const byId = new Map();
let queue = []; // ids in play order
let baseQueue = []; // the same ids before shuffling
let qi = -1;
let queueLabel = '';
let wantPlay = false;
let seq = 0; // bumps on every transport action; stale async flows bail out
let pendingSeek = 0;
let view = 'player';
let detailItem = null;

const sp = new Spotify();
sp.volume = settings.volume;
const spMode = () => settings.source === 'spotify' && sp.connected;
let spNow = null; // the Spotify track on the deck, with cover colours
let spPlaying = false;
let spIgnoreUntil = 0; // ignore Spotify's play/pause reports while the user is mid-gesture
let spCache = { albums: null, playlists: null };
let spDetailTracks = [];

const current = () => (spMode() ? spNow : byId.get(queue[qi]) || null);
const allIds = () => tracks.map((t) => t.id);

// Position and length of whatever is on the platter, in seconds.
function posSec() {
  if (spMode()) return sp.position();
  return current() ? audio.currentTime || pendingSeek || 0 : 0;
}

function durSec() {
  if (spMode()) return sp.state?.duration || spNow?.duration || 0;
  const d = audio.duration;
  return d && Number.isFinite(d) ? d : current()?.duration || 0;
}

const deck = new Deck($('#deck'), {
  onLift,
  onDrop,
  onRecordTap: () => tracks.length && toggle(),
  onSleeveTap: () => {
    if (spMode()) {
      const item = spNow && spAlbumItemFor(spNow);
      if (item) openDetail(item);
      return;
    }
    const t = current();
    const album = t && albums().find((a) => a.key === `a:${albumKey(t)}`);
    if (album) openDetail(album);
  },
});
deck.setOptions({ vinyl: settings.vinyl, label: settings.label, rpm: settings.rpm });
deck.progress = progress;
deck.onFrame = paintProgress;

const crate = new Crate3D($('#crate3d'), { onOpen: openDetail });

function progress() {
  if (spMode()) {
    const d = durSec();
    return d ? sp.position() / d : 0;
  }
  const d = audio.duration;
  return d && Number.isFinite(d) ? audio.currentTime / d : 0;
}

/* ------------------------------------------------------------ transport */

function setWant(on) {
  wantPlay = on;
  $('#playBtn').classList.toggle('is-playing', on);
  $('#playBtn').setAttribute('aria-label', on ? 'Pause' : 'Play');
  document.body.classList.toggle('is-playing', on);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
}

// Bend the playback rate, like a platter speeding up or braking.
function rampRate(to, ms, token) {
  if (document.hidden) {
    audio.playbackRate = to;
    return Promise.resolve(true);
  }
  const from = audio.playbackRate;
  const t0 = performance.now();
  return new Promise((resolve) => {
    const step = (now) => {
      if (token !== seq) return resolve(false);
      const k = Math.min(1, (now - t0) / ms);
      audio.playbackRate = Math.max(0.07, from + (to - from) * k * k * (3 - 2 * k));
      if (k < 1) requestAnimationFrame(step);
      else resolve(true);
    };
    requestAnimationFrame(step);
  });
}

async function play() {
  if (spMode()) {
    if (!spPlaying) spToggle();
    return;
  }
  if (!tracks.length) {
    pickFiles();
    return;
  }
  if (!current()) {
    loadIndex(setQueue(allIds(), 0, 'All Songs'), { autoplay: true });
    return;
  }
  const my = ++seq;
  setWant(true);
  fx.ensure();
  deck.setSpinning(true);

  const d = audio.duration;
  if (audio.ended || (d && audio.currentTime >= d - 0.25)) audio.currentTime = 0;

  if (!deck.armOnRecord()) {
    if (!(await deck.moveArm(deck.angleFor(progress()))) || my !== seq) return;
  }
  if (deck.isLifted()) {
    if (!(await deck.lower()) || my !== seq) return;
    fx.thump();
  }
  deck.follow();

  audio.playbackRate = document.hidden ? 1 : 0.55;
  try {
    await audio.play();
  } catch (err) {
    if (my === seq && err.name !== 'AbortError') {
      toast("Couldn't play this file in your browser.");
      halt();
    }
    return;
  }
  if (my !== seq) return;
  fx.setNeedle(true);
  rampRate(1, 380, my);
}

async function brake(my) {
  deck.setSpinning(false);
  if (!audio.paused) await rampRate(0.3, 450, my);
  if (my !== seq) return false;
  audio.pause();
  audio.playbackRate = 1;
  fx.setNeedle(false);
  return true;
}

async function pause() {
  if (spMode()) {
    if (spPlaying) spToggle();
    return;
  }
  const my = ++seq;
  setWant(false);
  if (!(await brake(my))) return;
  if (deck.armOnRecord()) deck.lift();
}

async function stop() {
  if (spMode()) {
    spDrop(null);
    return;
  }
  const my = ++seq;
  setWant(false);
  if (!(await brake(my))) return;
  await deck.toRest();
}

function halt() {
  ++seq;
  setWant(false);
  audio.pause();
  audio.playbackRate = 1;
  fx.setNeedle(false);
  deck.setSpinning(false);
  deck.toRest();
}

function toggle() {
  if (spMode()) spToggle();
  else if (wantPlay) pause();
  else play();
}

function seekTo(seconds) {
  if (spMode()) {
    const s = clamp(seconds, 0, Math.max(0, durSec() - 1));
    sp.patch({ position: s });
    sp.seek(s).catch(spError);
    return;
  }
  const d = audio.duration;
  if (!d || !Number.isFinite(d)) return;
  audio.currentTime = clamp(seconds, 0, d - 0.05);
  updatePositionState();
}

async function restartSameRecord() {
  const my = ++seq;
  audio.currentTime = 0;
  if (!(await deck.moveArm(deck.angleFor(0))) || my !== seq) return;
  play();
}

function next(auto = false) {
  if (spMode()) {
    sp.next().catch(spError);
    return;
  }
  if (!queue.length) return;
  if (auto && settings.repeat === 'one') {
    restartSameRecord();
    return;
  }
  let n = qi + 1;
  if (n >= queue.length) {
    if (auto && settings.repeat !== 'all') {
      stop();
      audio.currentTime = 0;
      return;
    }
    n = 0;
  }
  loadIndex(n, { autoplay: auto || wantPlay });
}

function prev() {
  if (spMode()) {
    if (sp.position() > 3) seekTo(0);
    else sp.previous().catch(spError);
    return;
  }
  if (!queue.length) return;
  if (audio.currentTime > 3) {
    seekTo(0);
    return;
  }
  loadIndex(qi <= 0 ? queue.length - 1 : qi - 1, { autoplay: wantPlay });
}

// Grabbing the tonearm lifts the stylus: sound stops at once.
function onLift() {
  if (spMode()) {
    ++seq;
    spIgnoreUntil = Infinity;
    fx.setNeedle(false);
    if (sp.state?.playing) {
      sp.patch({ playing: false });
      sp.pause().catch(spError);
    }
    return;
  }
  ++seq;
  audio.pause();
  audio.playbackRate = 1;
  fx.setNeedle(false);
}

// Dropping it on the record plays from that groove; anywhere else parks it.
function onDrop(p) {
  if (spMode()) {
    spDrop(p);
    return;
  }
  const t = current();
  if (p === null || !t) {
    stop();
    return;
  }
  const d = audio.duration || t.duration;
  if (d) audio.currentTime = Math.min(p * d, d - 0.5);
  play();
}

async function loadIndex(i, { autoplay = false, instant = false, at = 0 } = {}) {
  const t = byId.get(queue[i]);
  if (!t) return;
  const my = ++seq;
  audio.pause();
  audio.playbackRate = 1;
  fx.setNeedle(false);
  if (!autoplay) {
    setWant(false);
    deck.setSpinning(false);
  }

  if (!instant) {
    if (!deck.atRest()) {
      if (!(await deck.toRest()) || my !== seq) return;
    }
    await deck.swapOut();
    if (my !== seq) return;
  }

  qi = i;
  pendingSeek = at;
  settings.lastTime = at;
  persistQueue();
  audio.src = t.url;
  deck.setTrack(t);
  applyTheme(t);
  paintNowPlaying();
  if (view === 'queue') renderQueue();
  updateMediaSession();

  if (!instant) {
    await deck.swapIn();
    if (my !== seq) return;
  }
  if (autoplay) play();
}

audio.addEventListener('loadedmetadata', () => {
  if (pendingSeek && pendingSeek < audio.duration - 1) audio.currentTime = pendingSeek;
  pendingSeek = 0;
  updatePositionState();
});
audio.addEventListener('ended', () => next(true));
audio.addEventListener('error', () => {
  if (current() && audio.getAttribute('src')) {
    toast("This file can't be decoded by your browser.");
    halt();
  }
});

let lastSaved = 0;
audio.addEventListener('timeupdate', () => {
  const now = Date.now();
  if (now - lastSaved > 5000) {
    lastSaved = now;
    settings.lastTime = audio.currentTime;
    saveSettings();
  }
});
window.addEventListener('pagehide', () => {
  if (current()) settings.lastTime = audio.currentTime;
  saveSettings();
});

/* ------------------------------------------------------------ queue */

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Replace the queue; returns the index to start from.
function setQueue(ids, start = 0, label = '') {
  baseQueue = ids.slice();
  queueLabel = label;
  if (settings.shuffle) {
    const first = ids[start];
    queue = [first, ...shuffled(ids.filter((_, k) => k !== start))];
    return 0;
  }
  queue = ids.slice();
  return start;
}

function playContext(ids, start, label) {
  if (!ids.length) return;
  loadIndex(setQueue(ids, start, label), { autoplay: true });
}

function persistQueue() {
  settings.queue = queue;
  settings.base = baseQueue;
  settings.currentId = queue[qi] ?? null;
  settings.queueLabel = queueLabel;
  saveSettings();
}

function toggleShuffle() {
  if (spMode()) {
    const on = !sp.state?.shuffle;
    sp.setShuffle(on)
      .then(() => {
        toast(on ? 'Shuffle on' : 'Shuffle off');
        renderQueue();
      })
      .catch(spError);
    return;
  }
  settings.shuffle = !settings.shuffle;
  const id = queue[qi];
  if (settings.shuffle) {
    queue = id ? [id, ...shuffled(baseQueue.filter((x) => x !== id))] : shuffled(baseQueue);
    qi = id ? 0 : -1;
  } else {
    queue = baseQueue.slice();
    qi = id ? queue.indexOf(id) : -1;
  }
  persistQueue();
  renderQueue();
  toast(settings.shuffle ? 'Shuffle on' : 'Shuffle off');
}

function cycleRepeat() {
  if (spMode()) {
    const mode = { off: 'context', context: 'track', track: 'off' }[sp.state?.repeat || 'off'];
    sp.setRepeat(mode)
      .then(() => {
        toast({ off: 'Repeat off', context: 'Repeating', track: 'Repeating this song' }[mode]);
        paintQueueToggles();
      })
      .catch(spError);
    return;
  }
  settings.repeat = { off: 'all', all: 'one', one: 'off' }[settings.repeat];
  saveSettings();
  renderQueue();
  toast({ off: 'Repeat off', all: 'Repeating the queue', one: 'Repeating this song' }[settings.repeat]);
}

/* ------------------------------------------------------------ spotify */

// Cover colours for remote art, keyed by image URL.
const palettes = new Map();
function paletteFor(url) {
  if (!url) return Promise.resolve(null);
  if (!palettes.has(url)) {
    palettes.set(
      url,
      fetch(url)
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => (b ? analyzeCover(b) : null))
        .catch(() => null),
    );
  }
  return palettes.get(url);
}

async function withColors(t) {
  if (!t) return null;
  const pal = await Promise.race([paletteFor(t.thumb), wait(1500).then(() => null)]);
  const fallback = hashColor(`${t.album}${t.artist}`);
  return { ...t, label: pal?.label || fallback, vibrant: pal?.vibrant || pal?.label || fallback };
}

let lastSpError = 0;
function spError(err) {
  console.warn('Spotify:', err);
  const s = err?.status;
  let msg = err?.message || 'Spotify had a problem.';
  if (s === 401) msg = 'Spotify needs you to connect again.';
  else if (s === 403) {
    msg =
      err.reason === 'PREMIUM_REQUIRED'
        ? 'That needs Spotify Premium.'
        : sp.usingCustomApp
          ? 'Spotify refused this account. Add it under User Management in your Spotify app.'
          : 'This Spotify account isn’t on Muszi’s guest list yet. Ask the owner to add it.';
  }
  else if (s === 404) msg = 'No active Spotify device. Open Spotify on a device, or choose “Play here” in settings.';
  lastSpError = Date.now();
  toast(msg, 4500);
}

let spShownId; // id of the track the deck is showing (undefined = nothing yet)
let spSwapping = false;
let swapToken = 0;

sp.addEventListener('state', (e) => {
  if (spMode()) spReact(e.detail);
});
sp.addEventListener('notice', (e) => toast(e.detail, 4500));
sp.addEventListener('apierror', (e) => {
  if (Date.now() - lastSpError > 30000) spError(e.detail);
});

function spReact(s) {
  const id = s.track?.id || null;
  if (id !== spShownId) {
    spShownId = id;
    spSwapTo(s.track);
    return;
  }
  if (spSwapping || performance.now() < spIgnoreUntil) return;
  if (s.playing !== spPlaying) spSetPlaying(s.playing);
  if (view === 'queue') paintQueueToggles();
}

// Same choreography as a local track change, but driven by Spotify.
async function spSwapTo(t) {
  const mine = ++swapToken;
  spSwapping = true;
  const colored = withColors(t);
  fx.setNeedle(false);
  if (!deck.atRest()) await deck.toRest();
  if (mine !== swapToken) return;
  await deck.swapOut();
  if (mine !== swapToken) return;
  spNow = await colored;
  if (mine !== swapToken) return;
  deck.setTrack(spNow);
  applyTheme(spNow);
  paintNowPlaying();
  updateMediaSession();
  if (view === 'queue') renderQueue();
  await deck.swapIn();
  if (mine !== swapToken) return;
  spSwapping = false;
  spPlaying = false;
  if (spNow && sp.state?.playing) spSetPlaying(true);
  else {
    setWant(false);
    deck.setSpinning(false);
  }
}

async function spSetPlaying(on) {
  const my = ++seq;
  spPlaying = on;
  setWant(on);
  if (!on) {
    fx.setNeedle(false);
    deck.setSpinning(false);
    if (deck.armOnRecord()) deck.lift();
    return;
  }
  deck.setSpinning(true);
  if (!deck.armOnRecord()) {
    if (!(await deck.moveArm(deck.angleFor(progress()))) || my !== seq) return;
  }
  if (deck.isLifted()) {
    if (!(await deck.lower()) || my !== seq) return;
    fx.thump();
  }
  deck.follow();
  fx.setNeedle(sp.output === 'browser');
}

async function spToggle() {
  if (!spNow) {
    toast('Pick something from the crate to play.');
    setView('library');
    return;
  }
  sp.activate();
  fx.ensure();
  spIgnoreUntil = performance.now() + 4000;
  const playing = spPlaying || sp.state?.playing;

  if (spSwapping) {
    sp.patch({ playing: !playing });
    setWant(!playing);
    (playing ? sp.pause() : sp.resume()).catch(spError);
    return;
  }
  if (playing) {
    sp.patch({ playing: false });
    spSetPlaying(false);
    sp.pause().catch(spError);
    return;
  }

  // Cue the needle first, then start Spotify as it lands.
  const my = ++seq;
  spPlaying = true;
  setWant(true);
  deck.setSpinning(true);
  if (!deck.armOnRecord()) {
    if (!(await deck.moveArm(deck.angleFor(progress()))) || my !== seq) return;
  }
  if (deck.isLifted()) {
    if (!(await deck.lower()) || my !== seq) return;
    fx.thump();
  }
  deck.follow();
  sp.patch({ playing: true });
  try {
    await sp.resume();
    fx.setNeedle(sp.output === 'browser');
  } catch (err) {
    sp.patch({ playing: false });
    spError(err);
    if (my === seq) spSetPlaying(false);
  }
}

async function spDrop(p) {
  sp.activate();
  fx.ensure();
  spIgnoreUntil = performance.now() + 4000;
  const my = ++seq;
  if (p === null || !spNow) {
    spPlaying = false;
    setWant(false);
    deck.setSpinning(false);
    fx.setNeedle(false);
    if (sp.state?.playing) {
      sp.patch({ playing: false });
      sp.pause().catch(spError);
    }
    await deck.toRest();
    return;
  }
  const s = p * durSec();
  sp.patch({ position: s, playing: false });
  spPlaying = true;
  setWant(true);
  deck.setSpinning(true);
  try {
    await sp.seek(s);
  } catch (err) {
    spError(err);
  }
  if (my !== seq) return;
  if (!(await deck.lower()) || my !== seq) return;
  fx.thump();
  deck.follow();
  sp.patch({ playing: true });
  sp.resume()
    .then(() => fx.setNeedle(sp.output === 'browser'))
    .catch((err) => {
      sp.patch({ playing: false });
      spError(err);
    });
}

function spPlayItem(item, k = 0, list = spDetailTracks) {
  sp.activate();
  fx.ensure();
  spIgnoreUntil = 0;
  const body = item.liked ? { uris: list.slice(k, k + 200).map((t) => t.uri) } : { context_uri: item.uri, offset: { position: k } };
  sp.playNow(body).catch(spError);
  setView('player');
}

function spJumpTo(track) {
  const ctx = sp.state?.context;
  const body = ctx && !ctx.endsWith(':collection') ? { context_uri: ctx, offset: { uri: track.uri } } : { uris: [track.uri] };
  sp.playNow(body).catch(spError);
}

const isSp = (it) => /^s[ap]:/.test(it?.key || '');
const bySize = (imgs) => [...(imgs || [])].sort((a, b) => (b.width || 0) - (a.width || 0));

async function spLibraryItems(tab) {
  const me = await sp.me().catch(() => null);
  if (tab === 'playlists') {
    spCache.playlists ||= sp.playlists().catch((err) => {
      spCache.playlists = null;
      throw err;
    });
    const lists = await spCache.playlists;
    return [
      { kind: 'playlist', key: 'sp:liked', liked: true, title: 'Liked Songs', sub: me?.display_name || 'You', cover: null, color: '#4d3fd6' },
      ...lists.map((p) => ({
        kind: 'playlist',
        key: `sp:${p.id}`,
        spId: p.id,
        uri: p.uri,
        title: p.name,
        sub: p.owner?.display_name || '',
        cover: bySize(p.images)[0]?.url || null,
        thumb: bySize(p.images).at(-1)?.url || null,
        color: '#2b2b2b',
        total: (p.items || p.tracks)?.total ?? null,
        owned: p.owner?.id === me?.id || p.collaborative,
      })),
    ];
  }
  spCache.albums ||= sp.albums().catch((err) => {
    spCache.albums = null;
    throw err;
  });
  return (await spCache.albums).map((a) => ({
    kind: 'album',
    key: `sa:${a.id}`,
    album: a,
    uri: a.uri,
    title: a.name,
    sub: (a.artists || []).map((x) => x.name).join(', '),
    cover: bySize(a.images)[0]?.url || null,
    thumb: bySize(a.images).at(-1)?.url || null,
    color: '#2b2b2b',
    total: a.total_tracks ?? null,
  }));
}

// Spines start neutral and pick up their cover colour as it's analysed,
// nearest the middle of the crate first.
async function colorizeCrate(items, token) {
  const mid = items.length / 2;
  const order = items.map((it, i) => [it, Math.abs(i - mid)]).sort((a, b) => a[1] - b[1]);
  for (const [it] of order) {
    if (token !== libToken) return;
    if (!it.thumb) continue;
    const pal = await paletteFor(it.thumb);
    if (token !== libToken) return;
    if (pal) crate.setColor(it.key, pal.label);
  }
}

function spAlbumItemFor(t) {
  const id = t.albumUri?.split(':').pop();
  if (!id) return null;
  return {
    kind: 'album',
    key: `sa:${id}`,
    album: { id, name: t.album, images: [{ url: t.coverUrl, width: 640 }, { url: t.thumb, width: 64 }] },
    uri: t.albumUri,
    title: t.album,
    sub: t.artist,
    cover: t.coverUrl,
    color: t.label,
    total: null,
  };
}

let detailToken = 0;
async function renderDetailSpotify() {
  const it = detailItem;
  const my = ++detailToken;
  setArt($('#dArt'), it);
  $('#dKind').textContent = it.kind === 'album' ? 'Album' : 'Playlist';
  $('#dTitle').textContent = it.title;
  $('#dMeta').textContent = [it.sub, it.total != null ? `${it.total} songs` : ''].filter(Boolean).join(' · ');
  $('#dDelete').hidden = true;
  $('#dPlay').disabled = $('#dShuffle').disabled = !it.uri && !it.liked;
  const grid = $('#dGrid');
  grid.replaceChildren(el('li', 'd-note', 'Loading songs…'));

  let list = [];
  try {
    if (it.kind === 'album') list = await sp.albumTracks(it.album);
    else if (it.liked) list = await sp.likedTracks();
    else list = await sp.playlistTracks(it.spId);
  } catch (err) {
    if (my !== detailToken) return;
    if (err.status !== 403 && err.status !== 404) spError(err);
  }
  if (my !== detailToken) return;
  spDetailTracks = list;
  if (!list.length) {
    grid.replaceChildren(
      el(
        'li',
        'd-note',
        it.kind === 'playlist' && !it.liked && !it.owned
          ? 'Spotify only shares the song list for playlists you own or collaborate on. Press Play to listen anyway.'
          : 'No songs here.',
      ),
    );
    if (it.liked) $('#dPlay').disabled = $('#dShuffle').disabled = true;
    return;
  }
  const total = list.reduce((s, t) => s + (t.duration || 0), 0);
  $('#dMeta').textContent = [it.sub, `${list.length} song${list.length === 1 ? '' : 's'}`, total ? fmtLong(total) : ''].filter(Boolean).join(' · ');
  const curUri = spNow?.uri;
  grid.replaceChildren(
    ...list.map((t, k) =>
      trackRow(t, {
        isCurrent: t.uri === curUri,
        showDur: true,
        onPlay: () => (t.uri === curUri ? toggle() : spPlayItem(it, k, list)),
      }),
    ),
  );
}

function paintQueueToggles() {
  const shuffle = spMode() ? !!sp.state?.shuffle : settings.shuffle;
  const repeat = spMode() ? { off: 'off', context: 'all', track: 'one' }[sp.state?.repeat || 'off'] : settings.repeat;
  $('#shuffleBtn').setAttribute('aria-pressed', String(shuffle));
  $('#repeatBtn').setAttribute('aria-pressed', String(repeat !== 'off'));
  $('#repeatBtn').dataset.mode = repeat;
}

let queueToken = 0;
async function renderQueueSpotify() {
  const my = ++queueToken;
  paintQueueToggles();
  $('#saveQueueBtn').hidden = true;
  const t = spNow;
  const grid = $('#qGrid');
  if (!t) {
    setArt($('#qNowArt'), { title: 'Muszi' });
    $('#qFrom').textContent = 'Nothing playing on Spotify';
    grid.replaceChildren();
    $('#qNext').hidden = true;
    return;
  }
  setArt($('#qNowArt'), { cover: t.coverUrl, title: t.album || t.title, color: t.label });
  $('#qFrom').textContent = t.album ? `From ${t.album}` : '';
  let q;
  try {
    q = await sp.queue();
  } catch (err) {
    if (my === queueToken) spError(err);
    return;
  }
  if (my !== queueToken) return;
  const run = [t];
  for (const u of q.upcoming) {
    if (run.length >= 10 || u.albumUri !== t.albumUri) break;
    run.push(u);
  }
  grid.replaceChildren(...run.map((tr, k) => trackRow(tr, { isCurrent: k === 0, onPlay: () => (k === 0 ? toggle() : spJumpTo(tr)) })));
  const nt = q.upcoming[run.length - 1];
  $('#qNext').hidden = !nt;
  if (nt) {
    setArt($('#qNextArt'), { cover: nt.coverUrl, title: nt.album || nt.title, color: '#555' });
    $('#qNextArt').onclick = () => spJumpTo(nt);
    $('#qNextTitle').textContent = nt.title;
    $('#qNextArtist').textContent = nt.artist || '';
  }
}

function startSpotify() {
  if (sp.output === 'browser') sp.startPlayer();
  sp.startPolling();
  sp.me()
    .then(paintSpotify)
    .catch(() => {});
}

async function setSource(src) {
  if (src === 'spotify' && !sp.connected) {
    toast('Connect Spotify first.');
    return;
  }
  if (src === settings.source) return;
  ++seq;
  ++swapToken;
  spSwapping = false;
  if (settings.source === 'local') {
    audio.pause();
    audio.playbackRate = 1;
  } else if (sp.state?.local && sp.state.playing) {
    sp.pause().catch(() => {});
  }
  fx.setNeedle(false);
  setWant(false);
  spPlaying = false;
  deck.setSpinning(false);
  spShownId = undefined;
  spNow = null;
  settings.source = src;
  saveSettings();
  paintSettings();

  if (src === 'spotify') {
    startSpotify();
  } else {
    sp.stopPolling();
    const mine = ++swapToken;
    if (!deck.atRest()) await deck.toRest();
    await deck.swapOut();
    if (mine !== swapToken) return;
    const t = current();
    deck.setTrack(t);
    applyTheme(t);
    paintNowPlaying();
    deck.swapIn();
  }
  refreshViews();
}

function paintSpotify() {
  const box = $('#spBox');
  box.classList.toggle('is-connected', sp.connected);
  const name = sp.user?.display_name || sp.user?.id;
  $('#spStatus').textContent = sp.connected ? `Connected${name ? ` as ${name}` : ''}` : 'Not connected';
  if (document.activeElement !== $('#spClientId')) $('#spClientId').value = sp.customClientId;
  if (sp.usingCustomApp) $('.sp-advanced').open = true;
  $('#spRedirect').textContent = sp.redirectUri;
  $('#spConnect').textContent = sp.connected ? 'Disconnect Spotify' : 'Connect Spotify';
  const hint = $('#spHostHint');
  const onLocalhost = location.hostname === 'localhost';
  hint.hidden = !onLocalhost;
  if (onLocalhost) {
    const alt = `${location.protocol}//127.0.0.1${location.port ? `:${location.port}` : ''}${location.pathname}`;
    hint.replaceChildren('Spotify won’t accept “localhost” addresses. Open Muszi at ', Object.assign(el('a', '', alt), { href: alt }), ' to connect.');
  }
  document.querySelector('[data-setting="source"] [data-value="spotify"]').disabled = !sp.connected;
}

/* ------------------------------------------------------------ library data */

const albumKey = (t) => `${(t.album || t.title).toLowerCase()}|${(t.artist || '').toLowerCase()}`;
const byTrackNo = (a, b) => (a.trackNo || 999) - (b.trackNo || 999) || a.order - b.order;

function decorate(item, list) {
  const covers = [...new Set(list.map((t) => t.coverUrl).filter(Boolean))];
  const first = list.find((t) => t.coverUrl) || list[0];
  return {
    ...item,
    ids: list.map((t) => t.id),
    cover: covers[0] || null,
    mosaic: item.kind === 'playlist' && covers.length >= 4 ? covers.slice(0, 4) : null,
    color: first?.label || '#6f6c69',
  };
}

function albums() {
  const map = new Map();
  for (const t of tracks) {
    const k = albumKey(t);
    if (!map.has(k)) map.set(k, { kind: 'album', key: `a:${k}`, title: t.album || t.title, sub: t.artist || 'Unknown artist', list: [] });
    map.get(k).list.push(t);
  }
  return [...map.values()]
    .map(({ list, ...a }) => decorate(a, list.sort(byTrackNo)))
    .sort((a, b) => a.title.localeCompare(b.title));
}

function playlistItems() {
  const pick = (ids) => ids.map((id) => byId.get(id)).filter(Boolean);
  const recent = [...tracks].sort((a, b) => b.order - a.order).slice(0, 50);
  const items = [];
  if (tracks.length) {
    items.push(decorate({ kind: 'playlist', key: 'p:all', title: 'All Songs', sub: 'Muszi' }, tracks));
    items.push(decorate({ kind: 'playlist', key: 'p:recent', title: 'Recently Added', sub: 'Muszi' }, recent));
  }
  for (const p of playlists) items.push(decorate({ kind: 'playlist', key: `p:${p.id}`, id: p.id, title: p.name, sub: 'You' }, pick(p.ids)));
  return items;
}

/* ------------------------------------------------------------ import */

const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|webm)$/i;
const isAudio = (f) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

function toTrack(rec) {
  const fallback = rec.color || hashColor(`${rec.title}${rec.artist}`);
  return {
    ...rec,
    trackNo: rec.trackNo || 0,
    label: rec.label || fallback,
    vibrant: rec.vibrant || fallback,
    url: URL.createObjectURL(rec.blob),
    coverUrl: rec.cover ? URL.createObjectURL(rec.cover) : null,
  };
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(file);
    const done = (v) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(v) ? v : 0);
    };
    const timer = setTimeout(() => done(0), 6000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    a.src = url;
  });
}

async function importItems(items) {
  if (!items.length) return;
  const base = Date.now();
  const added = [];
  let persisted = true;
  toast(`Adding ${items.length} song${items.length === 1 ? '' : 's'}…`, 0);

  for (const [k, item] of items.entries()) {
    const { file } = item;
    const [tags, duration] = await Promise.all([item.tags || readTags(file), probeDuration(file)]);
    const palette = tags.cover ? await analyzeCover(tags.cover).catch(() => null) : null;
    const fallback = hashColor(`${tags.title}${tags.artist}`);
    const rec = {
      id: uid(),
      name: file.name,
      blob: file,
      type: file.type,
      title: tags.title || file.name,
      artist: tags.artist || '',
      album: tags.album || '',
      trackNo: tags.trackNo || 0,
      cover: tags.cover || null,
      duration,
      label: palette?.label || fallback,
      vibrant: palette?.vibrant || fallback,
      order: base + k,
    };
    try {
      await library.put(rec);
    } catch (err) {
      persisted = false;
      console.warn('Could not save to the library', err);
    }
    const t = toTrack(rec);
    tracks.push(t);
    byId.set(t.id, t);
    added.push(t.id);
  }

  toast(
    persisted
      ? `Added ${items.length} song${items.length === 1 ? '' : 's'} to the crate.`
      : "Added for this session. Your browser wouldn't let Muszi save them.",
  );

  if (settings.source !== 'local') {
    toast(`Added to your files. Switch “Music from” to My files to play them.`, 4000);
  } else if (!current()) {
    loadIndex(setQueue(allIds(), tracks.length - added.length, 'All Songs'));
  } else if (queueLabel === 'All Songs') {
    baseQueue.push(...added);
    queue.push(...(settings.shuffle ? shuffled(added) : added));
    persistQueue();
  }
  refreshViews();
}

function addFiles(fileList) {
  const files = [...fileList].filter(isAudio).sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true }));
  if (!files.length) {
    toast('No audio files in there.');
    return;
  }
  importItems(files.map((file) => ({ file })));
}

const pickFiles = () => $('#fileInput').click();

async function pressDemo(btn) {
  if (btn) btn.disabled = true;
  toast('Pressing demo records…', 0);
  try {
    const { makeDemoRecords } = await import('./demo.js');
    await importItems(await makeDemoRecords());
  } catch (err) {
    console.error(err);
    toast("Couldn't press the demo records.");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function removeTrack(id) {
  const t = byId.get(id);
  if (!t) return;
  const curId = queue[qi];
  const wasCurrent = curId === id;
  const oldQi = qi;

  tracks = tracks.filter((x) => x.id !== id);
  byId.delete(id);
  library.remove(id).catch(() => {});
  for (const p of playlists) p.ids = p.ids.filter((x) => x !== id);
  savePlaylists();
  queue = queue.filter((x) => x !== id);
  baseQueue = baseQueue.filter((x) => x !== id);

  if (wasCurrent) {
    ++seq;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    fx.setNeedle(false);
    setWant(false);
    deck.setSpinning(false);
    qi = -1;
    if (queue.length) loadIndex(Math.min(oldQi, queue.length - 1));
    else if (tracks.length) loadIndex(setQueue(allIds(), 0, 'All Songs'));
    else clearDeck();
  } else {
    qi = queue.indexOf(curId);
  }
  persistQueue();

  setTimeout(() => {
    URL.revokeObjectURL(t.url);
    if (t.coverUrl) URL.revokeObjectURL(t.coverUrl);
  }, 3000);
  toast(`Removed “${t.title}”.`);
  refreshViews();
}

async function clearDeck() {
  const my = ++seq;
  if (!deck.atRest()) await deck.toRest();
  if (my !== seq) return;
  await deck.swapOut();
  if (my !== seq) return;
  deck.setTrack(null);
  applyTheme(null);
  paintNowPlaying();
  deck.swapIn();
}

async function clearCrate() {
  if (!tracks.length || !confirm('Remove every song from the crate?')) return;
  ++seq;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  fx.setNeedle(false);
  setWant(false);
  deck.setSpinning(false);
  const old = tracks;
  tracks = [];
  byId.clear();
  queue = [];
  baseQueue = [];
  qi = -1;
  playlists = [];
  savePlaylists();
  persistQueue();
  library.clear().catch(() => {});
  refreshViews();
  if (!spMode()) {
    setView('player');
    await clearDeck();
  }
  for (const t of old) {
    URL.revokeObjectURL(t.url);
    if (t.coverUrl) URL.revokeObjectURL(t.coverUrl);
  }
}

async function filesFromDrop(dt) {
  // webkitGetAsEntry must be read synchronously inside the drop event.
  const entries = [...(dt.items || [])]
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry?.())
    .filter(Boolean);
  if (!entries.length) return [...dt.files];

  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        all.push(...batch);
      } while (batch.length);
      all.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const e of all) await walk(e);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

/* ------------------------------------------------------------ painting */

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

const fmtLong = (s) => {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr ${m % 60} min`;
};

function paintNowPlaying() {
  const t = current();
  $('#pillTitle').textContent = t ? t.title : 'Nothing playing';
  let idle = tracks.length ? 'Pick something from the crate' : 'Add some music';
  if (spMode()) idle = 'Nothing playing on Spotify';
  $('#pillArtist').textContent = t ? t.artist || 'Unknown artist' : idle;
  const mini = $('#miniRec .mini-label');
  mini.style.setProperty('--mini', t?.coverUrl ? `url("${t.coverUrl}")` : t?.label || '#cfcfcf');
  document.title = t ? `${t.title} · Muszi` : 'Muszi';
  document.body.classList.toggle('is-empty', !spMode() && !tracks.length);
  lastProgressKey = '';
  paintProgress();
}

let lastProgressKey = '';
function paintProgress() {
  const d = durSec();
  const c = posSec();
  const p = d ? Math.min(1, c / d) : 0;
  const key = `${Math.round(p * 600)}|${Math.floor(c)}|${Math.floor(d)}`;
  if (key === lastProgressKey) return;
  lastProgressKey = key;
  $('#pillBar').style.setProperty('--p', p.toFixed(4));
  $('#pillTime').textContent = `${fmt(c)} / ${fmt(d)}`;
  $('#pillProgress').setAttribute('aria-valuenow', String(Math.round(p * 100)));
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// Cover art (or a generated sleeve) into a .q-art box.
function setArt(box, { cover, mosaic, title, color }) {
  box.replaceChildren();
  box.style.setProperty('--c', color || '#6f6c69');
  box.classList.toggle('is-mosaic', !!mosaic);
  if (mosaic) {
    box.style.display = 'grid';
    box.style.gridTemplateColumns = '1fr 1fr';
    for (const src of mosaic) box.append(Object.assign(new Image(), { src, alt: '', draggable: false }));
  } else if (cover) {
    box.style.display = '';
    box.append(Object.assign(new Image(), { src: cover, alt: '', draggable: false }));
  } else {
    box.style.display = '';
    const gen = el('div', 'sleeve-gen');
    gen.style.setProperty('--c', color || '#6f6c69');
    gen.append(el('span', 'sleeve-gen-title', title || ''));
    box.append(gen);
  }
}

const X_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

function trackRow(t, { isCurrent = false, onPlay, onRemove, removeLabel, showDur = false }) {
  const li = el('li', isCurrent ? 'is-current' : '');
  const btn = el('button', 't-btn');
  btn.type = 'button';
  const title = el('span', 't-title');
  const bars = el('span', 't-bars');
  bars.append(el('i'), el('i'), el('i'));
  title.append(bars, el('span', '', t.title));
  btn.append(title, el('span', 't-sub', t.artist || 'Unknown artist'));
  btn.addEventListener('click', onPlay);
  li.append(btn);
  if (onRemove) {
    const rm = el('button', 't-remove');
    rm.type = 'button';
    rm.setAttribute('aria-label', removeLabel || `Remove ${t.title}`);
    rm.innerHTML = X_ICON;
    rm.addEventListener('click', onRemove);
    li.append(rm);
  }
  if (showDur && t.duration) li.append(el('span', 't-dur', fmt(t.duration)));
  return li;
}

function renderQueue() {
  if (spMode()) {
    renderQueueSpotify();
    return;
  }
  const t = current();
  paintQueueToggles();
  $('#saveQueueBtn').hidden = false;
  const grid = $('#qGrid');
  const nextBox = $('#qNext');
  if (!t) {
    setArt($('#qNowArt'), { title: 'Muszi' });
    $('#qFrom').textContent = 'Nothing queued';
    grid.replaceChildren();
    nextBox.hidden = true;
    return;
  }
  setArt($('#qNowArt'), { cover: t.coverUrl, title: t.album || t.title, color: t.label });
  $('#qFrom').textContent = t.album ? `From ${t.album}` : queueLabel ? `From ${queueLabel}` : '';

  const run = [];
  for (let i = qi; i < queue.length && run.length < 10; i++) {
    const tr = byId.get(queue[i]);
    if (!tr) continue;
    if (run.length && albumKey(tr) !== albumKey(t)) break;
    run.push(i);
  }
  grid.replaceChildren(
    ...run.map((i) => trackRow(byId.get(queue[i]), { isCurrent: i === qi, onPlay: () => (i === qi ? toggle() : loadIndex(i, { autoplay: true })) })),
  );

  let n = (run.at(-1) ?? qi) + 1;
  if (n >= queue.length && settings.repeat === 'all') n = 0;
  const nt = n < queue.length && n !== qi ? byId.get(queue[n]) : null;
  nextBox.hidden = !nt;
  if (nt) {
    setArt($('#qNextArt'), { cover: nt.coverUrl, title: nt.album || nt.title, color: nt.label });
    $('#qNextArt').onclick = () => loadIndex(n, { autoplay: true });
    $('#qNextTitle').textContent = nt.title;
    $('#qNextArtist').textContent = nt.artist || 'Unknown artist';
  }
}

let libToken = 0;
async function renderLibrary({ keepPosition = true } = {}) {
  const my = ++libToken;
  const q = $('#search').value.trim().toLowerCase();
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === settings.tab));
  let items;
  let emptyText;
  if (spMode()) {
    if (!crate.items.length || !isSp(crate.items[0])) {
      crate.setItems([]);
      $('#crateEmpty').textContent = 'Loading your Spotify library…';
    }
    try {
      items = await spLibraryItems(settings.tab);
    } catch (err) {
      if (my !== libToken) return;
      spError(err);
      items = [];
    }
    if (my !== libToken) return;
    emptyText = settings.tab === 'albums' ? 'No saved albums on Spotify yet.' : 'No playlists on Spotify yet.';
  } else {
    items = settings.tab === 'playlists' ? playlistItems() : albums();
    emptyText = !tracks.length
      ? 'Your crate is empty. Add some music to start digging.'
      : settings.tab === 'playlists'
        ? 'No playlists yet. Save a queue to make one.'
        : '';
  }
  if (q) {
    items = items.filter(
      (it) => `${it.title} ${it.sub}`.toLowerCase().includes(q) || it.ids?.some((id) => byId.get(id)?.title.toLowerCase().includes(q)),
    );
  }
  crate.setItems(items, { keepPosition });
  $('#crateEmpty').textContent = items.length ? '' : q ? `Nothing matches “${q}”.` : emptyText;
  if (spMode()) colorizeCrate(items, my);
}

function openDetail(item) {
  detailItem = item;
  renderDetail();
  setView('detail');
}

function renderDetail() {
  const it = detailItem;
  if (!it) return;
  if (isSp(it)) {
    renderDetailSpotify();
    return;
  }
  const list = (it.id ? playlists.find((p) => p.id === it.id)?.ids || [] : it.ids).map((id) => byId.get(id)).filter(Boolean);
  const ids = list.map((t) => t.id);
  setArt($('#dArt'), it);
  $('#dKind').textContent = it.kind === 'album' ? 'Album' : 'Playlist';
  $('#dTitle').textContent = it.title;
  const total = list.reduce((s, t) => s + (t.duration || 0), 0);
  $('#dMeta').textContent = [it.sub, `${list.length} song${list.length === 1 ? '' : 's'}`, total ? fmtLong(total) : ''].filter(Boolean).join(' · ');
  $('#dDelete').hidden = !it.id;
  $('#dPlay').disabled = $('#dShuffle').disabled = !list.length;

  const curId = queue[qi];
  $('#dGrid').replaceChildren(
    ...list.map((t, k) =>
      trackRow(t, {
        isCurrent: t.id === curId,
        showDur: true,
        onPlay: () => {
          if (t.id === curId) toggle();
          else playContext(ids, k, it.title);
          setView('player');
        },
        removeLabel: it.id ? `Remove ${t.title} from this playlist` : `Remove ${t.title} from the crate`,
        onRemove: () => {
          if (it.id) {
            const p = playlists.find((x) => x.id === it.id);
            if (p) p.ids = p.ids.filter((x) => x !== t.id);
            savePlaylists();
            renderDetail();
          } else removeTrack(t.id);
        },
      }),
    ),
  );
  detailItem.ids = ids;
}

function refreshViews() {
  paintNowPlaying();
  if (view === 'library') renderLibrary();
  if (view === 'queue') renderQueue();
  if (view === 'detail') {
    // A local album can vanish when its last song is removed, and switching
    // source leaves the other source's album on screen.
    const stale = isSp(detailItem) ? !spMode() : spMode() || (!detailItem?.id && !detailItem?.ids.some((id) => byId.has(id)));
    if (stale) setView('library');
    else if (!isSp(detailItem)) renderDetail();
  }
}

function setView(v) {
  if (v === view) return;
  view = v;
  for (const node of document.querySelectorAll('.view')) node.classList.toggle('is-active', node.dataset.view === v);
  $('#libBtn').setAttribute('aria-pressed', String(v === 'library' || v === 'detail'));
  $('#queueBtn').setAttribute('aria-pressed', String(v === 'queue'));
  if (v === 'library') {
    renderLibrary();
    crate.show();
  } else crate.hide();
  if (v === 'queue') renderQueue();
}

/* ------------------------------------------------------------ theme */

let bgFlip = 0;
function applyTheme(t) {
  const label = t?.label || '#8d8a86';
  const vib = t?.vibrant || label;
  const [h, s, l] = hexToHsl(label);
  const base = hsl(h, Math.min(s, 0.45), clamp(l * 0.8, 0.26, 0.5));
  document.body.style.backgroundColor = base;
  const [vh, vs, vl] = hexToHsl(vib);
  document.documentElement.style.setProperty('--accent', hsl(vh, Math.min(vs, 0.8), clamp(vl, 0.55, 0.72)));

  const layers = document.querySelectorAll('.bg-art');
  bgFlip ^= 1;
  const next = layers[bgFlip];
  next.style.backgroundImage = t?.coverUrl ? `url("${t.coverUrl}")` : `radial-gradient(circle at 40% 40%, ${hsl(h, s, 0.62)}, ${base})`;
  next.classList.add('is-on');
  layers[bgFlip ^ 1].classList.remove('is-on');
  document.querySelector('meta[name="theme-color"]').content = base;
}

/* ------------------------------------------------------------ media session */

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = current();
  if (!t) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.artist,
    album: t.album,
    artwork: t.coverUrl ? [{ src: t.coverUrl, sizes: '512x512', type: t.cover?.type || 'image/jpeg' }] : [],
  });
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = audio.duration;
  if (!d || !Number.isFinite(d)) return;
  try {
    navigator.mediaSession.setPositionState({ duration: d, position: Math.min(audio.currentTime, d), playbackRate: 1 });
  } catch {
    /* ignore */
  }
}

if ('mediaSession' in navigator) {
  const on = (action, fn) => {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch {
      /* unsupported */
    }
  };
  on('play', () => play());
  on('pause', () => pause());
  on('stop', () => stop());
  on('previoustrack', () => prev());
  on('nexttrack', () => next());
  on('seekto', (e) => seekTo(e.seekTime));
  on('seekbackward', (e) => seekTo(audio.currentTime - (e.seekOffset || 10)));
  on('seekforward', (e) => seekTo(audio.currentTime + (e.seekOffset || 10)));
}

/* ------------------------------------------------------------ toast */

let toastTimer;
function toast(msg, ms = 2600) {
  const node = $('#toast');
  node.textContent = msg;
  node.classList.add('show');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => node.classList.remove('show'), ms);
}

/* ------------------------------------------------------------ wiring */

$('#playBtn').addEventListener('click', toggle);
$('#nextBtn').addEventListener('click', () => next());
$('#pillMain').addEventListener('click', () => setView(view === 'player' ? 'queue' : 'player'));
$('#shuffleBtn').addEventListener('click', toggleShuffle);
$('#repeatBtn').addEventListener('click', cycleRepeat);

$('#saveQueueBtn').addEventListener('click', () => {
  if (!queue.length) {
    toast('The queue is empty.');
    return;
  }
  const name = prompt('Name this playlist', queueLabel && queueLabel !== 'All Songs' ? `${queueLabel} mix` : 'New playlist');
  if (!name?.trim()) return;
  playlists.push({ id: uid(), name: name.trim(), ids: queue.slice(), created: Date.now() });
  savePlaylists();
  toast(`Saved “${name.trim()}” to your playlists.`);
});

// Seek by clicking/dragging the thin line under the pill.
const bar = $('#pillProgress');
const seekFromPointer = (e) => {
  const r = bar.getBoundingClientRect();
  const d = audio.duration;
  if (d) seekTo(((e.clientX - r.left) / r.width) * d);
};
bar.addEventListener('pointerdown', (e) => {
  bar.setPointerCapture(e.pointerId);
  seekFromPointer(e);
});
bar.addEventListener('pointermove', (e) => {
  if (bar.hasPointerCapture(e.pointerId)) seekFromPointer(e);
});
bar.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    e.stopPropagation();
    seekTo(audio.currentTime + (e.key === 'ArrowRight' ? 5 : -5));
  }
});

// Navigation between views.
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) {
    const target = go.dataset.go;
    const isDock = go.classList.contains('dock-btn');
    const here = view === target || (target === 'library' && view === 'detail' && isDock);
    setView(isDock && here ? 'player' : target);
    return;
  }
  const action = e.target.closest('[data-action]');
  if (!action) return;
  action.closest('[popover]')?.hidePopover();
  switch (action.dataset.action) {
    case 'add':
      pickFiles();
      break;
    case 'folder':
      $('#folderInput').click();
      break;
    case 'demo':
      pressDemo(action);
      break;
    case 'clear':
      clearCrate();
      break;
    case 'spotify':
      paintSpotify();
      $('#settings').showPopover();
      break;
  }
});

for (const b of document.querySelectorAll('[data-tab]')) {
  b.addEventListener('click', () => {
    settings.tab = b.dataset.tab;
    saveSettings();
    renderLibrary({ keepPosition: false });
  });
}

$('#searchBtn').addEventListener('click', () => {
  const wrap = $('#searchBtn').closest('.search');
  const open = !wrap.classList.contains('is-open');
  wrap.classList.toggle('is-open', open);
  if (open) $('#search').focus();
  else if ($('#search').value) {
    $('#search').value = '';
    renderLibrary({ keepPosition: false });
  }
});
$('#search').addEventListener('input', () => renderLibrary({ keepPosition: false }));

$('#dPlay').addEventListener('click', () => {
  if (isSp(detailItem)) {
    spPlayItem(detailItem, 0);
    return;
  }
  if (!detailItem?.ids.length) return;
  playContext(detailItem.ids, 0, detailItem.title);
  setView('player');
});
$('#dShuffle').addEventListener('click', () => {
  if (isSp(detailItem)) {
    const n = spDetailTracks.length || detailItem.total || 1;
    const k = Math.floor(Math.random() * n);
    sp.setShuffle(true)
      .catch(() => {})
      .then(() => spPlayItem(detailItem, k));
    return;
  }
  if (!detailItem?.ids.length) return;
  if (!settings.shuffle) toggleShuffle();
  playContext(detailItem.ids, Math.floor(Math.random() * detailItem.ids.length), detailItem.title);
  setView('player');
});
$('#dDelete').addEventListener('click', () => {
  if (!detailItem?.id || !confirm(`Delete the playlist “${detailItem.title}”?`)) return;
  playlists = playlists.filter((p) => p.id !== detailItem.id);
  savePlaylists();
  setView('library');
});

$('#fileInput').addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});
$('#folderInput').addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});

// Settings panel.
function paintSettings() {
  for (const group of document.querySelectorAll('[data-setting]')) {
    const key = group.dataset.setting;
    const value = String(key === 'spOutput' ? sp.output : key === 'source' && !sp.connected ? 'local' : settings[key]);
    for (const b of group.querySelectorAll('[data-value]')) b.setAttribute('aria-pressed', String(b.dataset.value === value));
  }
  $('#crackleToggle').checked = settings.crackle;
  $('#volume').value = String(settings.volume);
  $('#volume').style.setProperty('--pct', `${settings.volume * 100}%`);
  paintSpotify();
}

$('#settings').addEventListener('click', (e) => {
  const b = e.target.closest('[data-value]');
  if (!b || b.disabled) return;
  const key = b.closest('[data-setting]').dataset.setting;
  if (key === 'source') {
    setSource(b.dataset.value);
    return;
  }
  if (key === 'spOutput') {
    sp.setOutput(b.dataset.value);
    paintSettings();
    return;
  }
  settings[key] = key === 'rpm' ? Number(b.dataset.value) : b.dataset.value;
  saveSettings();
  paintSettings();
  deck.setOptions({ vinyl: settings.vinyl, label: settings.label, rpm: settings.rpm });
});

$('#spClientId').addEventListener('change', (e) => sp.setClientId(e.target.value));
$('#spCopy').addEventListener('click', () => {
  navigator.clipboard.writeText(sp.redirectUri).then(
    () => toast('Redirect URI copied.'),
    () => toast('Select the address and copy it by hand.'),
  );
});
$('#spConnect').addEventListener('click', async () => {
  if (sp.connected) {
    if (spMode()) await setSource('local');
    sp.logout();
    spCache = { albums: null, playlists: null };
    paintSettings();
    toast('Disconnected from Spotify.');
    return;
  }
  sp.setClientId($('#spClientId').value);
  if (location.hostname === 'localhost') {
    toast('Open Muszi at 127.0.0.1 first. Spotify doesn’t accept “localhost”.', 5000);
    return;
  }
  sp.login();
});
$('#crackleToggle').addEventListener('change', (e) => {
  settings.crackle = e.target.checked;
  fx.setCrackle(settings.crackle);
  saveSettings();
});
$('#volume').addEventListener('input', (e) => {
  settings.volume = Number(e.target.value);
  e.target.style.setProperty('--pct', `${settings.volume * 100}%`);
  fx.setVolume(settings.volume);
  saveSettings();
  if (sp.connected) {
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => sp.setVolume(settings.volume).catch(() => {}), sp.output === 'browser' ? 0 : 300);
  }
});
let volumeTimer;

// Drag & drop anywhere.
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  addFiles(await filesFromDrop(e.dataTransfer));
});

// Keyboard.
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) {
    if (e.key === 'Escape' && target.id === 'search') $('#searchBtn').click();
    return;
  }
  const onControl = tag === 'BUTTON' || target.getAttribute?.('role') === 'button';
  switch (e.key) {
    case ' ':
      if (onControl) return;
      e.preventDefault();
      toggle();
      break;
    case 'k':
      toggle();
      break;
    case 'ArrowRight':
    case 'ArrowLeft': {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      if (view === 'library') crate.step(dir);
      else seekTo(audio.currentTime + dir * (e.shiftKey ? 30 : 10));
      break;
    }
    case 'Enter':
      if (view === 'library' && !onControl) crate.openCurrent();
      break;
    case 'n':
      next();
      break;
    case 'p':
      prev();
      break;
    case 'c':
      settings.crackle = !settings.crackle;
      fx.setCrackle(settings.crackle);
      paintSettings();
      saveSettings();
      toast(settings.crackle ? 'Crackle on' : 'Crackle off');
      break;
    case 'l':
      setView(view === 'library' ? 'player' : 'library');
      break;
    case 'q':
      setView(view === 'queue' ? 'player' : 'queue');
      break;
    case '/':
      if (view === 'library') {
        e.preventDefault();
        $('#searchBtn').click();
      }
      break;
    case 'Escape':
      if (document.querySelector(':popover-open')) return;
      setView(view === 'detail' ? 'library' : 'player');
      break;
  }
});

/* ------------------------------------------------------------ boot */

paintSettings();
applyTheme(null);
paintNowPlaying();

(async () => {
  // Coming back from Spotify's login page?
  try {
    if (await sp.handleRedirect()) {
      settings.source = 'spotify';
      saveSettings();
      toast('Spotify connected.');
    }
  } catch (err) {
    toast(err.message, 5000);
  }
  paintSettings();
  paintNowPlaying();
  if (spMode()) startSpotify();

  try {
    const recs = await library.all();
    recs.sort((a, b) => a.order - b.order);
    tracks = recs.map(toTrack);
  } catch (err) {
    console.warn('Library unavailable', err);
  }
  for (const t of tracks) byId.set(t.id, t);

  queue = (settings.queue || []).filter((id) => byId.has(id));
  baseQueue = (settings.base || []).filter((id) => byId.has(id));
  queueLabel = settings.queueLabel || '';
  if (!baseQueue.length) baseQueue = queue.slice();
  let i = queue.indexOf(settings.currentId);
  if (!queue.length && tracks.length) i = setQueue(allIds(), 0, 'All Songs');
  paintNowPlaying();
  if (!spMode() && queue.length) loadIndex(Math.max(0, i), { instant: true, at: i >= 0 ? settings.lastTime || 0 : 0 });

  // Songs saved by an older version only have a single colour; work out the
  // label/vibrant pair from their covers now.
  for (const t of tracks) {
    if (!t.cover || (t.label && t.vibrant && t.label !== t.color)) continue;
    const palette = await analyzeCover(t.cover).catch(() => null);
    if (!palette) continue;
    Object.assign(t, palette);
    if (!spMode() && t === current()) {
      deck.setTrack(t);
      applyTheme(t);
    }
  }
})();
