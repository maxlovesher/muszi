// Spotify as a music source: PKCE login (no client secret), the Web API for
// the library and remote control, and the Web Playback SDK to play in the
// browser itself. Emits a 'state' event whenever what's playing changes.

const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';
const KEY = 'muszi:spotify';

// Muszi's own Spotify app. A Client ID is public (PKCE needs no secret), so
// shipping it lets people connect in one click. Spotify only lets accounts
// listed under the app's User Management log in while it's in development mode.
const DEFAULT_CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID || 'a942d890a7c4444eaae06959ed7e44bb';
const PKCE_KEY = 'muszi:pkce';
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomString(n) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (v) => chars[v % chars.length]).join('');
}

let sdkPromise;
function loadSDK() {
  sdkPromise ||= new Promise((resolve, reject) => {
    if (window.Spotify?.Player) {
      resolve();
      return;
    }
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.onerror = () => reject(new Error("Couldn't load Spotify's web player."));
    document.head.append(s);
  });
  return sdkPromise;
}

export function mapTrack(t, albumFallback) {
  if (!t) return null;
  const album = t.album || albumFallback || {};
  const imgs = [...(album.images || [])].sort((a, b) => (b.width || 0) - (a.width || 0));
  return {
    id: t.id || t.uri,
    uri: t.uri,
    title: t.name || 'Untitled',
    artist: (t.artists || []).map((a) => a.name).join(', '),
    album: album.name || '',
    albumUri: album.uri || '',
    coverUrl: imgs[0]?.url || null,
    thumb: imgs.at(-1)?.url || imgs[0]?.url || null,
    duration: (t.duration_ms || 0) / 1000,
    trackNo: t.track_number || 0,
  };
}

export class Spotify extends EventTarget {
  constructor() {
    super();
    const cfg = read();
    // A Client ID typed into settings overrides the built-in one.
    this.customClientId = cfg.clientId && cfg.clientId !== DEFAULT_CLIENT_ID ? cfg.clientId : '';
    this.output = cfg.output === 'remote' ? 'remote' : 'browser';
    this.token = cfg.token || null;
    this.user = null;
    this.state = null;
    this.player = null;
    this.deviceId = null;
    this.playerError = null;
    this.pollTimer = null;
    this.refreshing = null;
  }

  get clientId() {
    return this.customClientId || DEFAULT_CLIENT_ID;
  }

  get connected() {
    return !!this.token?.refresh_token;
  }

  get redirectUri() {
    // Includes the base path when hosted in a subfolder (e.g. GitHub Pages).
    return `${location.origin}${import.meta.env.BASE_URL}`;
  }

