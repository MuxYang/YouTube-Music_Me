'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasGoogleAccountCookies,
  isAuthenticationEntryUrl,
  isYouTubeSignInUrl,
  isYouTubeUrl
} = require('../src/auth');

test('recognizes Google and YouTube sign-in entry URLs', () => {
  assert.equal(isAuthenticationEntryUrl('https://accounts.google.com/ServiceLogin'), true);
  assert.equal(isAuthenticationEntryUrl('https://www.youtube.com/signin?app=desktop'), true);
  assert.equal(isAuthenticationEntryUrl('https://music.youtube.com/watch?v=test'), false);
  assert.equal(isYouTubeSignInUrl('https://music.youtube.com/signin/complete'), true);
  assert.equal(isYouTubeUrl('https://www.youtube.com/'), true);
});

test('requires both API and session cookies before completing login', () => {
  assert.equal(hasGoogleAccountCookies([{ name: 'SAPISID' }]), false);
  assert.equal(hasGoogleAccountCookies([{ name: 'SID' }]), false);
  assert.equal(hasGoogleAccountCookies([
    { name: '__Secure-1PAPISID' },
    { name: '__Secure-1PSID' }
  ]), true);
  assert.equal(hasGoogleAccountCookies([
    { name: 'VISITOR_INFO1_LIVE' },
    { name: 'YSC' }
  ]), false);
});
