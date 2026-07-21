'use strict';

const localeBundles = Object.freeze({
  'en-us': require('./en-us.json'),
  'zh-cn': require('./zh-cn.json'),
  'zh-tw': require('./zh-tw.json')
});

function normalizeUiLocale(value) {
  const language = String(value || '').trim().replace(/_/g, '-').toLowerCase();
  if (/^zh-(?:hant|tw|hk|mo)(?:-|$)/u.test(language)) {
    return 'zh-tw';
  }
  if (language === 'zh' || /^zh-(?:hans|cn|sg)(?:-|$)/u.test(language)) {
    return 'zh-cn';
  }
  return 'en-us';
}

function getLocaleBundle(locale) {
  return localeBundles[normalizeUiLocale(locale)];
}

function getAppStrings(locale) {
  return getLocaleBundle(locale).app;
}

function getAppearanceStrings(locale) {
  return getLocaleBundle(locale).appearance;
}

function getAzureConfigStrings(locale) {
  return getLocaleBundle(locale).azureConfig;
}

function getDeepLConfigStrings(locale) {
  return getLocaleBundle(locale).deeplConfig;
}

function parseYouTubeLanguagePreference(value) {
  const language = new URLSearchParams(String(value || '')).get('hl') || '';
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/iu.test(language) ? language : '';
}

module.exports = {
  getAppStrings,
  getAppearanceStrings,
  getAzureConfigStrings,
  getDeepLConfigStrings,
  getLocaleBundle,
  localeBundles,
  normalizeUiLocale,
  parseYouTubeLanguagePreference
};
