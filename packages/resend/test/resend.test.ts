import { createHmac, randomBytes } from 'node:crypto';
import {
  AuthenticationError,
  createRelayo,
  ProviderUnavailableError,
  RateLimitError,
  ValidationError,
  type EmailMessage,
} from '@alimzen/relayo';
import { describe, expect, it, vi } from 'vitest';
import { resend, toResendRequest } from '../src/index.js';
import fixtures from './fixtures/events.json';

const events = fixtures as unknown as Record<string, { type: string; created_at: string; data: Record<string, unknown> }>;
const ID = '7b1f3c9e-6a4d-4c1e-9d2b-1f0e8a7c6b5d';

const message: EmailMessage = {
  from: { address: 'facturas@empresa.com', name: 'Facturas' },
  to: { address: 'cliente@example.com' },
  subject: 'Tu factura de octubre',
  html: '<p>Hola</p>',
  metadata: { facturaId: '123' },
  tags: ['facturas'],
};

const fakeFetch = (response: () => Response | Promise<Response>) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response());

const SECRET = `whsec_${randomBytes(24).toString('base64')}`;
function signed(body: unknown, { id = 'msg_2Lh9KRb6pzN4lDdNDS7cAQ', timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(body);
  const key = Buffer.from(SECRET.slice('whsec_'.length), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${raw}`).digest('base64');
  return {
    headers: { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,bogus v1,${signature}` },
    body: JSON.parse(raw) as unknown,
    rawBody: raw,
  };
}

describe('sending', () => {
  it('posts to /emails with Relayo id and metadata as tags, and the idempotency key', async () => {
    const fetch = fakeFetch(() => Response.json({ id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }));
    const relayo = createRelayo({ email: resend({ apiKey: 're_key', fetch }), generateId: () => 'msg_1' });

    const result = await relayo.email.send({ ...message, idempotencyKey: 'invoice-123' });

    expect(result).toEqual({
      messageId: 'msg_1',
      providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794',
      provider: 'resend',
      status: 'queued',
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer re_key', 'Idempotency-Key': 'invoice-123' });
    expect(JSON.parse(init!.body as string)).toEqual({
      from: 'Facturas <facturas@empresa.com>',
      to: ['cliente@example.com'],
      subject: 'Tu factura de octubre',
      html: '<p>Hola</p>',
      tags: [
        { name: 'relayo_message_id', value: 'msg_1' },
        { name: 'relayo_metadata', value: Buffer.from('{"facturaId":"123"}').toString('base64url') },
        { name: 'facturas', value: 'true' },
      ],
    });
  });

  it('maps attachments, unsubscribe headers and providerOptions', async () => {
    const fetch = fakeFetch(() => Response.json({ id: 'x' }));
    await createRelayo({ email: resend({ apiKey: 'k', fetch }) }).email.send({
      ...message,
      attachments: [{ filename: 'logo.png', content: new Uint8Array([1, 2]), cid: 'logo' }],
      unsubscribe: { url: 'https://empresa.com/u?t=1' },
      providerOptions: { scheduled_at: 'in 1 hour' },
    });
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
      attachments: [{ filename: 'logo.png', content: 'AQI=', content_id: 'logo' }],
      headers: { 'List-Unsubscribe': '<https://empresa.com/u?t=1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      scheduled_at: 'in 1 hour',
    });
  });

  it('refuses metadata that does not fit in a tag', () => {
    const big = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`key${i}`, 'value']));
    expect(() => toResendRequest({ ...message, metadata: big }, { messageId: 'm' })).toThrow(/too large for Resend/);
  });

  it.each([
    [422, 'missing_required_field', ValidationError],
    [401, 'missing_api_key', AuthenticationError],
    [403, 'validation_error', AuthenticationError],
    [409, 'invalid_idempotent_request', ValidationError],
    [409, 'concurrent_idempotent_requests', ProviderUnavailableError],
    [500, 'application_error', ProviderUnavailableError],
  ])('maps HTTP %i %s', async (status, name, expected) => {
    const fetch = fakeFetch(() => Response.json({ statusCode: status, name, message: 'nope' }, { status }));
    const error = await createRelayo({ email: resend({ apiKey: 'k', fetch }) }).email.send(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(expected);
    expect(error).toMatchObject({ provider: 'resend', raw: { status, name } });
  });

  it('maps rate limits and daily quota to RateLimitError with retryAfter', async () => {
    const limited = fakeFetch(() =>
      Response.json({ name: 'rate_limit_exceeded', message: 'slow' }, { status: 429, headers: { 'retry-after': '2' } }),
    );
    await expect(createRelayo({ email: resend({ apiKey: 'k', fetch: limited }) }).email.send(message)).rejects.toMatchObject({
      retryAfter: 2,
    });

    const quota = fakeFetch(() => Response.json({ name: 'daily_quota_exceeded', message: 'quota' }, { status: 429 }));
    const error = (await createRelayo({ email: resend({ apiKey: 'k', fetch: quota }) })
      .email.send(message)
      .catch((e: unknown) => e)) as RateLimitError;
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.retryAfter).toBeGreaterThan(0);
    expect(error.retryAfter).toBeLessThanOrEqual(86_400);
  });
});

