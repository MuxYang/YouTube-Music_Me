'use strict';

const GOOGLE_TRANSLATE_CHARACTER_LIMIT = 4500;
const AZURE_TRANSLATE_CHARACTER_LIMIT = 45000;
const AZURE_TRANSLATE_TEXT_LIMIT = 100;
const DEEPL_REQUEST_BYTE_LIMIT = 120 * 1024;
const GOOGLE_LINE_SEPARATOR_TOKEN = '[[[YTM9F3A7C1D]]]';
const GOOGLE_LINE_SEPARATOR = `\n${GOOGLE_LINE_SEPARATOR_TOKEN}\n`;

function normalizeTranslationProvider(value) {
  const provider = String(value || '').toLowerCase();
  return ['deepl', 'azure'].includes(provider) ? provider : 'google';
}

function normalizeAzureTranslatorKey(value) {
  const key = String(value || '').trim();
  if (key.length < 16 || key.length > 128 || !/^[!-~]+$/u.test(key)) {
    throw new Error('A valid Azure Translator subscription key is required.');
  }
  return key;
}

function normalizeAzureTranslatorRegion(value) {
  const region = String(value || '').trim().toLowerCase();
  if (region && !/^[a-z0-9-]{2,64}$/u.test(region)) {
    throw new Error('The Azure Translator region is invalid.');
  }
  return region;
}

function normalizeAzureTranslatorEndpoint(value) {
  const raw = String(value || '').trim() || 'https://api.cognitive.microsofttranslator.com';
  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error('The Azure Translator endpoint is invalid.');
  }
  const hostname = endpoint.hostname.toLowerCase();
  const translatorEndpoint = /^api(?:-(?:apc|eur|nam))?\.cognitive\.microsofttranslator\.com$/u
    .test(hostname);
  const trusted = translatorEndpoint
    || hostname.endsWith('.cognitiveservices.azure.com');
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || !trusted) {
    throw new Error('The Azure Translator endpoint must be an HTTPS Azure endpoint.');
  }
  const pathname = endpoint.pathname.replace(/\/+$/u, '').toLowerCase();
  const allowedPaths = translatorEndpoint
    ? ['', '/translate']
    : ['', '/translator/text/v3.0', '/translator/text/v3.0/translate'];
  if (!allowedPaths.includes(pathname)) {
    throw new Error('The Azure Translator endpoint path is invalid.');
  }
  return endpoint.origin;
}

function createAzureTranslatorUrl(endpoint, targetLanguage) {
  const normalizedEndpoint = normalizeAzureTranslatorEndpoint(endpoint);
  const url = new URL(normalizedEndpoint);
  const translatorEndpoint = /^api(?:-(?:apc|eur|nam))?\.cognitive\.microsofttranslator\.com$/u
    .test(url.hostname.toLowerCase());
  url.pathname = translatorEndpoint
    ? '/translate'
    : '/translator/text/v3.0/translate';
  url.searchParams.set('api-version', '3.0');
  url.searchParams.set('to', normalizeAzureTargetLanguage(targetLanguage));
  return url.href;
}

function normalizeAzureTargetLanguage(value) {
  const language = String(value || '').trim().replace(/_/g, '-').toLowerCase();
  if (language === 'zh' || /^zh-(?:hans|cn|sg)(?:-|$)/u.test(language)) {
    return 'zh-Hans';
  }
  if (/^zh-(?:hant|tw|hk|mo)(?:-|$)/u.test(language)) {
    return 'zh-Hant';
  }
  return language.match(/^[a-z]{2,3}/u)?.[0] || 'en';
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

function createAzureTranslatorBatches(
  lines,
  characterLimit = AZURE_TRANSLATE_CHARACTER_LIMIT,
  textLimit = AZURE_TRANSLATE_TEXT_LIMIT
) {
  const batches = [];
  let current = [];
  let characters = 0;
  for (const line of lines) {
    if (current.length
      && (current.length >= textLimit || characters + line.length > characterLimit)) {
      batches.push(current);
      current = [];
      characters = 0;
    }
    if (line.length > characterLimit) {
      throw new Error('A lyrics line exceeds the Azure Translator request limit.');
    }
    current.push(line);
    characters += line.length;
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
  AZURE_TRANSLATE_CHARACTER_LIMIT,
  AZURE_TRANSLATE_TEXT_LIMIT,
  DEEPL_REQUEST_BYTE_LIMIT,
  GOOGLE_LINE_SEPARATOR,
  GOOGLE_TRANSLATE_CHARACTER_LIMIT,
  createAzureTranslatorUrl,
  createAzureTranslatorBatches,
  createDeepLLyricsPayloads,
  createGoogleLyricsBatches,
  joinGoogleLyricsLines,
  normalizeAzureTranslatorEndpoint,
  normalizeAzureTranslatorKey,
  normalizeAzureTranslatorRegion,
  normalizeAzureTargetLanguage,
  normalizeDeepLAuthKey,
  normalizeDeepLTargetLanguage,
  normalizeTranslationProvider,
  splitGoogleLyricsText
};
