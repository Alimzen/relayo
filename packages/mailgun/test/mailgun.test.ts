import { createHmac, randomBytes } from 'node:crypto';
import {
  AuthenticationError,
  createRelayo,
  ProviderUnavailableError,
  RateLimitError,
  ValidationError,
  type EmailMessage,
} from '@alimzen/core';
import { describe, expect, it, vi } from 'vitest';
import { mailgun, toMailgunForm } from '../src/index.js';
import fixtures from './fixtures/events.json';

const events = fixtures as unknown as Record<string, Record<string, unknown>>;
const ID = '7b1f3c9e-6a4d-4c1e-9d2b-1f0e8a7c6b5d';
const message: EmailMessage = {
  from: { address: 'facturas@mg.empresa.com', name: 'Facturas' },
  to: [{ address: 'cliente@example.com' }, { address: 'otra@example.com' }],
  cc: [{ address: 'copia@example.com' }],
  replyTo: { address: 'soporte@empresa.com' },
  subject: 'Tu factura de octubre',
  html: '<p>Hola</p>',
  metadata: { facturaId: '123' },
  tags: ['facturas'],
};
const fakeFetch = (response: () => Response | Promise<Response>) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response());

const SIGNING_KEY = randomBytes(16).toString('hex');
function signed(eventData: unknown, { timestamp = String(Math.floor(Date.now() / 1000)), key = SIGNING_KEY } = {}) {
  const token = randomBytes(25).toString('hex');
  const signature = createHmac('sha256', key).update(timestamp + token).digest('hex');
  const body = { signature: { timestamp, token, signature }, 'event-data': eventData };
  return { headers: { 'content-type': 'application/json' }, body, rawBody: JSON.stringify(body) };
}

