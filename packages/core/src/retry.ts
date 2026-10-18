import { isRelayoError, RateLimitError, type RelayoError } from './errors.js';
import type { SendContext } from './types/driver.js';
import type { BaseMessage } from './types/message.js';

export interface RetryAttempt {
  /** Attempt that just failed, starting at 1. */
  attempt: number;
  error: RelayoError;
  /** How long Relayo waits before the next attempt. */
  delayMs: number;
  message: BaseMessage;
  context: SendContext;
}

/**
 * In-process retries for sends. Off unless configured: in production retries usually belong to a
 * queue (e.g. BullMQ), and retrying in two places sends duplicates.
 */
export interface RetryOptions {
  /** Total attempts, including the first. `1` disables retries. */
  attempts: number;
  /** Delay before the first retry. Default 200 ms. */
  minDelayMs?: number;
  /** Upper bound for any delay. A `RateLimitError` asking for longer is thrown instead of waited for. Default 5 000 ms. */
  maxDelayMs?: number;
  /** Growth of the delay between attempts. Default 2. */
  factor?: number;
  /** Randomize each delay between 0 and its computed value, so many senders don't retry in sync. Default true. */
  jitter?: boolean;
  onRetry?: (attempt: RetryAttempt) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `send`, retrying on retryable `RelayoError`s according to `options`. */
export async function withRetry<T>(
  send: () => Promise<T>,
  options: RetryOptions | undefined,
  message: BaseMessage,
  context: SendContext,
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options?.attempts ?? 1));
  const minDelay = options?.minDelayMs ?? 200;
  const maxDelay = options?.maxDelayMs ?? 5_000;
  const factor = options?.factor ?? 2;
  const jitter = options?.jitter ?? true;

  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (attempt >= attempts || !isRelayoError(error) || !error.retryable) throw error;

      let delayMs: number;
      if (error instanceof RateLimitError && error.retryAfter !== undefined) {
        delayMs = error.retryAfter * 1000;
        if (delayMs > maxDelay) throw error;
      } else {
        const base = Math.min(maxDelay, minDelay * factor ** (attempt - 1));
        delayMs = jitter ? Math.round(Math.random() * base) : base;
      }
      options?.onRetry?.({ attempt, error, delayMs, message, context });
      await sleep(delayMs);
    }
  }
}
