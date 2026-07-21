'use strict';

const {
  buildLyricsSearchHints,
  createLyricsLookupCacheKey,
  isLikelyRomanizedLyrics,
  rankLyricsCandidates,
  selectLyricsSearchPairs
} = require('./lyrics');

function boundedSet(map, key, value, limit = 100) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    map.delete(map.keys().next().value);
  }
}

function formatLrclibResult(candidate, score) {
  return {
    albumName: String(candidate?.albumName || ''),
    artistName: String(candidate?.artistName || ''),
    duration: Number(candidate?.duration) || 0,
    id: Number(candidate?.id) || 0,
    matchScore: Math.round(score * 10) / 10,
    source: 'lrclib',
    syncedLyrics: String(candidate?.syncedLyrics || ''),
    trackName: String(candidate?.trackName || candidate?.name || '')
  };
}

function formatNeteaseCandidate(value) {
  const artists = Array.isArray(value?.artists)
    ? value.artists
    : Array.isArray(value?.ar) ? value.ar : [];
  const album = value?.album && typeof value.album === 'object'
    ? value.album
    : value?.al && typeof value.al === 'object' ? value.al : {};
  return {
    albumAliases: [album?.alia, album?.tns].flat().filter(Boolean),
    albumName: String(album?.name || ''),
    artistAliases: artists.flatMap((artist) => [
      ...(Array.isArray(artist?.alias) ? artist.alias : []),
      ...(Array.isArray(artist?.tns) ? artist.tns : []),
      ...(Array.isArray(artist?.trans) ? artist.trans : [])
    ]).filter(Boolean),
    artistName: artists.map((artist) => artist?.name || '').filter(Boolean).join(' / '),
    duration: (Number(value?.duration ?? value?.dt) || 0) / 1000,
    id: Number(value?.id) || 0,
    titleAliases: [value?.alias, value?.alia, value?.tns].flat().filter(Boolean),
    trackName: String(value?.name || '')
  };
}

function extractNeteaseLyrics(value) {
  const lrc = typeof value?.lrc?.lyric === 'string' ? value.lrc.lyric.trim() : '';
  if (lrc) {
    return lrc;
  }
  const yrc = typeof value?.yrc?.lyric === 'string' ? value.yrc.lyric : '';
  return yrc.split(/\r?\n/).map((line) => {
    const match = line.match(/^\[(\d+),\d+\]/);
    if (!match) {
      return '';
    }
    const milliseconds = Number(match[1]);
    const minutes = Math.floor(milliseconds / 60000);
    const seconds = ((milliseconds % 60000) / 1000).toFixed(3).padStart(6, '0');
    const text = line.replace(/^\[\d+,\d+\]/, '').replace(/\([^)]*\)/g, '').trim();
    return Number.isFinite(milliseconds)
      ? `[${String(minutes).padStart(2, '0')}:${seconds}]${text}`
      : '';
  }).filter(Boolean).join('\n').trim();
}

function formatLrcTimestamp(secondsValue) {
  const seconds = Math.max(0, Number(secondsValue) || 0);
  const minutes = Math.floor(seconds / 60);
  const remaining = (seconds % 60).toFixed(3).padStart(6, '0');
  return `[${String(minutes).padStart(2, '0')}:${remaining}]`;
}

function extractYouTubeCaptionLyrics(value) {
  const lines = [];
  for (const event of Array.isArray(value?.events) ? value.events : []) {
    const time = Number(event?.tStartMs) / 1000;
    const text = Array.isArray(event?.segs)
      ? event.segs.map((segment) => segment?.utf8 || '').join('').replace(/\s+/g, ' ').trim()
      : '';
    if (!Number.isFinite(time) || !text || text === '\u200b') {
      continue;
    }
    const previous = lines.at(-1);
    if (previous?.text === text && Math.abs(previous.time - time) < 0.25) {
      continue;
    }
    lines.push({ text, time });
  }
  return lines.map((line) => `${formatLrcTimestamp(line.time)}${line.text}`).join('\n');
}

