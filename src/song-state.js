'use strict';

function validNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validBarPosition(playerBar, duration) {
  const position = validNumber(playerBar?.position);
  const barDuration = validNumber(playerBar?.duration);
  if (position === null || barDuration === null || barDuration <= 0
    || position < 0 || position > duration + 1
    || Math.abs(barDuration - duration) > 3) {
    return null;
  }
  return Math.min(position, duration);
}

function initialOffset(source, duration, barPosition) {
  const raw = validNumber(source?.position);
  const sourceDuration = validNumber(source?.duration);
  if (raw === null || raw < 0) {
    return null;
  }
  if (barPosition !== null) {
    return raw - barPosition;
  }
  if (raw <= duration + 1) {
    return 0;
  }
  if (sourceDuration !== null && sourceDuration > duration + 1) {
    return sourceDuration - duration;
  }
  return raw;
}

function transitionOffset(source, duration, barPosition, previousSource, previousDuration) {
  const raw = validNumber(source?.position);
  if (raw === null || raw < 0) {
    return null;
  }
  if (barPosition !== null) {
    return raw - barPosition;
  }

  const previousOffset = validNumber(previousSource?.offset);
  if (previousOffset !== null && previousDuration > 0) {
    const expectedOffset = previousOffset + previousDuration;
    const expectedPosition = raw - expectedOffset;
    if (expectedPosition >= -2 && expectedPosition <= duration + 2) {
      return expectedOffset;
    }
  }
  return raw <= duration + 1 ? 0 : raw;
}

function readRelativeSource(source, duration, barPosition, previousSource, changed, previousDuration) {
  const raw = validNumber(source?.position);
  if (raw === null || raw < 0) {
    return null;
  }
  let offset = changed
    ? transitionOffset(source, duration, barPosition, previousSource, previousDuration)
    : validNumber(previousSource?.offset);
  if (offset === null) {
    offset = initialOffset(source, duration, barPosition);
  }
  let position = raw - offset;

  if (!changed && barPosition !== null && Math.abs(position - barPosition) > 1.5) {
    offset = raw - barPosition;
    position = barPosition;
  } else if ((position < -1 || position > duration + 1) && raw <= duration + 1) {
    offset = 0;
    position = raw;
  }
  if (position < -1 || position > duration + 1) {
    return { lastRaw: raw, offset, position: null };
  }
  return {
    lastRaw: raw,
    offset,
    position: Math.max(0, Math.min(position, duration))
  };
}

function createSongStateMonitor() {
  let state = null;
  let revision = 0;

  function observe(sample = {}) {
    const videoId = String(sample.videoId || '');
    const hintedDuration = validNumber(sample.durationHint);
    const duration = hintedDuration > 0
      ? hintedDuration
      : [sample.playerBar, sample.player, sample.media]
        .map((source) => validNumber(source?.duration))
        .find((value) => value > 0);
    if (!videoId || !Number.isFinite(duration) || duration <= 0) {
      return null;
    }

    const initial = state === null;
    const trackChanged = Boolean(state && state.videoId !== videoId);
    if (initial || trackChanged) {
      revision += 1;
    }
    const sameTrackState = !trackChanged && state?.videoId === videoId ? state : null;
    const previousTrackState = trackChanged ? state : null;
    const barPosition = validBarPosition(sample.playerBar, duration);
    const sources = {};
    for (const name of ['player', 'media']) {
      sources[name] = readRelativeSource(
        sample[name],
        duration,
        barPosition,
        sameTrackState?.sources?.[name] || previousTrackState?.sources?.[name],
        trackChanged,
        previousTrackState?.duration || 0
      );
    }

    const position = sources.player?.position
      ?? sources.media?.position
      ?? barPosition;
    state = {
      duration,
      revision,
      sources,
      videoId
    };
    return {
      initial,
      revision,
      timing: Number.isFinite(position) ? { duration, position } : null,
      trackChanged
    };
  }

  return {
    observe,
    reset() {
      state = null;
      revision = 0;
    }
  };
}

module.exports = { createSongStateMonitor };
