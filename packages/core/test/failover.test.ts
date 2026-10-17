import { describe, expect, it, vi } from 'vitest';
import {
  AuthenticationError,
  createRelayo,
  failover,
  memory,
  ProviderUnavailableError,
  RateLimitError,
  RejectedError,
  ValidationError,
  type EmailMessage,
  type FailoverAttempt,
} from '../src/index.js';

const email: EmailMessage = {
  from: { address: 'facturas@empresa.com' },
  to: { address: 'cliente@empresa.com' },
  subject: 'Tu factura',
  text: 'Hola',
};

const down = () => new ProviderUnavailableError('down', { provider: 'x' });

describe('failover', () => {
  it('uses the first driver when it works', async () => {
    const a = memory({ name: 'a' });
    const b = memory({ name: 'b' });
    const relayo = createRelayo({ email: failover([a, b]) });

    const result = await relayo.email.send(email);

    expect(result.provider).toBe('a');
    expect(b.sent).toHaveLength(0);
  });

  it('moves to the next driver on retryable errors, keeping the same messageId', async () => {
    const a = memory({ name: 'a', fail: down });
    const b = memory({ name: 'b', fail: () => new RateLimitError('slow down') });
    const c = memory({ name: 'c' });
    const attempts: FailoverAttempt<EmailMessage>[] = [];
    const relayo = createRelayo({
      email: failover([a, b, c], { onFailover: (attempt) => attempts.push(attempt) }),
      generateId: () => 'msg_1',
    });

    const result = await relayo.email.send(email);

    expect(result).toMatchObject({ messageId: 'msg_1', provider: 'c' });
    expect(attempts.map((x) => [x.from, x.to, x.error.code])).toEqual([
      ['a', 'b', 'provider_unavailable'],
      ['b', 'c', 'rate_limited'],
    ]);
    expect(attempts[0]!.context.messageId).toBe('msg_1');
  });

  it.each([
    ['rejection', () => new RejectedError('suppressed')],
    ['bad credentials', () => new AuthenticationError('bad key')],
    ['invalid message', () => new ValidationError('bad')],
  ])('stops on a non-retryable %s', async (_, makeError) => {
    const a = memory({ name: 'a', fail: makeError });
    const b = memory({ name: 'b' });
    const relayo = createRelayo({ email: failover([a, b]) });

    await expect(relayo.email.send(email)).rejects.toBeInstanceOf(makeError().constructor);
    expect(b.sent).toHaveLength(0);
  });

  it('does not fail over on unexpected (non-Relayo) errors, to avoid double sends', async () => {
    const a = memory({ name: 'a' });
    vi.spyOn(a, 'send').mockRejectedValue(new TypeError('driver bug'));
    const b = memory({ name: 'b' });

    await expect(createRelayo({ email: failover([a, b]) }).email.send(email)).rejects.toThrow(TypeError);
    expect(b.sent).toHaveLength(0);
  });

  it('accepts a custom shouldFailover', async () => {
    const a = memory({ name: 'a', fail: () => new RejectedError('blocked by provider policy') });
    const b = memory({ name: 'b' });
    const relayo = createRelayo({
      email: failover([a, b], { shouldFailover: (e) => e instanceof RejectedError }),
    });

    await expect(relayo.email.send(email)).resolves.toMatchObject({ provider: 'b' });
  });

  it('throws the last error when every driver fails', async () => {
    const relayo = createRelayo({
      email: failover([
        memory({ name: 'a', fail: down }),
        memory({ name: 'b', fail: () => new RateLimitError('slow', { retryAfter: 30 }) }),
      ]),
    });

    await expect(relayo.email.send(email)).rejects.toMatchObject({ code: 'rate_limited', retryAfter: 30 });
  });

  it('skips drivers that lack a capability the message needs', async () => {
    const a = memory({ name: 'a', capabilities: { attachments: false } });
    const b = memory({ name: 'b' });
    const relayo = createRelayo({ email: failover([a, b]) });

    const result = await relayo.email.send({ ...email, attachments: [{ filename: 'f.pdf', content: 'x' }] });

    expect(result.provider).toBe('b');
    expect(a.sent).toHaveLength(0);
  });

  it('reports the union of capabilities and rejects messages no driver can send', async () => {
    const noAttachments = () => memory({ capabilities: { attachments: false } });
    const driver = failover([memory({ name: 'a', capabilities: { attachments: false } }), memory({ name: 'b' })]);
    expect(driver.capabilities).toMatchObject({ attachments: true, batch: false, tracking: true });

    const relayo = createRelayo({ email: failover([noAttachments()]) });
    await expect(
      relayo.email.send({ ...email, attachments: [{ filename: 'f.pdf', content: 'x' }] }),
    ).rejects.toThrow(ValidationError);
  });

  it('sends batches message by message, each with its own failover', async () => {
    let calls = 0;
    const a = memory({ name: 'a', fail: () => (++calls === 2 ? down() : undefined) });
    const b = memory({ name: 'b' });
    const relayo = createRelayo({ email: failover([a, b]) });

    const results = await relayo.email.sendBatch([email, email, email]);

    expect(results.map((r) => r.provider)).toEqual(['a', 'b', 'a']);
  });

  it('rejects invalid compositions', () => {
    expect(() => failover([memory(), memory({ channel: 'sms' }) as never])).toThrow(/mixes email and sms/);
    expect(() => failover([memory(), memory()])).toThrow(/two drivers named "memory"/);
  });

  describe('webhooks', () => {
    const verifying = (name: string, accepts: (body: unknown) => boolean) => ({
      ...memory({ name }),
      verifyWebhook: vi.fn((req: { body: unknown }) => accepts(req.body)),
    });

    it('routes to the driver named in req.provider', async () => {
      const a = memory({ name: 'a' });
      const b = memory({ name: 'b' });
      const relayo = createRelayo({ email: failover([a, b]) });
      const { messageId } = await relayo.email.send(email);
      const handler = vi.fn();
      relayo.on('delivered', handler);

      const events = await relayo.handleWebhook('email', {
        provider: 'b',
        headers: {},
        body: { ...a.createEvent(messageId, 'delivered'), provider: 'b' },
      });

      expect(events).toHaveLength(1);
      expect(handler).toHaveBeenCalledOnce();
    });

    it('still checks the signature of the named driver', async () => {
      const a = verifying('a', () => false);
      const relayo = createRelayo({ email: failover([a, memory({ name: 'b' })]) });

      await expect(relayo.handleWebhook('email', { provider: 'a', headers: {}, body: [] })).rejects.toThrow(
        /Invalid webhook signature/,
      );
    });

    it('detects the provider by signature when none is named, verifying only once', async () => {
      const a = verifying('a', (body) => (body as { from?: string }).from === 'a');
      const b = verifying('b', (body) => (body as { from?: string }).from === 'b');
      const relayo = createRelayo({ email: failover([a, b]) });

      await relayo.handleWebhook('email', { headers: {}, body: { from: 'b', type: 'delivered', timestamp: 0 } });

      expect(a.verifyWebhook).toHaveBeenCalledOnce();
      expect(b.verifyWebhook).toHaveBeenCalledOnce();
    });

    it('asks for req.provider when it cannot tell', async () => {
      const relayo = createRelayo({ email: failover([memory({ name: 'a' }), memory({ name: 'b' })]) });
      await expect(relayo.handleWebhook('email', { headers: {}, body: [] })).rejects.toThrow(/set "provider"/);
      await expect(relayo.handleWebhook('email', { provider: 'zzz', headers: {}, body: [] })).rejects.toThrow(
        /Unknown provider "zzz"/,
      );
    });
  });
});
