/**
 * reliability.ts
 *
 * Retry, timeout, and fallback utilities for LLM calls.
 *
 * Convention:
 *   - `RetryError` and `TimeoutError` are classes — extend Error so callers
 *     can catch them specifically.
 *   - `callWithRetry()` and `callWithTimeout()` are plain functions.
 *
 * Retry strategy: exponential backoff with jitter.
 *   attempt 1 → retryDelay ms
 *   attempt 2 → retryDelay * 2 ms
 *   attempt 3 → retryDelay * 4 ms
 *   ... capped at 30 000 ms
 */

import type { GenerateInput, GenerateResult, ModelProvider } from "./provider.js";

// ── Error classes ─────────────────────────────────────────────────────────────

export class RetryError extends Error {
  /** The last error that caused the final retry to fail */
  readonly cause: Error;
  /** Total number of attempts made (including the first) */
  readonly attempts: number;

  constructor(cause: Error, attempts: number) {
    super(
      `LLM call failed after ${attempts} attempt(s): ${cause.message}`,
    );
    this.name = "RetryError";
    this.cause = cause;
    this.attempts = attempts;
  }
}

export class TimeoutError extends Error {
  /** How long we waited before giving up (ms) */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`LLM call timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

// ── callWithTimeout() ─────────────────────────────────────────────────────────

/**
 * Races a promise against a timeout.
 * Throws `TimeoutError` if the promise does not resolve within `timeoutMs`.
 */
export async function callWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ── callWithRetry() ───────────────────────────────────────────────────────────

export type RetryOptions = {
  /** Max total attempts (1 = no retry). Default: 3 */
  maxAttempts: number;
  /** Base delay in ms between retries. Doubles each attempt. Default: 1000 */
  retryDelay: number;
  /** Optional per-call timeout in ms. Applied to every attempt. */
  callTimeout?: number;
  /** Called before each retry attempt (not the first call) */
  onRetry?: (attempt: number, error: Error) => void;
};

/**
 * Calls `fn` up to `maxAttempts` times with exponential backoff.
 * Throws `RetryError` wrapping the last error if all attempts fail.
 */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { maxAttempts, retryDelay, callTimeout, onRetry } = options;
  let lastError: Error = new Error("Unknown error");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const call = callTimeout
        ? () => callWithTimeout(fn, callTimeout)
        : fn;
      return await call();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry on abort — the caller explicitly cancelled
      if (lastError.name === "AbortError") throw lastError;

      if (attempt < maxAttempts) {
        onRetry?.(attempt, lastError);
        // Exponential backoff with ±10% jitter, capped at 30s
        const backoff = Math.min(
          retryDelay * Math.pow(2, attempt - 1),
          30_000,
        );
        const jitter = backoff * 0.1 * (Math.random() * 2 - 1);
        await sleep(Math.max(0, backoff + jitter));
      }
    }
  }

  throw new RetryError(lastError, maxAttempts);
}

// ── generateWithReliability() ─────────────────────────────────────────────────

/**
 * Wraps a provider's `generate()` call with retry, timeout, and fallback.
 *
 * - Retries the primary provider up to `maxAttempts` times.
 * - If all primary attempts fail and a `fallbackProvider` is supplied,
 *   makes one attempt on the fallback.
 * - Returns both the result and whether the fallback was used.
 */
export async function generateWithReliability(
  primary: ModelProvider,
  input: GenerateInput,
  options: RetryOptions & { fallbackProvider?: ModelProvider },
): Promise<{ result: GenerateResult; usedFallback: boolean }> {
  const { fallbackProvider, ...retryOpts } = options;

  try {
    const result = await callWithRetry(
      () => primary.generate(input),
      retryOpts,
    );
    return { result, usedFallback: false };
  } catch (primaryErr) {
    if (!fallbackProvider) throw primaryErr;

    // One attempt on the fallback — no retry loop, just a clean single call
    const result = await (retryOpts.callTimeout
      ? callWithTimeout(
          () => fallbackProvider.generate(input),
          retryOpts.callTimeout,
        )
      : fallbackProvider.generate(input));

    return { result, usedFallback: true };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