describe('webhooks', () => {
  const driver = () => resend({ apiKey: 'k', webhook: { secret: SECRET } });

  it('verifies the Svix signature and normalizes the event', async () => {
    const relayo = createRelayo({ email: driver() });
    const [event] = await relayo.handleWebhook('email', signed(events.bouncedHard));

    expect(event).toMatchObject({
      id: 'msg_2Lh9KRb6pzN4lDdNDS7cAQ:0',
      type: 'bounced',
      provider: 'resend',
      messageId: ID,
      providerMessageId: '56761188-7520-42d8-8898-ff6fc54ce618',
      recipient: 'noexiste@example.com',
      bounceType: 'hard',
      reason: 'user_unknown',
      smtpCode: 550,
      enhancedCode: '5.1.1',
      metadata: { facturaId: '123' },
    });
  });

  it.each([
    ['sent', 'accepted'],
    ['delivered', 'delivered'],
    ['complained', 'complained'],
    ['failed', 'failed'],
    ['suppressed', 'rejected'],
    ['bouncedSuppressed', 'rejected'],
  ])('maps %s to %s', async (fixture, type) => {
    const [event] = await createRelayo({ email: driver() }).handleWebhook('email', signed(events[fixture]));
    expect(event!.type).toBe(type);
  });

  it('classifies blocklist bounces as block and temporary bounces as soft', async () => {
    const relayo = createRelayo({ email: driver() });
    expect((await relayo.handleWebhook('email', signed(events.bouncedBlocklisted)))[0]).toMatchObject({
      bounceType: 'block',
      reason: 'reputation_block',
    });
    expect((await relayo.handleWebhook('email', signed(events.bouncedMailboxFull)))[0]).toMatchObject({
      bounceType: 'soft',
      reason: 'mailbox_full',
    });
    expect((await relayo.handleWebhook('email', signed(events.bouncedSuppressed)))[0]).toMatchObject({ reason: 'suppressed' });
  });

  it('keeps the clicked link and click time', async () => {
    const [event] = await createRelayo({ email: driver() }).handleWebhook('email', signed(events.clicked));
    expect(event).toMatchObject({ url: 'https://empresa.com/factura/123', timestamp: new Date('2026-10-17T12:00:00.000Z') });
  });

  it('ignores events that are not about emails', async () => {
    await expect(createRelayo({ email: driver() }).handleWebhook('email', signed(events.domainCreated))).resolves.toEqual([]);
  });

  it.each([
    ['a tampered body', () => ({ ...signed(events.bouncedHard), rawBody: JSON.stringify(events.delivered) })],
    ['an old timestamp', () => signed(events.bouncedHard, { timestamp: Math.floor(Date.now() / 1000) - 3600 })],
    ['missing headers', () => ({ headers: {}, body: events.bouncedHard, rawBody: JSON.stringify(events.bouncedHard) })],
  ])('rejects %s', async (_, makeRequest) => {
    await expect(createRelayo({ email: driver() }).handleWebhook('email', makeRequest())).rejects.toThrow(
      /Invalid webhook signature/,
    );
  });

  it('demands a secret unless verification is off', async () => {
    const req = { headers: {}, body: events.delivered };
    await expect(createRelayo({ email: resend({ apiKey: 'k' }) }).handleWebhook('email', req)).rejects.toThrow(/no webhook.secret/);
    await expect(
      createRelayo({ email: resend({ apiKey: 'k', webhook: { verifySignature: false } }) }).handleWebhook('email', req),
    ).resolves.toHaveLength(1);
  });
});

describe('resend templates and scheduling', () => {
  it('sends a published template with its variables, and scheduled_at in ISO', () => {
    const at = new Date(Date.now() + 86_400_000);
    const body = toResendRequest({ ...{ from: { address: 'facturas@empresa.com' }, to: { address: 'ana@ejemplo.com' } }, template: { id: 'welcome', variables: { NOMBRE: 'Ana' } }, sendAt: at }, { messageId: 'm' });
    expect(body).toMatchObject({ template: { id: 'welcome', variables: { NOMBRE: 'Ana' } }, scheduled_at: at.toISOString() });
    expect(body).not.toHaveProperty('subject');
    expect(() => toResendRequest({ ...{ from: { address: 'facturas@empresa.com' }, to: { address: 'ana@ejemplo.com' } }, template: { id: 'welcome' }, html: '<p>x</p>' }, { messageId: 'm' })).toThrow(/html or text/);
    expect(() => toResendRequest({ ...{ from: { address: 'facturas@empresa.com' }, to: { address: 'ana@ejemplo.com' } }, subject: 's', text: 't', sendAt: new Date(Date.now() + 31 * 86_400_000) }, { messageId: 'm' })).toThrow(/30 days/);
  });
});
