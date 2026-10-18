import { generateKeyPairSync, sign } from 'node:crypto';
import {
  AuthenticationError,
  createRelayo,
  failover,
  ProviderUnavailableError,
  RateLimitError,
  ValidationError,
  type BounceEvent,
  type EmailMessage,
} from '@alimzen/core';
import { describe, expect, it, vi } from 'vitest';
import { sendgrid, SIGNATURE_HEADER, TIMESTAMP_HEADER, toSendGridRequest } from '../src/index.js';
import fixtures from './fixtures/events.json';

const message: EmailMessage = {
  from: { address: 'facturas@empresa.com', name: 'Facturas' },
  to: [{ address: 'cliente@example.com', name: 'Ana' }],
  cc: [{ address: 'copia@example.com' }],
  replyTo: { address: 'soporte@empresa.com' },
  subject: 'Tu factura de octubre',
  html: '<p>Hola</p>',
  text: 'Hola',
  metadata: { facturaId: '123' },
  tags: ['facturas'],
};

function fakeFetch(response: () => Response | Promise<Response>) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response());
}

// --- Signed Event Webhook: a local P-256 key pair stands in for SendGrid's ---
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function signedRequest(rawBody: string, timestamp = '1792231300') {
  const signature = sign('sha256', Buffer.from(timestamp + rawBody), privateKey).toString('base64');
  return {
    headers: { [SIGNATURE_HEADER]: signature, [TIMESTAMP_HEADER]: timestamp, 'content-type': 'application/json' },
    body: JSON.parse(rawBody) as unknown,
    rawBody,
  };
}

const RAW = JSON.stringify(fixtures);

