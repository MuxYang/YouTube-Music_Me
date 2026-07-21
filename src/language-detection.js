'use strict';

const MINIMUM_DETECTION_CHARACTERS = 20;
const MAXIMUM_DETECTION_CHARACTERS = 20000;
const MINIMUM_DETECTION_MARGIN = 0.01;

let detectorPromise = null;

function normalizeDetectionText(value) {
  const lines = Array.isArray(value) ? value : [value];
  const normalizedLines = lines
    .map((line) => String(line || '').replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  return [...new Map(normalizedLines.map((line) => [line.toLocaleLowerCase(), line])).values()]
    .join('\n')
    .slice(0, MAXIMUM_DETECTION_CHARACTERS);
}

async function getFrancAll() {
  if (!detectorPromise) {
    detectorPromise = import('franc-min').then(({ francAll }) => francAll);
  }
  return detectorPromise;
}

function normalizeDetectedLanguage(code) {
  const value = String(code || '').trim().toLowerCase();
  if (!value || value === 'und') {
    return '';
  }
  try {
    return new Intl.Locale(value).language || '';
  } catch {
    return '';
  }
}

async function detectLyricsLanguage(value) {
  const text = normalizeDetectionText(value);
  if ([...text].length < MINIMUM_DETECTION_CHARACTERS) {
    return { confidence: 0, language: '' };
  }
  try {
    const francAll = await getFrancAll();
    const matches = francAll(text, { minLength: MINIMUM_DETECTION_CHARACTERS });
    const [code, score = 0] = matches[0] || [];
    const confidence = Math.max(0, score - (matches[1]?.[1] || 0));
    const language = confidence >= MINIMUM_DETECTION_MARGIN
      ? normalizeDetectedLanguage(code)
      : '';
    return {
      confidence: language ? confidence : 0,
      language
    };
  } catch {
    return { confidence: 0, language: '' };
  }
}

module.exports = {
  MAXIMUM_DETECTION_CHARACTERS,
  MINIMUM_DETECTION_CHARACTERS,
  MINIMUM_DETECTION_MARGIN,
  detectLyricsLanguage,
  normalizeDetectedLanguage,
  normalizeDetectionText
};