describe('sending', () => {
  it('posts multipart form data with the Relayo id and metadata as custom variables', async () => {
    const fetch = fakeFetch(() => Response.json({ id: '<20261017100001.58bbb7ce85a423e5@mg.empresa.com>', message: 'Queued. Thank you.' }));
    const relayo = createRelayo({
      email: mailgun({ apiKey: 'key-123', domain: 'mg.empresa.com', region: 'eu', fetch }),
      generateId: () => 'msg_1',
    });

    const result = await relayo.email.send(message);

    expect(result).toEqual({
      messageId: 'msg_1',
      providerMessageId: '20261017100001.58bbb7ce85a423e5@mg.empresa.com',
      provider: 'mailgun',
      status: 'queued',
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.eu.mailgun.net/v3/mg.empresa.com/messages');
    expect(init?.headers).toEqual({ Authorization: `Basic ${Buffer.from('api:key-123').toString('base64')}` });
    const form = init!.body as FormData;
    expect(form.get('from')).toBe('"Facturas" <facturas@mg.empresa.com>');
    expect(form.getAll('to')).toEqual(['cliente@example.com', 'otra@example.com']);
    expect(form.getAll('cc')).toEqual(['copia@example.com']);
    expect(form.get('h:Reply-To')).toBe('soporte@empresa.com');
    expect(form.getAll('o:tag')).toEqual(['facturas']);
    expect(form.get('v:relayo_message_id')).toBe('msg_1');
    expect(form.get('v:relayo_metadata')).toBe('{"facturaId":"123"}');
  });

  it('sends attachments as files, inline images under their content id, and providerOptions as fields', async () => {
    const form = toMailgunForm(
      {
        ...message,
        attachments: [
          { filename: 'factura.pdf', content: new Uint8Array([1, 2, 3]), contentType: 'application/pdf' },
          { filename: 'logo.png', content: new Uint8Array([4]), cid: 'logo.png' },
        ],
        providerOptions: { 'o:tracking': 'yes', 'o:tag': ['otra'] },
      },
      { messageId: 'm' },
    );
    const attachment = form.get('attachment') as File;
    expect(attachment.name).toBe('factura.pdf');
    expect(attachment.type).toBe('application/pdf');
    expect(new Uint8Array(await attachment.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((form.get('inline') as File).name).toBe('logo.png');
    expect(form.get('o:tracking')).toBe('yes');
    expect(form.getAll('o:tag')).toEqual(['facturas', 'otra']);
  });

  it('refuses more than 3 tags', () => {
    expect(() => toMailgunForm({ ...message, tags: ['a', 'b', 'c', 'd'] }, { messageId: 'm' })).toThrow(/at most 3 tags/);
  });

  it.each([
    [400, ValidationError],
    [401, AuthenticationError],
    [403, AuthenticationError],
    [404, ValidationError],
    [500, ProviderUnavailableError],
  ])('maps HTTP %i', async (status, expected) => {
    const fetch = fakeFetch(() => Response.json({ message: "'from' parameter is missing" }, { status }));
    const error = await createRelayo({ email: mailgun({ apiKey: 'k', domain: 'd', fetch }) }).email.send(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(expected);
    expect(error).toMatchObject({ provider: 'mailgun', raw: { status, message: "'from' parameter is missing" } });
  });

  it('maps 429 to RateLimitError', async () => {
    const fetch = fakeFetch(() => new Response('Too many requests', { status: 429, headers: { 'retry-after': '3' } }));
    await expect(createRelayo({ email: mailgun({ apiKey: 'k', domain: 'd', fetch }) }).email.send(message)).rejects.toSatisfy(
      (e: unknown) => e instanceof RateLimitError && e.retryAfter === 3,
    );
  });
});

describe('webhooks', () => {
  const relayo = (extra = {}) =>
    createRelayo({ email: mailgun({ apiKey: 'k', domain: 'd', webhook: { signingKey: SIGNING_KEY, ...extra } }) });

  it('verifies the signature and normalizes a permanent failure', async () => {
    const [event] = await relayo().handleWebhook('email', signed(events.failedPermanent));
    expect(event).toMatchObject({
      id: '2kFItcrLQuKTdp-Ia2Xr7w:1792231205.5923693',
      type: 'bounced',
      provider: 'mailgun',
      messageId: ID,
      providerMessageId: '20261017100001.58bbb7ce85a423e5@mg.empresa.com',
      recipient: 'noexiste@example.com',
      bounceType: 'hard',
      reason: 'user_unknown',
      smtpCode: 550,
      enhancedCode: '5.1.1',
      metadata: { facturaId: '123' },
    });
    expect(event!.timestamp).toEqual(new Date(1792231205592.3693));
  });

  it('turns temporary failures into deferrals and suppressions into rejections', async () => {
    expect((await relayo().handleWebhook('email', signed(events.failedTemporary)))[0]).toMatchObject({ type: 'deferred', messageId: ID });
    expect((await relayo().handleWebhook('email', signed(events.suppressed)))[0]).toMatchObject({
      type: 'rejected',
      reason: 'suppressed',
      diagnostic: 'suppress-bounce',
    });
  });

  it('classifies blocklist failures as block', async () => {
    expect((await relayo().handleWebhook('email', signed(events.failedBlocklisted)))[0]).toMatchObject({
      bounceType: 'block',
      reason: 'reputation_block',
    });
  });

  it('falls back to the Message-ID when there are no user variables', async () => {
    const [event] = await relayo().handleWebhook('email', signed(events.failedHotmail));
    expect(event).toMatchObject({ messageId: '20261017100002.aaaa@mg.empresa.com', bounceType: 'hard' });
    expect(event).not.toHaveProperty('metadata');
  });

  it.each([
    ['delivered', 'delivered'],
    ['complained', 'complained'],
    ['unsubscribed', 'unsubscribed'],
  ])('maps %s to %s', async (fixture, type) => {
    expect((await relayo().handleWebhook('email', signed(events[fixture])))[0]!.type).toBe(type);
  });

  it('keeps clicked URLs', async () => {
    expect((await relayo().handleWebhook('email', signed(events.clicked)))[0]).toMatchObject({ url: 'https://empresa.com/factura/123' });
  });

  it('rejects bad signatures, other keys and, when asked, old timestamps', async () => {
    const tampered = signed(events.failedPermanent);
    tampered.body.signature.signature = 'aa'.repeat(32);
    await expect(relayo().handleWebhook('email', { headers: {}, body: tampered.body })).rejects.toThrow(/Invalid webhook signature/);
    await expect(relayo().handleWebhook('email', signed(events.delivered, { key: 'other' }))).rejects.toThrow(/Invalid webhook signature/);

    const old = signed(events.delivered, { timestamp: String(Math.floor(Date.now() / 1000) - 3600) });
    await expect(relayo().handleWebhook('email', old)).resolves.toHaveLength(1);
    await expect(relayo({ toleranceSeconds: 600 }).handleWebhook('email', old)).rejects.toThrow(/Invalid webhook signature/);
  });

  it('demands a signing key unless verification is off', async () => {
    const req = { headers: {}, body: { 'event-data': events.delivered } };
    await expect(createRelayo({ email: mailgun({ apiKey: 'k', domain: 'd' }) }).handleWebhook('email', req)).rejects.toThrow(/no webhook.signingKey/);
    await expect(
      createRelayo({ email: mailgun({ apiKey: 'k', domain: 'd', webhook: { verifySignature: false } }) }).handleWebhook('email', req),
    ).resolves.toHaveLength(1);
  });
});
