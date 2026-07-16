'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLyricsService } = require('../src/lyrics-service');

const track = {
  artist: 'Example Artist',
  duration: 200,
  title: 'Example Song',
  videoId: 'video-1'
};

const lrclibMatch = [{
  albumName: 'Example Album',
  artistName: 'Example Artist',
  duration: 200,
  id: 10,
  syncedLyrics: '[00:01.00]LRCLIB line',
  trackName: 'Example Song'
}];

const neteaseSearchMatch = {
  result: {
    songs: [{
      al: { name: 'Example Album' },
      ar: [{ name: 'Example Artist' }],
      dt: 200000,
      id: 20,
      name: 'Example Song'
    }]
  }
};

test('does not contact a provider while synchronized lyrics are disabled', async () => {
  const calls = [];
  const service = createLyricsService({
    requestJson: async (url) => calls.push(url)
  });
  assert.equal(await service.resolve(track, { syncEnabled: false }), null);
  assert.deepEqual(calls, []);
});

test('uses LRCLIB directly when NetEase is disabled', async () => {
  const calls = [];
  const service = createLyricsService({
    requestJson: async (url) => {
      calls.push(url);
      return lrclibMatch;
    }
  });
  const result = await service.resolve(track, { syncEnabled: true, neteaseEnabled: false });
  assert.equal(result.source, 'lrclib');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]).hostname, 'lrclib.net');
});

test('uses NetEase without contacting LRCLIB when NetEase finds lyrics', async () => {
  const calls = [];
  const service = createLyricsService({
    requestJson: async (url) => {
      calls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === '/api/cloudsearch/pc') {
        return neteaseSearchMatch;
      }
      if (parsed.pathname === '/api/song/lyric') {
        return { lrc: { lyric: '[00:01.00]NetEase line' } };
      }
      throw new Error(`Unexpected request: ${url}`);
    }
  });
  const result = await service.resolve(track, { syncEnabled: true, neteaseEnabled: true });
  assert.equal(result.source, 'netease');
  assert.deepEqual(result.providerAttempts, ['netease']);
  assert.equal(calls.every((url) => new URL(url).hostname === 'music.163.com'), true);
});

test('falls back to LRCLIB when NetEase has no matching song', async () => {
  const hosts = [];
  const service = createLyricsService({
    requestJson: async (url) => {
      const parsed = new URL(url);
      hosts.push(parsed.hostname);
      return parsed.hostname === 'music.163.com' ? { result: { songs: [] } } : lrclibMatch;
    }
  });
  const result = await service.resolve(track, { syncEnabled: true, neteaseEnabled: true });
  assert.equal(result.source, 'lrclib');
  assert.deepEqual(result.providerAttempts, ['netease', 'lrclib']);
  assert.equal(hosts[0], 'music.163.com');
  assert.equal(hosts.at(-1), 'lrclib.net');
});

test('falls back to LRCLIB when the NetEase request fails', async () => {
  const service = createLyricsService({
    requestJson: async (url) => {
      if (new URL(url).hostname === 'music.163.com') {
        throw new Error('NetEase unavailable');
      }
      return lrclibMatch;
    }
  });
  const result = await service.resolve(track, { syncEnabled: true, neteaseEnabled: true });
  assert.equal(result.source, 'lrclib');
});

test('deduplicates concurrent lookups and caches an empty result', async () => {
  let requests = 0;
  const service = createLyricsService({
    requestJson: async () => {
      requests += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return [];
    }
  });
  const options = { syncEnabled: true, neteaseEnabled: false };
  const [first, second] = await Promise.all([
    service.resolve(track, options),
    service.resolve(track, options)
  ]);
  assert.equal(first.source, '');
  assert.equal(second.source, '');
  const requestsAfterFirstLookup = requests;
  assert.equal((await service.resolve(track, options)).source, '');
  assert.equal(requests, requestsAfterFirstLookup);
});

test('force refresh performs the preferred-provider request again', async () => {
  let requests = 0;
  const service = createLyricsService({
    requestJson: async (url) => {
      requests += 1;
      return new URL(url).pathname === '/api/cloudsearch/pc'
        ? neteaseSearchMatch
        : { lrc: { lyric: '[00:01.00]NetEase line' } };
    }
  });
  const options = { syncEnabled: true, neteaseEnabled: true };
  await service.resolve(track, options);
  const cachedRequestCount = requests;
  await service.resolve(track, options);
  assert.equal(requests, cachedRequestCount);
  await service.resolve(track, { ...options, forceRefresh: true });
  assert.equal(requests > cachedRequestCount, true);
});

test('accepts a NetEase title-duration match when YouTube localizes the artist', async () => {
  const service = createLyricsService({
    requestJson: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/cloudsearch/pc') {
        return {
          result: {
            songs: [{
              al: { name: 'Whenever You Need Somebody' },
              ar: [{ name: 'Rick Astley' }],
              dt: 221000,
              id: 30,
              name: 'Never Gonna Give You Up'
            }]
          }
        };
      }
      return { lrc: { lyric: '[00:01.00]NetEase localized artist match' } };
    }
  });
  const result = await service.resolve({
    artist: '理查德·艾斯利',
    duration: 213,
    title: 'Never Gonna Give You Up',
    videoId: 'video-localized'
  }, { syncEnabled: true, neteaseEnabled: true });
  assert.equal(result.source, 'netease');
  assert.deepEqual(result.providerAttempts, ['netease']);
});

test('uses YouTube CC when configured lyrics providers have no result', async () => {
  const calls = [];
  const service = createLyricsService({
    requestJson: async (url) => {
      calls.push(url);
      const parsed = new URL(url);
      if (parsed.hostname === 'lrclib.net') {
        return [];
      }
      return {
        events: [
          { tStartMs: 1250, segs: [{ utf8: 'Caption line' }] },
          { tStartMs: 3500, segs: [{ utf8: 'Second line' }] }
        ]
      };
    }
  });
  const result = await service.resolve({
    ...track,
    captionTracks: [{
      baseUrl: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en',
      kind: '',
      languageCode: 'en',
      vssId: '.en'
    }],
    isMusicVideo: true,
    language: 'en-US'
  }, { syncEnabled: true, neteaseEnabled: false });
  assert.equal(result.source, 'youtube-cc');
  assert.deepEqual(result.providerAttempts, ['lrclib', 'youtube-cc']);
  assert.match(result.syncedLyrics, /\[00:01\.250\]Caption line/);
  assert.equal(new URL(calls.at(-1)).searchParams.get('fmt'), 'json3');
});
