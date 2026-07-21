'use strict';

const FEATURED_ARTIST_PATTERN = /\s*[（(]\s*(?:(?:feat(?:uring)?|ft)\.?\s*[:：]?\s+|(?:合作音乐人|合作音樂人|客串艺人|客串藝人|フィーチャリング)\s*[:：]\s*)([^()（）]{1,120})[）)]/giu;

function uniqueText(values, limit = 12) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const key = text.normalize('NFKC').toLocaleLowerCase();
    if (!text || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
    if (result.length === limit) {
      break;
    }
  }
  return result;
}

function stripPresentationNoise(value) {
  return String(value || '')
    .replace(FEATURED_ARTIST_PATTERN, ' ')
    .replace(/\s*[\[(【][^\])】]*(?:official|video|audio|lyric|visualizer|mv|pv|4k|hd)[^\])】]*[\])】]/giu, ' ')
    .replace(/\s*[-–—]\s*(?:official\s+)?(?:music\s+)?(?:video|audio|lyrics?|visualizer).*$/iu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFeaturedArtists(value) {
  const artists = [];
  for (const match of String(value || '').matchAll(FEATURED_ARTIST_PATTERN)) {
    artists.push(...String(match[1] || '').split(
      /\s*(?:,|，|、|&|＆|\band\b)\s*/iu
    ));
  }
  return uniqueText(artists, 8);
}

function splitDisplayTitle(value) {
  return stripPresentationNoise(value)
    .split(/\s+(?:[-–—|｜])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeComparable(value) {
  return stripPresentationNoise(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsJapanese(value) {
  return /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(String(value || ''));
}

function isLikelyRomanizedLyrics(value, track = {}) {
  track ||= {};
  const titles = [track.title, ...(track.titleAliases || [])]
    .map(stripPresentationNoise)
    .join(' ');
  if (!containsJapanese(titles)) {
    return false;
  }
  const text = String(value || '').replace(/\[[^\]]+\]/g, ' ').trim();
  if (!text || containsJapanese(text)) {
    return false;
  }
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const letters = (text.match(/\p{L}/gu) || []).length;
  return latin >= 20 && latin / Math.max(1, letters) >= 0.7;
}

function editSimilarity(left, right) {
  const a = normalizeComparable(left).replace(/\s/g, '').slice(0, 200);
  const b = normalizeComparable(right).replace(/\s/g, '').slice(0, 200);
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= b.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (a[row - 1] === b[column - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  const editScore = 1 - previous[b.length] / Math.max(a.length, b.length);
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  const containmentScore = shorter.length >= 3 && longer.includes(shorter)
    ? 0.75 + 0.2 * shorter.length / longer.length
    : 0;
  return Math.max(editScore, containmentScore);
}

function buildLyricsSearchHints(track = {}) {
  track ||= {};
  const rawTitles = uniqueText([
    track.title,
    track.videoTitle,
    ...(track.titleAliases || [])
  ], 8);
  const rawArtists = uniqueText([track.artist, ...(track.artistAliases || [])], 8);
  const titles = [];
  const artists = [...rawArtists];
  const inferredPairs = [];

  for (const rawTitle of rawTitles) {
    artists.push(...extractFeaturedArtists(rawTitle));
    const cleaned = stripPresentationNoise(rawTitle);
    const parts = splitDisplayTitle(rawTitle);
    titles.push(cleaned);
    if (parts.length === 2) {
      titles.push(parts[1], parts[0]);
      artists.push(parts[0]);
      inferredPairs.push({ artistName: parts[0], inferred: true, trackName: parts[1] });
    }
    for (const match of cleaned.matchAll(/[（(]([^()（）]{2,80})[）)]/gu)) {
      if (!/(?:feat|ft\.|version|ver\.|remix|cover|live|instrumental)/iu.test(match[1])) {
        titles.push(match[1]);
      }
    }
  }

  const normalizedTitles = uniqueText(titles, 10);
  const normalizedArtists = uniqueText(artists.flatMap((artist) => [
    artist,
    ...artist.split(/\s*(?:•|·|&|＆|,|，|\bfeat\.?\b|\bft\.?\b|\band\b)\s*/iu)
  ]), 10);
  const pairs = [];
  const pairKeys = new Set();
  const addPair = (pair) => {
    const trackName = String(pair?.trackName || '').trim();
    const artistName = String(pair?.artistName || '').trim();
    const key = `${normalizeComparable(trackName)}\0${normalizeComparable(artistName)}`;
    if (!trackName || !artistName) {
      return;
    }
    if (pairKeys.has(key)) {
      if (pair?.inferred === true) {
        const existing = pairs.find((value) => (
          normalizeComparable(value.trackName) === normalizeComparable(trackName)
          && normalizeComparable(value.artistName) === normalizeComparable(artistName)
        ));
        if (existing) {
          existing.inferred = true;
        }
      }
      return;
    }
    pairKeys.add(key);
    pairs.push({ artistName, inferred: pair?.inferred === true, trackName });
  };
  for (const title of normalizedTitles.slice(0, 5)) {
    for (const artist of normalizedArtists.slice(0, 4)) {
      addPair({ artistName: artist, trackName: title });
    }
  }
  inferredPairs.forEach(addPair);

  return {
    albums: uniqueText([track.album, ...(track.albumAliases || [])], 6),
    artists: normalizedArtists,
    duration: Number(track.duration) || 0,
    isJapanese: containsJapanese(normalizedTitles.join(' ')),
    pairs,
    titles: normalizedTitles,
    videoId: String(track.videoId || '')
  };
}

function createLyricsLookupCacheKey(hints = {}) {
  return JSON.stringify({
    artists: uniqueText(hints.artists || [], 4).map(normalizeComparable),
    duration: Math.round(Number(hints.duration) || 0),
    titles: uniqueText(hints.titles || [], 4).map(normalizeComparable),
    videoId: String(hints.videoId || '')
  });
}

function selectLyricsSearchPairs(hints = {}, limit = 4) {
  const selected = [];
  const primaryTitle = hints.titles?.[0];
  for (const artist of (hints.artists || []).slice(0, 3)) {
    selected.push(hints.pairs?.find((pair) => (
      pair.trackName === primaryTitle && pair.artistName === artist
    )));
  }
  for (const title of (hints.titles || []).slice(1, 3)) {
    selected.push(hints.pairs?.find((pair) => (
      pair.trackName === title && pair.artistName === hints.artists?.[0]
    )));
  }
  selected.push(hints.pairs?.find((pair) => pair.inferred));
  return selected.filter(Boolean).filter((pair, index, values) => (
    values.findIndex((value) => (
      value.trackName === pair.trackName && value.artistName === pair.artistName
    )) === index
  )).slice(0, Math.max(1, limit));
}

function bestSimilarity(values, hints) {
  let best = 0;
  for (const value of values) {
    for (const hint of hints) {
      best = Math.max(best, editSimilarity(value, hint));
    }
  }
  return best;
}

function scoreLyricsCandidate(candidate, hints, options = {}) {
  const requireSyncedLyrics = options.requireSyncedLyrics !== false;
  const syncedLyrics = String(candidate?.syncedLyrics || '');
  if (!candidate || (requireSyncedLyrics && !syncedLyrics.trim())) {
    return Number.NEGATIVE_INFINITY;
  }
  if (requireSyncedLyrics && hints.isJapanese
    && isLikelyRomanizedLyrics(syncedLyrics, { title: hints.titles.join(' ') })) {
    return Number.NEGATIVE_INFINITY;
  }

  const titleScore = bestSimilarity(uniqueText([
    candidate.trackName,
    candidate.name,
    ...(candidate.titleAliases || [])
  ]), hints.titles || []);
  const artistScore = bestSimilarity(uniqueText([
    candidate.artistName,
    ...(candidate.artistAliases || [])
  ]), hints.artists || []);
  const albumScore = bestSimilarity(uniqueText([
    candidate.albumName,
    ...(candidate.albumAliases || [])
  ]), hints.albums || []);
  const duration = Number(candidate.duration) || 0;
  const durationDifference = hints.duration > 0 && duration > 0
    ? Math.abs(hints.duration - duration)
    : null;

  if (titleScore < 0.62) {
    return Number.NEGATIVE_INFINITY;
  }
  const durationTolerance = Number(options.durationToleranceSeconds)
    || Math.max(15, hints.duration * 0.08);
  if (durationDifference !== null && durationDifference > durationTolerance) {
    return Number.NEGATIVE_INFINITY;
  }
  if (artistScore < 0.32) {
    return Number.NEGATIVE_INFINITY;
  }

  const durationScore = durationDifference === null
    ? 0.45
    : durationDifference <= 2 ? 1
      : durationDifference <= 6 ? 0.75
        : durationDifference <= 12 ? 0.4 : 0.1;
  return titleScore * 62
    + artistScore * 23
    + durationScore * 15
    + albumScore * 4
    + (titleScore === 1 ? 6 : 0)
    + (artistScore >= 0.95 ? 4 : 0);
}

function rankLyricsCandidates(candidates, hints, minimumScore = 70, options = {}) {
  const ranked = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const key = Number(candidate?.id) || JSON.stringify([
      candidate?.trackName,
      candidate?.artistName,
      candidate?.duration
    ]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const score = scoreLyricsCandidate(candidate, hints, options);
    if (score >= minimumScore) {
      ranked.push({ candidate, score });
    }
  }
  return ranked.sort((left, right) => right.score - left.score);
}

function selectBestLyricsCandidate(candidates, hints, minimumScore = 70, options = {}) {
  return rankLyricsCandidates(candidates, hints, minimumScore, options)[0] || null;
}

function parseClockDuration(value) {
  const parts = String(value || '').trim().split(':').map(Number);
  if (!parts.length || parts.length > 3
    || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return 0;
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function parseSyncedLyrics(value) {
  const parsed = [];
  for (const rawLine of String(value || '').split(/\r?\n/)) {
    const timestamps = [...rawLine.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const text = rawLine.replace(/\[[^\]]+\]/g, '').trim();
    for (const match of timestamps) {
      const fraction = match[3] || '0';
      const milliseconds = Number(fraction.padEnd(3, '0').slice(0, 3));
      parsed.push({
        text,
        time: Number(match[1]) * 60 + Number(match[2]) + milliseconds / 1000
      });
    }
  }
  return parsed
    .filter((line) => Number.isFinite(line.time))
    .sort((left, right) => left.time - right.time);
}

function isLyricsMetadataLine(value) {
  return /^\s*(?:作词|作詞|作曲|编曲|編曲|填词|填詞|词|詞|曲|歌手|演唱|翻唱|混音|母带|母帶|制作|製作|歌词|歌詞|翻译|翻譯|翻訳|lyrics?|lyricist|composer|arranger|vocal|vocals|mix(?:ed)?|master(?:ed)?|producer)\s*[:：]/iu
    .test(String(value || ''));
}

function alignSyncedTranslation(originalLines, translatedLyrics, toleranceSeconds = 1.5) {
  const originals = (Array.isArray(originalLines) ? originalLines : [])
    .filter((line) => line && String(line.text || '').trim());
  const translations = parseSyncedLyrics(translatedLyrics)
    .filter((line) => line.text);
  if (!originals.length || !translations.length) {
    return null;
  }

  const eligibleCount = originals.filter((line) => !isLyricsMetadataLine(line.text)).length;
  if (!eligibleCount) {
    return null;
  }

  let cursor = 0;
  let matched = 0;
  const aligned = originals.map((line) => {
    if (isLyricsMetadataLine(line.text)) {
      return '';
    }
    const time = Number(line.time);
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    while (cursor < translations.length
      && translations[cursor].time < time - toleranceSeconds) {
      cursor += 1;
    }
    for (let index = cursor; index < translations.length; index += 1) {
      const translation = translations[index];
      if (translation.time > time + toleranceSeconds) {
        break;
      }
      const distance = Math.abs(translation.time - time);
      if (distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    }
    if (bestIndex < 0 || bestDistance > toleranceSeconds) {
      return '';
    }
    cursor = bestIndex + 1;
    matched += 1;
    return translations[bestIndex].text;
  });

  return matched >= Math.max(1, Math.ceil(eligibleCount * 0.6)) ? aligned : null;
}

function selectLyricsTranslationSource(originalLines, translatedLyrics, enabled = false) {
  const originals = (Array.isArray(originalLines) ? originalLines : [])
    .map((line) => String(line?.text || '').trim());
  if (!enabled || !originals.length || originals.some((line) => !line)) {
    return { kind: 'original', lines: originals };
  }
  const aligned = alignSyncedTranslation(originalLines, translatedLyrics);
  if (!aligned || aligned.length !== originals.length) {
    return { kind: 'original', lines: originals };
  }
  const incomplete = aligned.some((line, index) => (
    !isLyricsMetadataLine(originals[index]) && !line
  ));
  if (incomplete) {
    return { kind: 'original', lines: originals };
  }
  return {
    kind: 'netease-zh',
    lines: aligned.map((line, index) => line || originals[index])
  };
}

function canSeekLyricsTimeline({
  currentKey,
  currentState,
  currentVideoId,
  expectedKey,
  expectedVideoId,
  lyricsVideoId
} = {}) {
  return currentState === 'ready'
    && Boolean(expectedKey)
    && Boolean(expectedVideoId)
    && expectedKey === currentKey
    && expectedVideoId === currentVideoId
    && expectedVideoId === lyricsVideoId;
}

function normalizeTranslationLanguage(value) {
  const language = String(value || '').trim().replace(/_/g, '-').toLocaleLowerCase();
  if (language === 'zh' || /^zh-(?:hans|cn|sg)/u.test(language)) {
    return 'zh-CN';
  }
  if (/^zh-(?:hant|tw|hk|mo)/u.test(language)) {
    return 'zh-TW';
  }
  return language.match(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?/u)?.[0] || 'en';
}

module.exports = {
  alignSyncedTranslation,
  buildLyricsSearchHints,
  canSeekLyricsTimeline,
  containsJapanese,
  createLyricsLookupCacheKey,
  isLikelyRomanizedLyrics,
  isLyricsMetadataLine,
  normalizeComparable,
  normalizeTranslationLanguage,
  parseClockDuration,
  parseSyncedLyrics,
  rankLyricsCandidates,
  scoreLyricsCandidate,
  selectLyricsTranslationSource,
  selectLyricsSearchPairs,
  selectBestLyricsCandidate,
  stripPresentationNoise,
  textSimilarity: editSimilarity
};
