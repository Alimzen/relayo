import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRelayo,
  failover,
  listUnsubscribeHeaders,
  memory,
  ProviderUnavailableError,
  RateLimitError,
  RejectedError,
  ValidationError,
  type EmailMessage,
  type RetryAttempt,
} from '../src/index.js';

const email: EmailMessage = {
  from: { address: 'news@empresa.com' },
  to: { address: 'ana@example.com' },
  subject: 'Novedades',
  text: 'Hola',
};

/** A driver that fails the first `n` sends with the given error. */
function flaky(n: number, makeError: () => Error, name = 'flaky') {
  let calls = 0;
  const driver = memory({ name, fail: () => (++calls <= n ? (makeError() as never) : undefined) });
  return { driver, calls: () => calls };
}

describe('retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is off by default', async () => {
    const { driver, calls } = flaky(1, () => new ProviderUnavailableError('down'));
    await expect(createRelayo({ email: driver }).email.send(email)).rejects.toThrow(ProviderUnavailableError);
    expect(calls()).toBe(1);
  });

  it('retries retryable errors with exponential backoff and the same messageId', async () => {
    const { driver, calls } = flaky(2, () => new ProviderUnavailableError('down'));
    const attempts: RetryAttempt[] = [];
    const relayo = createRelayo({
      email: driver,
      generateId: () => 'msg_1',
      retry: { attempts: 3, minDelayMs: 100, jitter: false, onRetry: (a) => attempts.push(a) },
    });

    const sending = relayo.email.send(email);
    await vi.advanceTimersByTimeAsync(100 + 200);
    const result = await sending;

    expect(calls()).toBe(3);
    expect(result.messageId).toBe('msg_1');
    expect(attempts.map((a) => [a.attempt, a.delayMs, a.context.messageId])).toEqual([
      [1, 100, 'msg_1'],
      [2, 200, 'msg_1'],
    ]);
  });

  it('gives up after the last attempt and throws the last error', async () => {
    const { driver, calls } = flaky(5, () => new ProviderUnavailableError('still down'));
    const relayo = createRelayo({ email: driver, retry: { attempts: 3, minDelayMs: 10, jitter: false } });

    const sending = relayo.email.send(email).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await sending).toBeInstanceOf(ProviderUnavailableError);
    expect(calls()).toBe(3);
  });

  it('never retries non-retryable or unexpected errors', async () => {
    for (const makeError of [() => new RejectedError('suppressed'), () => new TypeError('bug')]) {
      const { driver, calls } = flaky(1, makeError);
      const relayo = createRelayo({ email: driver, retry: { attempts: 5 } });
      await expect(relayo.email.send(email)).rejects.toThrow();
      expect(calls()).toBe(1);
    }
  });

  it('waits for retryAfter, and throws when it is longer than maxDelayMs', async () => {
    const short = flaky(1, () => new RateLimitError('slow', { retryAfter: 2 }));
    const onRetry = vi.fn();
    const sending = createRelayo({ email: short.driver, retry: { attempts: 2, onRetry } }).email.send(email);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(sending).resolves.toBeDefined();
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 2000 }));

    const long = flaky(1, () => new RateLimitError('slow', { retryAfter: 60 }));
    await expect(
      createRelayo({ email: long.driver, retry: { attempts: 2, maxDelayMs: 5000 } }).email.send(email),
    ).rejects.toMatchObject({ retryAfter: 60 });
    expect(long.calls()).toBe(1);
  });

  it('caps and randomizes delays', async () => {
    const delays: number[] = [];
    const { driver } = flaky(4, () => new ProviderUnavailableError('down'));
    const sending = createRelayo({
      email: driver,
      retry: { attempts: 5, minDelayMs: 1000, maxDelayMs: 1500, onRetry: (a) => delays.push(a.delayMs) },
    }).email.send(email);
    await vi.advanceTimersByTimeAsync(10_000);
    await sending;

    expect(delays).toHaveLength(4);
    expect(delays.every((d) => d >= 0 && d <= 1500)).toBe(true);
  });

  it('runs the whole failover again on each attempt', async () => {
    const a = flaky(1, () => new ProviderUnavailableError('a down'), 'a');
    const b = flaky(1, () => new ProviderUnavailableError('b down'), 'b');
    const relayo = createRelayo({
      email: failover([a.driver, b.driver]),
      retry: { attempts: 2, minDelayMs: 10, jitter: false },
    });

    const sending = relayo.email.send(email);
    await vi.advanceTimersByTimeAsync(10);

    await expect(sending).resolves.toMatchObject({ provider: 'a' });
    expect([a.calls(), b.calls()]).toEqual([2, 1]);
  });

  it('retries each message of a batch on its own when sent one by one', async () => {
    let calls = 0;
    const driver = memory({
      capabilities: { batch: false },
      fail: () => (++calls === 1 ? new ProviderUnavailableError('down') : undefined),
    });
    const relayo = createRelayo({ email: driver, retry: { attempts: 2, minDelayMs: 10, jitter: false } });

    const sending = relayo.email.sendBatch([email, email]);
    await vi.advanceTimersByTimeAsync(10);

    await expect(sending).resolves.toHaveLength(2);
    expect(calls).toBe(3);
    expect(driver.sent).toHaveLength(2);
  });
});

describe('unsubscribe', () => {
  it('adds one-click List-Unsubscribe headers for an https url', async () => {
    const driver = memory();
    await createRelayo({ email: driver }).email.send({
      ...email,
      unsubscribe: { url: 'https://empresa.com/unsub?t=abc', mailto: 'unsub@empresa.com' },
    });

    expect(driver.sent[0]!.message.headers).toEqual({
      'List-Unsubscribe': '<mailto:unsub@empresa.com>, <https://empresa.com/unsub?t=abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('supports mailto only, and url without one-click', () => {
    expect(listUnsubscribeHeaders({ mailto: 'unsub@empresa.com' })).toEqual({
      'List-Unsubscribe': '<mailto:unsub@empresa.com>',
    });
    expect(listUnsubscribeHeaders({ url: 'http://empresa.com/unsub', oneClick: false })).toEqual({
      'List-Unsubscribe': '<http://empresa.com/unsub>',
    });
  });

  it('does not modify the message passed in', async () => {
    const message = { ...email, unsubscribe: { mailto: 'unsub@empresa.com' } };
    await createRelayo({ email: memory() }).email.send(message);
    expect(message).not.toHaveProperty('headers');
  });

  it.each([
    [{}, /needs a url, a mailto/],
    [{ url: 'http://empresa.com/unsub' }, /needs an https url/],
    [{ mailto: 'not an address' }, /Invalid unsubscribe mailto/],
    [{ mailto: 'a@b.com', oneClick: true }, /One-click unsubscribe needs a url/],
  ])('rejects %o', async (unsubscribe, message) => {
    await expect(createRelayo({ email: memory() }).email.send({ ...email, unsubscribe })).rejects.toThrow(message);
  });

  it('refuses unsubscribe together with hand-written List-Unsubscribe headers', async () => {
    const relayo = createRelayo({ email: memory() });
    await expect(
      relayo.email.send({ ...email, headers: { 'list-unsubscribe': '<mailto:x@y.com>' }, unsubscribe: { mailto: 'a@b.com' } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