describe('sending', () => {
  it('posts to the v3 Mail Send API with custom_args, categories and the right content order', async () => {
    const fetch = fakeFetch(() => new Response(null, { status: 202, headers: { 'X-Message-Id': 'sg-123' } }));
    const relayo = createRelayo({
      email: sendgrid({ apiKey: 'SG.key', fetch }),
      generateId: () => 'msg_1',
    });

    const result = await relayo.email.send(message);

    expect(result).toEqual({ messageId: 'msg_1', providerMessageId: 'sg-123', provider: 'sendgrid', status: 'queued' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer SG.key' });
    expect(JSON.parse(init!.body as string)).toEqual({
      personalizations: [{ to: [{ email: 'cliente@example.com', name: 'Ana' }], cc: [{ email: 'copia@example.com' }] }],
      from: { email: 'facturas@empresa.com', name: 'Facturas' },
      reply_to: { email: 'soporte@empresa.com' },
      subject: 'Tu factura de octubre',
      content: [
        { type: 'text/plain', value: 'Hola' },
        { type: 'text/html', value: '<p>Hola</p>' },
      ],
      custom_args: { relayo_message_id: 'msg_1', relayo_metadata: '{"facturaId":"123"}' },
      categories: ['facturas'],
    });
  });

  it('uses the EU endpoint, sandbox mode, attachments and providerOptions', async () => {
    const fetch = fakeFetch(() => new Response(null, { status: 202 }));
    const relayo = createRelayo({ email: sendgrid({ apiKey: 'k', region: 'eu', sandbox: true, fetch }) });

    await relayo.email.send({
      ...message,
      attachments: [{ filename: 'logo.png', content: new Uint8Array([1, 2]), contentType: 'image/png', cid: 'logo' }],
      providerOptions: { send_at: 1792231300 },
    });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.eu.sendgrid.com/v3/mail/send');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      mail_settings: { sandbox_mode: { enable: true } },
      attachments: [{ content: 'AQI=', filename: 'logo.png', type: 'image/png', disposition: 'inline', content_id: 'logo' }],
      send_at: 1792231300,
    });
  });

  it('refuses more than 10 tags before calling SendGrid', () => {
    const tags = Array.from({ length: 11 }, (_, i) => `t${i}`);
    expect(() => toSendGridRequest({ ...message, tags }, { messageId: 'm' })).toThrow(ValidationError);
  });

  it.each([
    [400, { errors: [{ message: 'Does not contain a valid address.', field: 'personalizations.0.to.0.email' }] }, ValidationError],
    [401, { errors: [{ message: 'The provided authorization grant is invalid, expired, or revoked' }] }, AuthenticationError],
    [403, { errors: [{ message: 'The from address does not match a verified Sender Identity.' }] }, AuthenticationError],
    [413, { errors: [{ message: 'Payload too large' }] }, ValidationError],
    [500, { errors: [{ message: 'Internal error' }] }, ProviderUnavailableError],
  ])('maps HTTP %i', async (status, body, expected) => {
    const fetch = fakeFetch(() => Response.json(body, { status }));
    const error = await createRelayo({ email: sendgrid({ apiKey: 'k', fetch }) })
      .email.send(message)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(expected);
    expect(error).toMatchObject({ provider: 'sendgrid', raw: { status, errors: body.errors } });
  });

  it('maps 429 to RateLimitError with retryAfter from the reset header', async () => {
    const reset = Math.ceil(Date.now() / 1000) + 30;
    const fetch = fakeFetch(() =>
      Response.json({ errors: [{ message: 'too many requests' }] }, { status: 429, headers: { 'X-RateLimit-Reset': String(reset) } }),
    );
    const error = await createRelayo({ email: sendgrid({ apiKey: 'k', fetch }) })
      .email.send(message)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBeGreaterThanOrEqual(29);
  });

  it('maps network failures and timeouts to ProviderUnavailableError', async () => {
    const fetch = fakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    await expect(
      createRelayo({ email: sendgrid({ apiKey: 'k', fetch }) }).email.send(message),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('requires an apiKey', () => {
    expect(() => sendgrid({ apiKey: '' })).toThrow(ValidationError);
  });
});

describe('Event Webhook', () => {
  const driver = (extra = {}) => sendgrid({ apiKey: 'k', fetch: fakeFetch(() => new Response()), webhook: { publicKey: PUBLIC_KEY, ...extra } });

  it('verifies the signature and normalizes every event in the batch', async () => {
    const relayo = createRelayo({ email: driver() });
    const seen: string[] = [];
    relayo.on('*', (e) => {
      seen.push(e.type);
    });

    const events = await relayo.handleWebhook('email', signedRequest(RAW));

    // group_resubscribe has no Relayo equivalent and is skipped.
    expect(seen).toEqual([
      'accepted', 'delivered', 'deferred', 'bounced', 'bounced', 'rejected',
      'opened', 'clicked', 'complained', 'unsubscribed',
    ]);
    expect(events[0]).toMatchObject({
      id: 'rbtnWrG1DVDGGGFHFyun0A==',
      provider: 'sendgrid',
      messageId: '7b1f3c9e-6a4d-4c1e-9d2b-1f0e8a7c6b5d',
      providerMessageId: '14c5d75ce93.dfd.64b469',
      recipient: 'cliente@example.com',
      metadata: { facturaId: '123' },
      timestamp: new Date(1792231201 * 1000),
    });
    expect(events[0]!.raw).toEqual(fixtures[0]);
  });

  it('classifies bounces, and never treats a blocked sender as a bad address', async () => {
    const events = await createRelayo({ email: driver() }).handleWebhook('email', signedRequest(RAW));
    const bounces = events.filter((e): e is BounceEvent => e.type === 'bounced');

    expect(bounces[0]).toMatchObject({ recipient: 'noexiste@example.com', bounceType: 'hard', reason: 'user_unknown', smtpCode: 550, enhancedCode: '5.1.1' });
    expect(bounces[1]).toMatchObject({ bounceType: 'block', reason: 'reputation_block' });
  });

  it('maps drops to rejected with a reason and keeps click URLs', async () => {
    const events = await createRelayo({ email: driver() }).handleWebhook('email', signedRequest(RAW));
    expect(events.find((e) => e.type === 'rejected')).toMatchObject({ reason: 'suppressed', diagnostic: 'Bounced Address' });
    expect(events.find((e) => e.type === 'clicked')).toMatchObject({ url: 'https://empresa.com/factura/123' });
  });

  it.each([
    ['a tampered body', () => ({ ...signedRequest(RAW), rawBody: RAW.replace('5.1.1', '4.2.2') })],
    ['a missing raw body', () => ({ ...signedRequest(RAW), rawBody: undefined })],
    ['missing headers', () => ({ headers: {}, body: fixtures, rawBody: RAW })],
    ['a signature from another key', () => {
      const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
      const req = signedRequest(RAW);
      req.headers[SIGNATURE_HEADER] = sign('sha256', Buffer.from('1792231300' + RAW), other).toString('base64');
      return req;
    }],
  ])('rejects %s', async (_, makeRequest) => {
    const relayo = createRelayo({ email: driver() });
    const handler = vi.fn();
    relayo.on('*', handler);

    await expect(relayo.handleWebhook('email', makeRequest() as never)).rejects.toThrow(/Invalid webhook signature/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('enforces the timestamp tolerance when configured', async () => {
    const relayo = createRelayo({ email: driver({ toleranceSeconds: 300 }) });
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const fresh = String(Math.floor(Date.now() / 1000));

    await expect(relayo.handleWebhook('email', signedRequest(RAW, stale))).rejects.toThrow(/Invalid webhook signature/);
    await expect(relayo.handleWebhook('email', signedRequest(RAW, fresh))).resolves.toHaveLength(10);
  });

  it('accepts the key as PEM', async () => {
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const relayo = createRelayo({ email: sendgrid({ apiKey: 'k', webhook: { publicKey: pem } }) });
    await expect(relayo.handleWebhook('email', signedRequest(RAW))).resolves.toHaveLength(10);
  });

  it('demands a public key unless verification is explicitly off', async () => {
    const unsigned = { headers: {}, body: fixtures };
    await expect(
      createRelayo({ email: sendgrid({ apiKey: 'k' }) }).handleWebhook('email', unsigned),
    ).rejects.toThrow(/no webhook.publicKey/);
    await expect(
      createRelayo({ email: sendgrid({ apiKey: 'k', webhook: { verifySignature: false } }) }).handleWebhook('email', unsigned),
    ).resolves.toHaveLength(10);
  });

  it('is detected by signature inside a failover', async () => {
    const down = fakeFetch(() => Response.json({}, { status: 503 }));
    const up = fakeFetch(() => new Response(null, { status: 202, headers: { 'X-Message-Id': 'sg-b' } }));
    const relayo = createRelayo({
      email: failover([
        sendgrid({ apiKey: 'a', name: 'sendgrid-main', fetch: down, webhook: { publicKey: PUBLIC_KEY } }),
        sendgrid({ apiKey: 'b', name: 'sendgrid-backup', fetch: up, region: 'eu' }),
      ]),
    });

    await expect(relayo.email.send(message)).resolves.toMatchObject({ provider: 'sendgrid-backup' });
    const events = await relayo.handleWebhook('email', signedRequest(RAW));
    expect(events[0]).toMatchObject({ provider: 'sendgrid-main' });
  });
});