function createLyricsService({ requestJson, getUserAgent = () => '' } = {}) {
  if (typeof requestJson !== 'function') {
    throw new TypeError('requestJson is required.');
  }
  const cache = new Map();
  const inFlight = new Map();

  const requestHeaders = (source) => ({
    ...(source === 'netease' ? { Referer: 'https://music.163.com/' } : {}),
    'User-Agent': getUserAgent() || 'YouTube Music Me/0.1.0'
  });

  async function lookupLrclib(track, hints) {
    const candidates = [];
    for (const pair of selectLyricsSearchPairs(hints, 3)) {
      const query = new URLSearchParams({
        artist_name: pair.artistName,
        track_name: pair.trackName
      });
      const response = await requestJson(`https://lrclib.net/api/search?${query}`, {
        headers: requestHeaders('lrclib'),
        timeoutMs: 12000
      });
      candidates.push(...(Array.isArray(response) ? response : response ? [response] : []));
      const ranked = rankLyricsCandidates(candidates, hints, 70);
      if (ranked[0]?.score >= 96) {
        break;
      }
    }
    const match = rankLyricsCandidates(candidates, hints, 70)[0];
    if (!match || isLikelyRomanizedLyrics(match.candidate.syncedLyrics, track)) {
      return null;
    }
    return formatLrclibResult(match.candidate, match.score);
  }

  async function lookupNetease(track, hints) {
    const candidates = new Map();
    for (const pair of selectLyricsSearchPairs(hints, 3)) {
      const query = new URLSearchParams({
        limit: '30',
        offset: '0',
        s: `${pair.trackName} ${pair.artistName}`,
        type: '1'
      });
      const response = await requestJson(`https://music.163.com/api/cloudsearch/pc?${query}`, {
        headers: requestHeaders('netease'),
        timeoutMs: 10000
      });
      for (const song of Array.isArray(response?.result?.songs) ? response.result.songs : []) {
        const candidate = formatNeteaseCandidate(song);
        if (candidate.id) {
          candidates.set(candidate.id, candidate);
        }
      }
      const ranked = rankLyricsCandidates([...candidates.values()], hints, 70, {
        durationToleranceSeconds: 35,
        requireSyncedLyrics: false
      });
      if (ranked[0]?.score >= 96) {
        break;
      }
    }

    let ranked = rankLyricsCandidates([...candidates.values()], hints, 70, {
      durationToleranceSeconds: 35,
      requireSyncedLyrics: false
    });
    if (!ranked.length) {
      for (const title of (hints.titles || []).slice(0, 2)) {
        const query = new URLSearchParams({
          limit: '30',
          offset: '0',
          s: title,
          type: '1'
        });
        const response = await requestJson(`https://music.163.com/api/cloudsearch/pc?${query}`, {
          headers: requestHeaders('netease'),
          timeoutMs: 10000
        });
        for (const song of Array.isArray(response?.result?.songs) ? response.result.songs : []) {
          const candidate = formatNeteaseCandidate(song);
          if (candidate.id) {
            candidates.set(candidate.id, candidate);
          }
        }
        ranked = rankLyricsCandidates([...candidates.values()], hints, 70, {
          durationToleranceSeconds: 35,
          requireSyncedLyrics: false
        });
        if (ranked.length) {
          break;
        }
      }
    }
    for (const match of ranked.slice(0, 4)) {
      const query = new URLSearchParams({
        id: String(match.candidate.id),
        kv: '-1',
        lv: '-1',
        rv: '-1',
        tv: '-1'
      });
      const value = await requestJson(`https://music.163.com/api/song/lyric?${query}`, {
        headers: requestHeaders('netease'),
        timeoutMs: 10000
      });
      const syncedLyrics = extractNeteaseLyrics(value);
      if (!syncedLyrics || isLikelyRomanizedLyrics(syncedLyrics, track)) {
        continue;
      }
      return {
        albumName: match.candidate.albumName,
        artistName: match.candidate.artistName,
        duration: match.candidate.duration,
        id: match.candidate.id,
        matchScore: Math.round(match.score * 10) / 10,
        source: 'netease',
        syncedLyrics,
        trackName: match.candidate.trackName,
        translationLyrics: typeof value?.tlyric?.lyric === 'string'
          ? value.tlyric.lyric.trim()
          : ''
      };
    }
    return null;
  }

  async function lookupYoutubeCaptions(track) {
    const language = String(track?.language || '').toLowerCase();
    const baseLanguage = language.split('-')[0];
    const selected = (Array.isArray(track?.captionTracks) ? track.captionTracks : [])
      .filter((caption) => caption?.baseUrl)
      .map((caption) => {
        let url;
        try {
          url = new URL(caption.baseUrl);
        } catch {
          return null;
        }
        const isCurrentYouTubeCaption = url.protocol === 'https:'
          && (url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com'))
          && url.pathname === '/api/timedtext'
          && !url.searchParams.has('tlang')
          && (!track?.videoId || url.searchParams.get('v') === String(track.videoId));
        if (!isCurrentYouTubeCaption) {
          return null;
        }
        const code = String(caption.languageCode || '').toLowerCase();
        const exactLanguage = code === language;
        const sameLanguageFamily = baseLanguage && code.split('-')[0] === baseLanguage;
        if (caption.kind === 'asr' && !exactLanguage && !sameLanguageFamily) {
          return null;
        }
        let score = caption.kind === 'asr' ? 0 : 100;
        if (exactLanguage) score += 240;
        else if (sameLanguageFamily) score += 180;
        if (caption.isDefault === true) score += 40;
        return { caption, score };
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score)[0]?.caption;
    if (!selected) {
      return null;
    }
    let url;
    try {
      url = new URL(selected.baseUrl);
    } catch {
      return null;
    }
    const isYouTube = url.protocol === 'https:'
      && (url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com'))
      && url.pathname === '/api/timedtext';
    if (!isYouTube) {
      return null;
    }
    url.searchParams.set('fmt', 'json3');
    const value = await requestJson(url.href, {
      headers: requestHeaders('youtube'),
      timeoutMs: 10000
    });
    const syncedLyrics = extractYouTubeCaptionLyrics(value);
    return syncedLyrics ? {
      artistName: String(track.artist || ''),
      duration: Number(track.duration) || 0,
      id: `${track.videoId}:${selected.vssId || selected.languageCode}`,
      source: 'youtube-cc',
      syncedLyrics,
      trackName: String(track.title || track.videoTitle || '')
    } : null;
  }

  async function resolve(track = {}, options = {}) {
    if (options.syncEnabled !== true) {
      return null;
    }
    const hints = buildLyricsSearchHints(track);
    const canSearchProviders = Boolean(hints.titles.length && hints.artists.length);
    const hasCaptions = Array.isArray(track?.captionTracks) && track.captionTracks.length > 0;
    if (!canSearchProviders && !hasCaptions) {
      return null;
    }
    const cacheKey = JSON.stringify({
      captions: (track?.captionTracks || []).slice(0, 10).map((caption) => [
        caption?.vssId,
        caption?.languageCode,
        caption?.kind,
        caption?.isDefault === true
      ]),
      musicVideo: track?.isMusicVideo === true,
      netease: options.neteaseEnabled === true,
      track: createLyricsLookupCacheKey(hints)
    });
    if (options.forceRefresh === true) {
      cache.delete(cacheKey);
    }
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }
    if (inFlight.has(cacheKey)) {
      return inFlight.get(cacheKey);
    }

    const request = (async () => {
      const configuredProviders = canSearchProviders && options.neteaseEnabled === true
        ? [
          { lookup: lookupNetease, name: 'netease' },
          { lookup: lookupLrclib, name: 'lrclib' }
        ]
        : canSearchProviders ? [{ lookup: lookupLrclib, name: 'lrclib' }] : [];
      const captionProvider = { lookup: lookupYoutubeCaptions, name: 'youtube-cc' };
      const providers = track?.isMusicVideo === true && hasCaptions
        ? [captionProvider, ...configuredProviders]
        : [
          ...configuredProviders,
          ...(hasCaptions ? [captionProvider] : [])
        ];
      const providerAttempts = [];
      let successfulProviders = 0;
      let providerFailures = 0;
      let lastError = null;
      for (const provider of providers) {
        providerAttempts.push(provider.name);
        try {
          const result = await provider.lookup(track, hints);
          successfulProviders += 1;
          if (result) {
            const retryRecommended = providerFailures > 0
              || (result.source === 'lrclib' && providerAttempts.includes('netease'));
            const resolved = {
              ...result,
              providerAttempts,
              retryRecommended
            };
            if (!resolved.retryRecommended) {
              boundedSet(cache, cacheKey, resolved);
            }
            return resolved;
          }
        } catch (error) {
          providerFailures += 1;
          lastError = error;
        }
      }
      if (!successfulProviders && lastError) {
        throw lastError;
      }
      const empty = {
        providerAttempts,
        retryRecommended: providerFailures > 0,
        source: '',
        syncedLyrics: ''
      };
      if (!empty.retryRecommended) {
        boundedSet(cache, cacheKey, empty);
      }
      return empty;
    })().finally(() => inFlight.delete(cacheKey));

    inFlight.set(cacheKey, request);
    return request;
  }

  return { resolve };
}

module.exports = {
  createLyricsService,
  extractNeteaseLyrics,
  extractYouTubeCaptionLyrics,
  formatNeteaseCandidate
};
