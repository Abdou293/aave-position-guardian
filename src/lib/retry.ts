// Retry with exponential backoff + jitter, for flaky free RPC endpoints.

export interface RetryOptions {
  /** Extra attempts after the first one. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Return false to stop retrying (e.g. for errors that will never succeed). */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const canRetry = attempt < opts.retries && (opts.shouldRetry?.(err, attempt) ?? true);
      if (!canRetry) break;
      // Full jitter: wait a random time between 0 and the exponential cap.
      const cap = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
      await sleep(Math.round(cap * random()));
    }
  }
  throw lastError;
}
