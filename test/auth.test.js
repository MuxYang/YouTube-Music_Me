'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasGoogleAccountCookies,
  isAuthenticationEntryUrl,
  isAuthenticationReturnUrl,
  isSignOutUrl,
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

test('recognizes sign-out routes and only accepts secure completed return pages', () => {
  for (const url of [
    'https://music.youtube.com/logout',
    'https://www.youtube.com/signout?continue=https://music.youtube.com/',
    'https://accounts.google.com/Logout',
    'https://accounts.google.com/accounts/Logout'
  ]) {
    assert.equal(isSignOutUrl(url), true);
    assert.equal(isAuthenticationEntryUrl(url), true);
    assert.equal(isAuthenticationReturnUrl(url), false);
  }
  assert.equal(isAuthenticationReturnUrl('https://music.youtube.com/?authuser=1'), true);
  assert.equal(isAuthenticationReturnUrl('https://www.youtube.com/'), true);
  assert.equal(isAuthenticationReturnUrl('https://music.youtube.com/signin/complete'), false);
  assert.equal(isAuthenticationReturnUrl('http://music.youtube.com/'), false);
  assert.equal(isAuthenticationEntryUrl('http://accounts.google.com/Logout'), false);
  assert.equal(isAuthenticationReturnUrl('https://music.youtube.com.example.com/'), false);
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
