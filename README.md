# Muszi

A vinyl music player for the web, inspired by MD Vinyl. Your music sits in a
crate of sleeves; put a record on and drop the needle anywhere to play from
that point.

**Live:** https://maxlovesher.github.io/muszi/

- Plays your own files (MP3, FLAC, WAV, M4A, OGG). They're stored in your
  browser, never uploaded.
- Or connect Spotify to play your saved albums and playlists, either in the
  browser or by remote-controlling the Spotify app.
- Translucent vinyl marbled from the cover art, a draggable tonearm, surface
  crackle, a 3D crate, and a queue view.

## Run locally

```bash
npm install
npm run dev
```

Open the `http://127.0.0.1:…` address Vite prints (not `localhost`; see below).

## Connecting Spotify

1. Create an app in the [Spotify developer dashboard](https://developer.spotify.com/dashboard)
   with the **Web API** and **Web Playback SDK** enabled.
2. Add a redirect URI for every address you'll use Muszi from, exactly as shown
   in Muszi's settings (gear icon), for example:
   - `https://maxlovesher.github.io/muszi/`
   - `http://127.0.0.1:5173/`
3. Paste the app's Client ID into Muszi's settings and press **Connect Spotify**.

Spotify's rules as of 2026: the app owner needs Premium, a development-mode app
allows up to 5 users (add them under *User Management*), `localhost` redirect
URIs aren't accepted, and song lists are only available for playlists you own
or collaborate on.

## Deploying

Pushing to `main` builds the site and publishes it to GitHub Pages
(`.github/workflows/deploy.yml`). In the repo's **Settings → Pages**, set
**Source** to **GitHub Actions** once.
