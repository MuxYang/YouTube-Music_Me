'use strict';

function createHttpError(message, status) {
  const error = new Error(message);
  error.status = Number(status) || 0;
  error.retryable = [408, 425, 429].includes(error.status) || error.status >= 500;
  return error;
}

function isRetryableError(error) {
  if (typeof error?.retryable === 'boolean') {
    return error.retryable;
  }
  return error?.name === 'AbortError'
    || error instanceof SyntaxError
    || error instanceof TypeError;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retryAsync(operation, options = {}) {
  const attempts = Math.max(1, Math.floor(Number(options.attempts) || 1));
  const baseDelayMs = Number.isFinite(Number(options.baseDelayMs))
    ? Math.max(0, Number(options.baseDelayMs))
    : 250;
  const shouldRetry = typeof options.shouldRetry === 'function'
    ? options.shouldRetry
    : isRetryableError;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error)) {
        throw error;
      }
      await wait(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

module.exports = {
  createHttpError,
  isRetryableError,
  retryAsync
};
