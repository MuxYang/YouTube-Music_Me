'use strict';

const API_AUTH_COOKIES = new Set([
  'APISID',
  'SAPISID',
  '__Secure-1PAPISID',
  '__Secure-3PAPISID'
]);
const SESSION_AUTH_COOKIES = new Set([
  'HSID',
  'SID',
  'SSID',
  '__Secure-1PSID',
  '__Secure-3PSID'
]);

function getUrl(rawUrl) {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function isGoogleAuthUrl(rawUrl) {
  const url = getUrl(rawUrl);
  return Boolean(url && url.protocol === 'https:' && (
    url.hostname === 'google.com' || url.hostname.endsWith('.google.com')
  ));
}

function isYouTubeUrl(rawUrl) {
  const url = getUrl(rawUrl);
  return Boolean(url && url.protocol === 'https:' && (
    url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com')
  ));
}

function isYouTubeSignInUrl(rawUrl) {
  const url = getUrl(rawUrl);
  return Boolean(url && isYouTubeUrl(url.href) && (
    url.pathname === '/signin' || url.pathname.startsWith('/signin/')
  ));
}

function isAuthenticationEntryUrl(rawUrl) {
  return isGoogleAuthUrl(rawUrl) || isYouTubeSignInUrl(rawUrl) || isSignOutUrl(rawUrl);
}

function isSignOutUrl(rawUrl) {
  const url = getUrl(rawUrl);
  return Boolean(url && (isGoogleAuthUrl(rawUrl) || isYouTubeUrl(rawUrl))
    && /^\/(?:accounts\/)?(?:logout|signout)(?:\/|$)/iu.test(url.pathname));
}

function isAuthenticationReturnUrl(rawUrl) {
  const url = getUrl(rawUrl);
  return Boolean(url && isYouTubeUrl(rawUrl) && !isAuthenticationEntryUrl(rawUrl)
    && (url.hostname === 'music.youtube.com'
      || (['www.youtube.com', 'youtube.com'].includes(url.hostname) && url.pathname === '/')));
}

function isGoogleAccountCookie(cookie) {
  const name = String(cookie?.name || '');
  return API_AUTH_COOKIES.has(name) || SESSION_AUTH_COOKIES.has(name);
}

function hasGoogleAccountCookies(cookies) {
  const names = new Set((Array.isArray(cookies) ? cookies : []).map((cookie) => cookie?.name));
  return [...API_AUTH_COOKIES].some((name) => names.has(name))
    && [...SESSION_AUTH_COOKIES].some((name) => names.has(name));
}

module.exports = {
  hasGoogleAccountCookies,
  isAuthenticationEntryUrl,
  isAuthenticationReturnUrl,
  isGoogleAccountCookie,
  isGoogleAuthUrl,
  isSignOutUrl,
  isYouTubeSignInUrl,
  isYouTubeUrl
};
