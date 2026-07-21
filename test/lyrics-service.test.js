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
  assert.equal(result.retryRecommended, true);
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

test('accepts a NetEase canonical artist alias when YouTube localizes the artist', async () => {
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
    artistAliases: ['Rick Astley'],
    duration: 213,
    title: 'Never Gonna Give You Up',
    videoId: 'video-localized'
  }, { syncEnabled: true, neteaseEnabled: true });
  assert.equal(result.source, 'netease');
  assert.deepEqual(result.providerAttempts, ['netease']);
});

test('does not fetch lyrics for a same-title NetEase song by another artist', async () => {
  const calls = [];
  const service = createLyricsService({
    requestJson: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      if (parsed.pathname === '/api/cloudsearch/pc') {
        return {
          result: {
            songs: [{
              al: { name: 'Unrelated album' },
              ar: [{ name: '逍遥游之' }],
              dt: 212000,
              id: 31,
              name: 'Lost in the Noise'
            }]
          }
        };
      }
      if (parsed.hostname === 'lrclib.net') {
        return [];
      }
      throw new Error(`Unexpected request: ${url}`);
    }
  });
  const result = await service.resolve({
    artist: 'Fenruri',
    duration: 212,
    title: 'Lost in the Noise',
    titleAliases: ['Lost in the Noise（合作音乐人：KASANE TETO）'],
    videoId: 'lost-in-the-noise'
  }, { syncEnabled: true, neteaseEnabled: true });
  assert.equal(result.source, '');
  assert.equal(calls.some((url) => url.pathname === '/api/song/lyric'), false);
  assert.equal(calls.some((url) => url.hostname === 'lrclib.net'), true);
});

test('does not cache an LRCLIB fallback caused by a NetEase request failure', async () => {
  let neteaseSearches = 0;
  const service = createLyricsService({
    requestJson: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/cloudsearch/pc') {
        neteaseSearches += 1;
        if (neteaseSearches === 1) {
          throw new Error('Transient NetEase failure');
        }
        return neteaseSearchMatch;
      }
      if (parsed.pathname === '/api/song/lyric') {
        return { lrc: { lyric: '[00:01.00]NetEase recovered' } };
      }
      return lrclibMatch;
    }
  });
  const options = { syncEnabled: true, neteaseEnabled: true };
  const first = await service.resolve(track, options);
  const second = await service.resolve(track, options);
  assert.equal(first.source, 'lrclib');
  assert.equal(first.retryRecommended, true);
  assert.equal(second.source, 'netease');
  assert.equal(neteaseSearches, 2);
});

test('retries NetEase with the title alone when artist-qualified searches miss', async () => {
  const searches = [];
  const service = createLyricsService({
    requestJson: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/cloudsearch/pc') {
        const search = parsed.searchParams.get('s');
        searches.push(search);
        if (search === '春めく') {
          return {
            result: {
              songs: [{
                al: { name: '春めく' },
                ar: [{ alias: ['Nanatsukaze'], name: 'ナナツカゼ' }],
                dt: 185500,
                id: 2043976339,
                name: '春めく'
              }]
            }
          };
        }
        return { result: { songs: [] } };
      }
      if (parsed.pathname === '/api/song/lyric') {
        return { lrc: { lyric: '[00:01.00]春の歌詞' } };
      }
      return [];
    }
  });

  const result = await service.resolve({
    artist: 'Nanatsukaze',
    duration: 185.5,
    title: '春めく',
    videoId: 'harumeku'
  }, { syncEnabled: true, neteaseEnabled: true });

  assert.equal(result.source, 'netease');
  assert.equal(result.id, 2043976339);
  assert.equal(result.artistName, 'ナナツカゼ');
  assert.equal(searches.some((search) => search.includes('Nanatsukaze')), true);
  assert.equal(searches.at(-1), '春めく');
});

test('uses YouTube CC before configured providers for a music video', async () => {
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
  assert.deepEqual(result.providerAttempts, ['youtube-cc']);
  assert.match(result.syncedLyrics, /\[00:01\.250\]Caption line/);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls.at(-1)).searchParams.get('fmt'), 'json3');
});

test('ignores stale and unrelated-language automatic caption tracks', async () => {
  const calls = [];
  const service = createLyricsService({
    requestJson: async (url) => {
      calls.push(new URL(url));
      return [];
    }
  });
  const result = await service.resolve({
    ...track,
    captionTracks: [
      {
        baseUrl: 'https://www.youtube.com/api/timedtext?v=previous-video&lang=en',
        kind: '',
        languageCode: 'en',
        vssId: '.en'
      },
      {
        baseUrl: 'https://www.youtube.com/api/timedtext?v=video-1&lang=vi',
        kind: 'asr',
        languageCode: 'vi',
        vssId: 'a.vi'
      }
    ],
    isMusicVideo: true,
    language: 'zh-CN'
  }, { syncEnabled: true, neteaseEnabled: false });
  assert.equal(result.source, '');
  assert.deepEqual(result.providerAttempts, ['youtube-cc', 'lrclib']);
  assert.equal(calls.some((url) => url.hostname.endsWith('youtube.com')), false);
  assert.equal(calls.every((url) => url.hostname === 'lrclib.net'), true);
});

test('falls back from music-video CC to NetEase and then LRCLIB', async () => {
  const hosts = [];
  const service = createLyricsService({
    requestJson: async (url) => {
      const parsed = new URL(url);
      hosts.push(parsed.hostname);
      if (parsed.hostname.endsWith('youtube.com')) {
        return { events: [] };
      }
      if (parsed.pathname === '/api/cloudsearch/pc') {
        return neteaseSearchMatch;
      }
      if (parsed.pathname === '/api/song/lyric') {
        return { lrc: { lyric: '[00:01.00]NetEase fallback line' } };
      }
      return lrclibMatch;
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
  }, { syncEnabled: true, neteaseEnabled: true });
  assert.equal(result.source, 'netease');
  assert.deepEqual(result.providerAttempts, ['youtube-cc', 'netease']);
  assert.equal(hosts[0], 'www.youtube.com');
  assert.equal(hosts.slice(1).every((host) => host === 'music.163.com'), true);
});
