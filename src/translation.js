'use strict';

const GOOGLE_TRANSLATE_CHARACTER_LIMIT = 4500;
const DEEPL_REQUEST_BYTE_LIMIT = 120 * 1024;
const GOOGLE_LINE_SEPARATOR_TOKEN = '[[[YTM9F3A7C1D]]]';
const GOOGLE_LINE_SEPARATOR = `\n${GOOGLE_LINE_SEPARATOR_TOKEN}\n`;

function normalizeTranslationProvider(value) {
  return String(value || '').toLowerCase() === 'deepl' ? 'deepl' : 'google';
}

function normalizeDeepLAuthKey(value) {
  const authKey = String(value || '').trim();
  if (authKey.length < 20 || authKey.length > 200
    || !authKey.endsWith(':fx') || !/^[!-~]+$/u.test(authKey)) {
    throw new Error('A valid DeepL API Free key is required.');
  }
  return authKey;
}

function normalizeDeepLTargetLanguage(value) {
  const language = String(value || '').trim().replace(/_/g, '-').toLowerCase();
  if (language === 'zh' || /^zh-(?:hans|cn|sg)(?:-|$)/u.test(language)) {
    return 'ZH-HANS';
  }
  if (/^zh-(?:hant|tw|hk|mo)(?:-|$)/u.test(language)) {
    return 'ZH-HANT';
  }
  if (language === 'en' || /^en-(?:us|ca)(?:-|$)/u.test(language)) {
    return 'EN-US';
  }
  if (/^en-gb(?:-|$)/u.test(language)) {
    return 'EN-GB';
  }
  if (/^pt-br(?:-|$)/u.test(language)) {
    return 'PT-BR';
  }
  if (/^pt-pt(?:-|$)/u.test(language)) {
    return 'PT-PT';
  }
  if (/^es-419(?:-|$)/u.test(language)) {
    return 'ES-419';
  }
  if (/^fr-ca(?:-|$)/u.test(language)) {
    return 'FR-CA';
  }
  if (/^de-ch(?:-|$)/u.test(language)) {
    return 'DE-CH';
  }
  return language.match(/^[a-z]{2,3}/u)?.[0].toUpperCase() || 'EN-US';
}

function createGoogleLyricsBatches(lines, limit = GOOGLE_TRANSLATE_CHARACTER_LIMIT) {
  const batches = [];
  let current = [];
  let characters = 0;
  for (const line of lines) {
    const additionalCharacters = line.length + (current.length ? GOOGLE_LINE_SEPARATOR.length : 0);
    if (current.length && characters + additionalCharacters > limit) {
      batches.push(current);
      current = [];
      characters = 0;
    }
    current.push(line);
    characters += line.length + (current.length > 1 ? GOOGLE_LINE_SEPARATOR.length : 0);
  }
  if (current.length) {
    batches.push(current);
  }
  return batches;
}

function joinGoogleLyricsLines(lines) {
  return lines.join(GOOGLE_LINE_SEPARATOR);
}

function splitGoogleLyricsText(text, expectedLines) {
  const lines = String(text || '').replace(/\r/g, '')
    .split(/\s*\[\[\[\s*YTM9F3A7C1D\s*\]\]\]\s*/giu)
    .map((line) => line.trim());
  if (lines.length !== expectedLines) {
    throw new Error('Google Translate did not preserve the lyrics timeline.');
  }
  return lines;
}

function createDeepLPayload(lines, targetLanguage) {
  return {
    context: lines.join('\n'),
    preserve_formatting: true,
    split_sentences: 'nonewlines',
    target_lang: normalizeDeepLTargetLanguage(targetLanguage),
    text: lines
  };
}

function getDeepLPayloadSize(lines, targetLanguage) {
  return Buffer.byteLength(JSON.stringify(createDeepLPayload(lines, targetLanguage)), 'utf8');
}

function createDeepLLyricsPayloads(
  lines,
  targetLanguage,
  byteLimit = DEEPL_REQUEST_BYTE_LIMIT
) {
  const payloads = [];
  let current = [];
  for (const line of lines) {
    const candidate = [...current, line];
    if (current.length && getDeepLPayloadSize(candidate, targetLanguage) > byteLimit) {
      payloads.push(createDeepLPayload(current, targetLanguage));
      current = [line];
    } else {
      current = candidate;
    }
    if (getDeepLPayloadSize(current, targetLanguage) > byteLimit) {
      throw new Error('A lyrics line exceeds the DeepL request size limit.');
    }
  }
  if (current.length) {
    payloads.push(createDeepLPayload(current, targetLanguage));
  }
  return payloads;
}

module.exports = {
  DEEPL_REQUEST_BYTE_LIMIT,
  GOOGLE_LINE_SEPARATOR,
  GOOGLE_TRANSLATE_CHARACTER_LIMIT,
  createDeepLLyricsPayloads,
  createGoogleLyricsBatches,
  joinGoogleLyricsLines,
  normalizeDeepLAuthKey,
  normalizeDeepLTargetLanguage,
  normalizeTranslationProvider,
  splitGoogleLyricsText
};
