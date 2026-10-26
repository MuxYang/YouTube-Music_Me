'use strict';

const MINIMUM_SEQUENCE_MS = 1900;
const EXIT_DURATION_MS = 520;
const startedAt = performance.now();
const splash = document.getElementById('splash');
const errorPanel = document.getElementById('error-panel');
const retryButton = document.getElementById('retry');
const quitButton = document.getElementById('quit');
const errorText = document.getElementById('error-text');
const strings = window.startup.strings;
let exitRequested = false;
let transitionReported = false;
let exitTimer = null;
let transitionTimer = null;
let currentStatus = 'loading';

document.documentElement.lang = strings.languageTag;
splash.setAttribute('aria-label', strings.splashLoading);
errorText.textContent = strings.splashError;
retryButton.textContent = strings.splashRetry;
quitButton.textContent = strings.splashQuit;

function reportTransitionComplete() {
  if (transitionReported) {
    return;
  }
  transitionReported = true;
  window.startup.transitionComplete();
}

function beginExit() {
  if (exitRequested) {
    return;
  }
  exitRequested = true;

  const elapsed = performance.now() - startedAt;
  const delay = Math.max(0, MINIMUM_SEQUENCE_MS - elapsed);
  exitTimer = window.setTimeout(() => {
    splash.classList.add('is-exiting');
    transitionTimer = window.setTimeout(reportTransitionComplete, EXIT_DURATION_MS);
  }, delay);
}

retryButton.addEventListener('click', () => {
  currentStatus = 'loading';
  errorPanel.classList.remove('visible');
  errorPanel.hidden = true;
  window.startup.retry();
});
quitButton.addEventListener('click', () => window.startup.quit());

splash.addEventListener('transitionend', (event) => {
  if (event.target === splash && event.propertyName === 'opacity' && splash.classList.contains('is-exiting')) {
    reportTransitionComplete();
  }
});

window.startup.onState((state) => {
  currentStatus = state.status;
  if (state.status === 'ready') {
    beginExit();
    return;
  }

  window.clearTimeout(exitTimer);
  window.clearTimeout(transitionTimer);
  exitRequested = false;
  transitionReported = false;
  splash.classList.remove('is-exiting');
  const hasError = state.status === 'error';
  errorPanel.hidden = !hasError;
  errorPanel.classList.toggle('visible', hasError);
});

window.addEventListener('online', () => {
  if (currentStatus === 'error') {
    retryButton.click();
  }
});

window.requestAnimationFrame(() => {
  window.requestAnimationFrame(() => splash.classList.add('is-running'));
});
