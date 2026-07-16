'use strict';

function parseClockValue(value) {
  const parts = String(value || '').trim().split(':').map(Number);
  if (!parts.length || parts.length > 3
    || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function parsePlayerBarTiming(value) {
  const clocks = String(value || '').match(/\b\d{1,3}:\d{2}(?::\d{2})?\b/g) || [];
  if (clocks.length < 2) {
    return null;
  }
  const position = parseClockValue(clocks[0]);
  const duration = parseClockValue(clocks.at(-1));
  if (!Number.isFinite(position) || !Number.isFinite(duration)
    || duration <= 0 || position > duration + 1) {
    return null;
  }
  return { duration, position: Math.min(position, duration) };
}

function normalizeTimingSource(source, duration) {
  const position = Number(source?.position);
  const sourceDuration = Number(source?.duration);
  if (!Number.isFinite(position) || position < 0) {
    return null;
  }

  if (Number.isFinite(sourceDuration) && sourceDuration > duration + 1) {
    // YouTube sometimes keeps a cumulative MSE timeline. Its current track is
    // the final duration-sized window, so derive the offset from this sample.
    const windowStart = sourceDuration - duration;
    const relativePosition = position - windowStart;
    if (relativePosition < -1 || relativePosition > duration + 1) {
      return null;
    }
    return Math.max(0, Math.min(relativePosition, duration));
  }
  return position <= duration + 1 ? Math.min(position, duration) : null;
}

function selectTrackTiming({ durationHint, media, player, playerBar } = {}) {
  const hintedDuration = Number(durationHint);
  const duration = Number.isFinite(hintedDuration) && hintedDuration > 0
    ? hintedDuration
    : [playerBar, player, media]
      .map((source) => Number(source?.duration))
      .find((value) => Number.isFinite(value) && value > 0);
  if (!Number.isFinite(duration) || duration <= 0) {
    return null;
  }

  for (const source of [player, media, playerBar]) {
    const position = normalizeTimingSource(source, duration);
    if (position !== null) {
      return { duration, position };
    }
  }
  return null;
}

function createTrackFingerprint(track = {}) {
  track ||= {};
  const videoId = String(track.videoId || '').trim();
  const title = String(track.title || '').normalize('NFKC').trim().toLowerCase();
  const artist = String(track.artist || '').normalize('NFKC').trim().toLowerCase();
  const duration = Math.round(Number(track.duration) || 0);
  if (!title || !artist || duration <= 0) {
    return '';
  }
  return JSON.stringify({ artist, duration, title, videoId });
}

function playerBarBelongsToTrack(playerBarVideoId, responseVideoId) {
  return Boolean(playerBarVideoId && responseVideoId && playerBarVideoId === responseVideoId);
}

function normalizeTrackTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s*[\[(【][^\])】]*(?:official|video|audio|lyric|visualizer|mv|pv|4k|hd)[^\])】]*[\])】]/giu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function playerBarTitleBelongsToTrack(playerBarTitle, responseTitle) {
  const response = normalizeTrackTitle(responseTitle);
  const playerBar = normalizeTrackTitle(playerBarTitle);
  if (!response || !playerBar) {
    return false;
  }
  if (response === playerBar) {
    return true;
  }
  return response.length >= 4 && playerBar.length >= 4
    && (response.includes(playerBar) || playerBar.includes(response));
}

function upgradeArtworkSource(source, size = 544) {
  if (typeof source !== 'string' || !/^https?:\/\//i.test(source)) {
    return '';
  }
  return source.replace(/=w\d+-h\d+/, `=w${size}-h${size}`);
}

function selectSquareArtwork(candidates = [], size = 544) {
  const ranked = candidates
    .map((candidate) => {
      const src = upgradeArtworkSource(candidate?.src, size);
      const width = Number(candidate?.width) || 0;
      const height = Number(candidate?.height) || 0;
      const ratio = width / height;
      if (!src || width <= 0 || height <= 0 || ratio < 0.8 || ratio > 1.25) {
        return null;
      }
      return {
        area: width * height,
        distanceFromSquare: Math.abs(1 - ratio),
        src
      };
    })
    .filter(Boolean)
    .sort((left, right) => (
      left.distanceFromSquare - right.distanceFromSquare
      || right.area - left.area
    ));

  return ranked.length
    ? [{ src: ranked[0].src, sizes: `${size}x${size}` }]
    : [];
}

function selectMediaArtwork(candidates = [], size = 544) {
  const square = selectSquareArtwork(candidates, size);
  if (square.length) {
    return square;
  }
  const fallback = candidates
    .map((candidate) => ({
      height: Number(candidate?.height) || 0,
      src: upgradeArtworkSource(candidate?.src, size),
      width: Number(candidate?.width) || 0
    }))
    .filter((candidate) => candidate.src && candidate.width > 0 && candidate.height > 0)
    .sort((left, right) => right.width * right.height - left.width * left.height)[0];
  return fallback ? [{
    sizes: `${fallback.width}x${fallback.height}`,
    src: fallback.src
  }] : [];
}

module.exports = {
  createTrackFingerprint,
  parseClockValue,
  parsePlayerBarTiming,
  playerBarBelongsToTrack,
  playerBarTitleBelongsToTrack,
  selectMediaArtwork,
  selectSquareArtwork,
  selectTrackTiming,
  upgradeArtworkSource
};