  #save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ clientId: this.customClientId, output: this.output, token: this.token }));
    } catch {
      /* ignore */
    }
  }

  setClientId(id) {
    const next = id.trim() === DEFAULT_CLIENT_ID ? '' : id.trim();
    // Tokens belong to the app that issued them.
    if (next !== this.customClientId && this.token) this.logout();
    this.customClientId = next;
    this.#save();
  }

  get usingCustomApp() {
    return !!this.customClientId;
  }

  setOutput(output) {
    this.output = output === 'remote' ? 'remote' : 'browser';
    this.#save();
    if (this.output === 'browser' && this.connected) this.startPlayer();
  }

  /* ---------------------------------------------------------------- auth */

  async login() {
    const verifier = randomString(64);
    const state = randomString(16);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      scope: SCOPES.join(' '),
      code_challenge_method: 'S256',
      code_challenge: challenge,
      redirect_uri: this.redirectUri,
      state,
    });
    location.assign(`${ACCOUNTS}/authorize?${q}`);
  }

  // Finishes a login if the page was opened by Spotify's redirect.
  // Returns true on success, false if this wasn't a redirect.
  async handleRedirect() {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return false;
    history.replaceState(null, '', location.pathname);
    const saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) || 'null');
    sessionStorage.removeItem(PKCE_KEY);
    if (q.get('error')) throw new Error(q.get('error') === 'access_denied' ? 'Spotify login was cancelled.' : `Spotify said: ${q.get('error')}`);
    if (!saved || saved.state !== q.get('state')) throw new Error('That Spotify login looked stale. Try connecting again.');
    await this.#tokenRequest({
      grant_type: 'authorization_code',
      code: q.get('code'),
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      code_verifier: saved.verifier,
    });
    return true;
  }

  logout() {
    this.stopPolling();
    this.player?.disconnect();
    this.player = null;
    this.deviceId = null;
    this.token = null;
    this.user = null;
    this.state = null;
    this.#save();
  }

  async #tokenRequest(params) {
    const res = await fetch(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.error === 'invalid_grant') this.token = null;
      this.#save();
      throw Object.assign(new Error(data.error_description || 'Spotify login failed.'), { status: res.status });
    }
    this.token = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || this.token?.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
    this.#save();
  }

  async accessToken() {
    if (!this.token) throw Object.assign(new Error('Not connected to Spotify.'), { status: 401 });
    if (Date.now() < this.token.expires_at - 60_000) return this.token.access_token;
    this.refreshing ||= this.#tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: this.token.refresh_token,
      client_id: this.clientId,
    }).finally(() => (this.refreshing = null));
    await this.refreshing;
    return this.token.access_token;
  }

  /* ---------------------------------------------------------------- web api */

  async api(path, { method = 'GET', body, retry = true } = {}) {
    const url = path.startsWith('http') ? path : `${API}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && retry && this.token) {
      this.token.expires_at = 0;
      return this.api(path, { method, body, retry: false });
    }
    if (res.status === 429 && retry) {
      await wait((Number(res.headers.get('Retry-After')) || 2) * 1000);
      return this.api(path, { method, body, retry: false });
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error?.message || `Spotify error ${res.status}`), { status: res.status, reason: data.error?.reason });
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async paged(path, max = 300) {
    const out = [];
    let url = `${path}${path.includes('?') ? '&' : '?'}limit=50`;
    while (url && out.length < max) {
      const page = await this.api(url);
      out.push(...(page?.items || []));
      url = page?.next;
    }
    return out;
  }

  async me() {
    this.user ||= await this.api('/me');
    return this.user;
  }

  albums() {
    return this.paged('/me/albums').then((items) => items.map((i) => i.album).filter(Boolean));
  }

  playlists() {
    return this.paged('/me/playlists', 200).then((items) => items.filter(Boolean));
  }

  albumTracks(album) {
    return this.paged(`/albums/${album.id}/tracks`, 200).then((items) => items.map((t) => mapTrack(t, album)));
  }

  // Spotify only lists items for playlists the user owns or collaborates on.
  playlistTracks(id) {
    return this.paged(`/playlists/${id}/items`, 300).then((items) => items.map((i) => mapTrack(i.item || i.track)).filter((t) => t?.uri));
  }

  likedTracks() {
    return this.paged('/me/tracks', 300).then((items) => items.map((i) => mapTrack(i.track)).filter(Boolean));
  }

  async queue() {
    const q = await this.api('/me/player/queue');
    return { current: mapTrack(q?.currently_playing), upcoming: (q?.queue || []).map((t) => mapTrack(t)).filter(Boolean) };
  }

  /* ---------------------------------------------------------------- playback */

  async startPlayer() {
    if (this.player || this.output !== 'browser' || !this.connected) return;
    try {
      await loadSDK();
    } catch (err) {
      this.#fail(err.message);
      return;
    }
    this.deviceReady = new Promise((res) => (this.resolveDevice = res));
    const player = new window.Spotify.Player({
      name: 'Muszi',
      getOAuthToken: (cb) => this.accessToken().then(cb, () => {}),
      volume: this.volume ?? 0.9,
    });
    player.addListener('ready', ({ device_id: id }) => {
      this.deviceId = id;
      this.playerError = null;
      this.resolveDevice(id);
    });
    player.addListener('not_ready', () => (this.deviceId = null));
    player.addListener('player_state_changed', (s) => this.#fromSdk(s));
    player.addListener('initialization_error', ({ message }) => this.#fail(`This browser can't play Spotify here (${message}).`));
    player.addListener('authentication_error', () => this.#fail('Spotify needs you to connect again.'));
    player.addListener('account_error', () => this.#fail('Playing in the browser needs Spotify Premium.'));
    player.addListener('autoplay_failed', () => this.dispatchEvent(new CustomEvent('notice', { detail: 'Click play once to let the browser start Spotify.' })));
    this.player = player;
    player.connect();
  }

  #fail(message) {
    this.playerError = message;
    this.resolveDevice?.(null);
    this.dispatchEvent(new CustomEvent('notice', { detail: message }));
  }

  // Must be called from a click/tap for some browsers to allow playback.
  activate() {
    this.player?.activateElement?.();
  }

  async #device() {
    if (this.output !== 'browser') return null;
    await this.startPlayer();
    if (this.deviceId) return this.deviceId;
    const id = await Promise.race([this.deviceReady, wait(8000).then(() => null)]);
    if (!id) throw Object.assign(new Error(this.playerError || "Spotify's web player didn't start."), { status: 'no-player' });
    return id;
  }

  async #deviceQuery() {
    const id = await this.#device();
    return id ? `?device_id=${id}` : '';
  }

  async playNow(body) {
    await this.api(`/me/player/play${await this.#deviceQuery()}`, { method: 'PUT', body });
    this.pollSoon();
  }

  async resume() {
    // Resuming "on" the browser device pulls playback over to it.
    await this.api(`/me/player/play${await this.#deviceQuery()}`, { method: 'PUT' });
    this.pollSoon();
  }

  async pause() {
    await this.api('/me/player/pause', { method: 'PUT' });
  }

  async seek(seconds) {
    await this.api(`/me/player/seek?position_ms=${Math.max(0, Math.round(seconds * 1000))}`, { method: 'PUT' });
  }

  async next() {
    await this.api('/me/player/next', { method: 'POST' });
    this.pollSoon();
  }

  async previous() {
    await this.api('/me/player/previous', { method: 'POST' });
    this.pollSoon();
  }

  async setShuffle(on) {
    await this.api(`/me/player/shuffle?state=${on}`, { method: 'PUT' });
    this.patch({ shuffle: on });
  }

  // mode: off | context | track
  async setRepeat(mode) {
    await this.api(`/me/player/repeat?state=${mode}`, { method: 'PUT' });
    this.patch({ repeat: mode });
  }

  async setVolume(v) {
    this.volume = v;
    if (this.player && this.output === 'browser') await this.player.setVolume(v);
    else if (this.state?.track) await this.api(`/me/player/volume?volume_percent=${Math.round(v * 100)}`, { method: 'PUT' }).catch(() => {});
  }

  /* ---------------------------------------------------------------- state */

  position() {
    const s = this.state;
    if (!s?.track) return 0;
    const live = s.playing ? (performance.now() - s.at) / 1000 : 0;
    return Math.min(s.duration || 0, s.position + live);
  }

  // Optimistic local update (e.g. right after a seek) until Spotify reports back.
  patch(partial) {
    if (!this.state) return;
    const position = 'position' in partial ? partial.position : this.position();
    this.state = { ...this.state, ...partial, position, at: performance.now() };
  }

  #set(s) {
    this.state = { ...s, at: performance.now() };
    this.dispatchEvent(new CustomEvent('state', { detail: this.state }));
  }

  #fromSdk(s) {
    if (!s?.track_window?.current_track) return;
    this.#set({
      track: mapTrack(s.track_window.current_track),
      playing: !s.paused,
      position: s.position / 1000,
      duration: s.duration / 1000,
      shuffle: s.shuffle,
      repeat: ['off', 'context', 'track'][s.repeat_mode] || 'off',
      context: s.context?.uri || null,
      device: 'Muszi',
      local: true,
    });
  }

  async poll() {
    if (!this.connected) return;
    try {
      const p = await this.api('/me/player');
      if (!p?.item) {
        this.#set({ track: null, playing: false, position: 0, duration: 0, shuffle: false, repeat: 'off', context: null, device: null });
        return;
      }
      // The SDK reports our own device more precisely; don't fight it.
      if (p.device?.id && p.device.id === this.deviceId && this.state?.local) {
        this.state = { ...this.state, shuffle: p.shuffle_state, repeat: p.repeat_state };
        return;
      }
      this.#set({
        track: mapTrack(p.item),
        playing: p.is_playing,
        position: (p.progress_ms || 0) / 1000,
        duration: (p.item.duration_ms || 0) / 1000,
        shuffle: p.shuffle_state,
        repeat: p.repeat_state,
        context: p.context?.uri || null,
        device: p.device?.name || null,
        local: p.device?.id === this.deviceId,
      });
    } catch (err) {
      this.dispatchEvent(new CustomEvent('apierror', { detail: err }));
    }
  }

  pollSoon() {
    clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => this.poll(), 450);
  }

  startPolling() {
    this.stopPolling();
    const tick = async () => {
      await this.poll();
      const busy = this.state?.playing;
      this.pollTimer = setTimeout(tick, document.hidden ? 15000 : busy ? 2500 : 5000);
    };
    tick();
  }

  stopPolling() {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
}
