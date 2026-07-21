# YouTube Music Me

[简体中文](README.zh.md)

An unofficial Electron desktop client for YouTube Music on Windows, Linux, and macOS. It loads the official YouTube Music web app and adds native desktop integration, synchronized lyrics, translation, and configurable window behavior.

**App type:** Unofficial desktop client built with Electron and `WebContentsView`.

## Features

### Desktop integration

- Windows SMTC and Chromium Media Session metadata for songs and music videos, including title, artist or channel, artwork, playback state, and a track-relative timeline.
- Frameless main window with draggable navigation, native minimize, maximize/restore, and close controls.
- Configurable close behavior: ask every time, minimize to the system tray, or exit the app.
- Persistent YouTube Music session, PWA storage, cache, last URL, and window bounds.
- Separate Google sign-in window with the system frame and a session refresh after sign-in.
- Window-control IPC is accepted only from its intended renderer; closing sign-in or trusted child windows does not resurface a main window hidden in the tray.
- Hover-wheel volume control in 5% increments.
- Custom thin scrollbar, Material-style context menu, and close confirmation dialog.

### Lyrics and translation

- Synchronized lyrics are disabled by default and are only requested after explicit consent.
- For regular tracks, NetEase Cloud Music is preferred when enabled, with LRCLIB as the fallback.
- For music videos, YouTube CC is preferred before the configured lyrics providers. A current automatic-caption track remains eligible when its language differs from the display language, so it can be translated locally after retrieval.
- Deterministic matching uses title and artist aliases, album, duration, bilingual titles, and `Artist - Song` video titles.
- Natural track changes clear the previous timeline and automatically trigger a fresh lyrics lookup.
- The first valid playback snapshot initializes lyrics state at startup. Later title, artist, album, or alias stabilization creates a new lookup key instead of reusing an incomplete startup result.
- Transient timeouts, rate limits, and 5xx responses receive bounded retries. Existing fallback lyrics remain visible until a retry succeeds, and timestamp-only responses do not create blank lyric elements.
- Lyrics can be translated with Google Translate, DeepL API Free, or Microsoft Azure Translator. DeepL and Azure credentials are encrypted with the operating system.
- Non-Simplified-Chinese users can optionally use aligned NetEase Chinese lyrics as the translation input, with the original lyrics as a fallback.
- A complete song is sent in one translation request whenever the provider limit allows it. Oversized input is split only at complete lyric-line boundaries.
- Google Translate batches are sent sequentially and use bounded backoff when the network fails or a response does not preserve line separators.
- Azure Translator requests preserve each lyric line as a separate text item and retry transient network, rate-limit, and server failures.
- The translation action first compares a YouTube CC track's declared language with the YouTube Music display language. Other lyrics are detected locally with `franc-min`; same-language lyrics hide the translation button and are never sent to a translation provider.

#### Azure Translator setup

1. Create a Translator resource in the Azure portal and copy its subscription key. The Azure F0 tier currently includes 2 million translated characters per month; availability and quotas are governed by your Azure subscription and the [current Azure Translator pricing](https://azure.microsoft.com/pricing/details/cognitive-services/translator/).
2. In YouTube Music Me, open `Settings > Other > Lyrics translation provider`, select `Azure Translator`, and enter the subscription key.
3. Enter the resource region when Azure provides one. Keep the default global endpoint unless the Azure resource shows a custom `*.cognitiveservices.azure.com` endpoint.

The app validates the credentials with a one-word translation request before saving them. The key, region, and endpoint are stored together using Electron `safeStorage`; the raw key is not written to the settings JSON file.

### Interface

- Black startup sequence using the official YouTube Music platform logo, followed by a Material loading guard until the web app is ready.
- Custom `Other` settings category for transparency, animations, lyrics providers, translation, and close behavior.
- Optional translucent surfaces for settings, account menus, search suggestions, the player bar, and the active queue item.
- Custom YouTube-style setting pickers that close on settings-page scrolling.
- Injected dropdown entrance animations reveal with `clip-path`, leaving YouTube's positioning transforms and opacity rules untouched; translucent search suggestions use a locally injected backdrop blur.
- Injected interface translations are stored in `src/i18n/<lang>.json` and currently include `en-us`, `zh-cn`, and `zh-tw`.
- Changing the YouTube Music language or using a reload command restarts the app so the web interface and injected controls use the same locale.
- Terms and privacy links open in the system browser.

## Third-party services

Optional features may communicate with the following services after the corresponding setting and consent prompt are accepted:

- **LRCLIB:** receives track title, artist, album, and duration for synchronized-lyrics searches.
- **NetEase Cloud Music:** receives track search metadata and may provide original and translated lyrics.
- **Google Translate, DeepL, or Microsoft Azure Translator:** receives lyric text when translation is requested. DeepL and Azure require the user's own API credentials.

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

Desktop packages are built by the `Build desktop packages` GitHub Actions workflow. It runs after every commit push and every `v*` tag push, and can also be started manually from the Actions tab.

Linux builds run in a Debian 13 container. For a local Linux build:

```bash
npm ci
npm run dist:linux
```

The Linux build produces AppImage, Debian package, RPM package, and portable tarball artifacts. Build artifacts are written to `release/`. Linux tray support depends on the desktop environment providing StatusNotifier/AppIndicator support.

The workflow also builds an unsigned universal macOS DMG and ZIP. These experimental artifacts are not notarized and may require manual approval in macOS Gatekeeper.

## Maintenance warning

> [!WARNING]
> A substantial portion of this codebase was generated or rewritten with AI assistance. It may contain inconsistent abstractions, hidden coupling, redundant logic, insufficiently documented assumptions, or behavior that is difficult to reason about and maintain. Review the implementation carefully and run comprehensive tests before reusing, extending, or deploying it in another project.

## Disclaimer

YouTube Music Me is an independent, unofficial open-source project. It is not affiliated with, endorsed by, sponsored by, or otherwise associated with YouTube, Google, LRCLIB, NetEase Cloud Music, DeepL, or Microsoft Azure. YouTube, YouTube Music, Google, Microsoft Azure, and other product names and trademarks belong to their respective owners.

The app relies on third-party web pages and services that may change, limit access, or stop working without notice. Users are responsible for complying with applicable laws and the terms and privacy policies of every service they enable. The project is provided as-is, without warranty of service availability, content accuracy, or fitness for a particular purpose.
