'use strict';

const MINIMUM_SEQUENCE_MS = 1900;
const EXIT_DURATION_MS = 520;
const startedAt = performance.now();
const splash = document.getElementById('splash');
const errorPanel = document.getElementById('error-panel');
const retryButton = document.getElementById('retry');
const quitButton = document.getElementById('quit');
let exitRequested = false;
let transitionReported = false;

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
  window.setTimeout(() => {
    splash.classList.add('is-exiting');
    window.setTimeout(reportTransitionComplete, EXIT_DURATION_MS);
  }, delay);
}

retryButton.addEventListener('click', () => {
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
  if (state.status === 'ready') {
    beginExit();
    return;
  }

  const hasError = state.status === 'error';
  errorPanel.hidden = !hasError;
  errorPanel.classList.toggle('visible', hasError);
});

window.requestAnimationFrame(() => {
  window.requestAnimationFrame(() => splash.classList.add('is-running'));
});
