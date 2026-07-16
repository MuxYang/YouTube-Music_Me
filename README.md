# YouTube Music Me

[简体中文](README.zh.md)

An unofficial Electron desktop client for YouTube Music on Windows and Linux. It loads the official YouTube Music web app and adds native desktop integration, synchronized lyrics, translation, and configurable window behavior.

**App type:** Unofficial desktop client built with Electron and `WebContentsView`.

## Features

### Desktop integration

- Windows SMTC and Chromium Media Session metadata for songs and music videos, including title, artist or channel, artwork, playback state, and a track-relative timeline.
- Frameless main window with draggable navigation, native minimize, maximize/restore, and close controls.
- Configurable close behavior: ask every time, minimize to the system tray, or exit the app.
- Persistent YouTube Music session, PWA storage, cache, last URL, and window bounds.
- Separate Google sign-in window with the system frame and a session refresh after sign-in.
- Hover-wheel volume control in 5% increments.
- Custom thin scrollbar, Material-style context menu, and close confirmation dialog.

### Lyrics and translation

- Synchronized lyrics are disabled by default and are only requested after explicit consent.
- For regular tracks, NetEase Cloud Music is preferred when enabled, with LRCLIB as the fallback.
- For music videos, YouTube CC is preferred before the configured lyrics providers.
- Deterministic matching uses title and artist aliases, album, duration, bilingual titles, and `Artist - Song` video titles.
- Natural track changes clear the previous timeline and automatically trigger a fresh lyrics lookup.
- Lyrics can be translated with Google Translate or DeepL API Free; DeepL keys are encrypted with the operating system.
- Non-Simplified-Chinese users can optionally use aligned NetEase Chinese lyrics as the translation input, with the original lyrics as a fallback.
- A complete song is sent in one translation request whenever the provider limit allows it. Oversized input is split only at complete lyric-line boundaries.

### Interface

- Black startup sequence using the official YouTube Music platform logo, followed by a Material loading guard until the web app is ready.
- Custom `Other` settings category for transparency, animations, lyrics providers, translation, and close behavior.
- Optional translucent surfaces for settings, account menus, search suggestions, the player bar, and the active queue item.
- Custom YouTube-style setting pickers that close on settings-page scrolling.
- Injected interface translations are stored in `src/i18n/<lang>.json` and currently include `en-us`, `zh-cn`, and `zh-tw`.
- Changing the YouTube Music language or using a reload command restarts the app so the web interface and injected controls use the same locale.
- Terms and privacy links open in the system browser.

## Third-party services

Optional features may communicate with the following services after the corresponding setting and consent prompt are accepted:

- **LRCLIB:** receives track title, artist, album, and duration for synchronized-lyrics searches.
- **NetEase Cloud Music:** receives track search metadata and may provide original and translated lyrics.
- **Google Translate or DeepL:** receives lyric text when translation is requested. DeepL requires the user's own API Free key.

The repository does not bundle songs, videos, or lyrics. Availability and results depend on the upstream services.

## Development

```powershell
npm install
npm start
```

Run the tests with:

```powershell
npm test
```

## Packaging

Windows:

```powershell
npm run dist:win
```

Linux (run in a Linux environment):

```bash
npm ci
npm run dist:linux
```

Build artifacts are written to `release/`. Linux tray support depends on the desktop environment providing StatusNotifier/AppIndicator support.

## Disclaimer

YouTube Music Me is an independent, unofficial open-source project. It is not affiliated with, endorsed by, sponsored by, or otherwise associated with YouTube, Google, LRCLIB, NetEase Cloud Music, or DeepL. YouTube, YouTube Music, Google, and other product names and trademarks belong to their respective owners.

The app relies on third-party web pages and services that may change, limit access, or stop working without notice. Users are responsible for complying with applicable laws and the terms and privacy policies of every service they enable. The project is provided as-is, without warranty of service availability, content accuracy, or fitness for a particular purpose.
