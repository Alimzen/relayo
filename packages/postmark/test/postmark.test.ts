import {
  AuthenticationError,
  createRelayo,
  ProviderUnavailableError,
  RateLimitError,
  RejectedError,
  ValidationError,
  type EmailMessage,
} from '@alimzen/core';
import { describe, expect, it, vi } from 'vitest';
import { postmark, toPostmarkRequest } from '../src/index.js';
import fixtures from './fixtures/events.json';

const events = fixtures as unknown as Record<string, Record<string, unknown>>;
const ID = '7b1f3c9e-6a4d-4c1e-9d2b-1f0e8a7c6b5d';
const message: EmailMessage = {
  from: { address: 'facturas@empresa.com', name: 'Facturas' },
  to: [{ address: 'cliente@example.com' }, { address: 'otra@example.com', name: 'Otra' }],
  subject: 'Tu factura de octubre',
  html: '<p>Hola</p>',
  text: 'Hola',
  metadata: { facturaId: '123' },
  tags: ['facturas'],
};
const fakeFetch = (response: () => Response | Promise<Response>) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response());

const AUTH = { username: 'postmark', password: 's3cret' };
const withAuth = (body: unknown, credentials = AUTH) => ({
  headers: { authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}` },
  body,
});

describe('sending', () => {
  it('posts to /email with Metadata carrying the Relayo id', async () => {
    const fetch = fakeFetch(() =>
      Response.json({ To: 'cliente@example.com', SubmittedAt: '2026-10-17T10:00:00Z', MessageID: 'pm-1', ErrorCode: 0, Message: 'OK' }),
    );
    const relayo = createRelayo({
      email: postmark({ serverToken: 'token', messageStream: 'outbound', fetch }),
      generateId: () => 'msg_1',
    });

    const result = await relayo.email.send(message);

    expect(result).toEqual({ messageId: 'msg_1', providerMessageId: 'pm-1', provider: 'postmark', status: 'queued' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.postmarkapp.com/email');
    expect(init?.headers).toMatchObject({ 'X-Postmark-Server-Token': 'token' });
    expect(JSON.parse(init!.body as string)).toEqual({
      From: '"Facturas" <facturas@empresa.com>',
      To: 'cliente@example.com, "Otra" <otra@example.com>',
      Subject: 'Tu factura de octubre',
      HtmlBody: '<p>Hola</p>',
      TextBody: 'Hola',
      Tag: 'facturas',
      MessageStream: 'outbound',
      Metadata: { facturaId: '123', relayo_message_id: 'msg_1' },
    });
  });

  it('maps headers and inline attachments', () => {
    const body = toPostmarkRequest(
      { ...message, headers: { 'X-Campaign': 'oct' }, attachments: [{ filename: 'logo.png', content: new Uint8Array([1]), contentType: 'image/png', cid: 'logo' }] },
      { messageId: 'm' },
    );
    expect(body).toMatchObject({
      Headers: [{ Name: 'X-Campaign', Value: 'oct' }],
      Attachments: [{ Name: 'logo.png', Content: 'AQ==', ContentType: 'image/png', ContentID: 'cid:logo' }],
    });
  });

  it('refuses more than one tag', () => {
    expect(() => toPostmarkRequest({ ...message, tags: ['a', 'b'] }, { messageId: 'm' })).toThrow(/one tag/);
  });

  it.each([
    [401, 10, AuthenticationError],
    [422, 300, ValidationError],
    [422, 406, RejectedError],
    [422, 412, AuthenticationError],
    [429, undefined, RateLimitError],
    [500, 101, ProviderUnavailableError],
    [503, 100, ProviderUnavailableError],
  ])('maps HTTP %i with ErrorCode %s', async (status, code, expected) => {
    const fetch = fakeFetch(() => Response.json({ ErrorCode: code, Message: 'nope' }, { status }));
    const error = await createRelayo({ email: postmark({ serverToken: 't', fetch }) }).email.send(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(expected);
    expect(error).toMatchObject({ provider: 'postmark', raw: { status, errorCode: code } });
  });
});

describe('webhooks', () => {
  const relayo = () => createRelayo({ email: postmark({ serverToken: 't', webhook: { basicAuth: AUTH } }) });

  it('normalizes a hard bounce with Relayo id and metadata', async () => {
    const [event] = await relayo().handleWebhook('email', withAuth(events.hardBounce));
    expect(event).toMatchObject({
      id: 'Bounce:692560173',
      type: 'bounced',
      provider: 'postmark',
      messageId: ID,
      providerMessageId: '883953f4-6105-42a2-a16a-77a8eac79483',
      recipient: 'noexiste@example.com',
      bounceType: 'hard',
      reason: 'user_unknown',
      smtpCode: 550,
      enhancedCode: '5.1.1',
      metadata: { facturaId: '123' },
    });
  });

  it.each([
    ['hardBounceBlocklisted', 'block', 'reputation_block'],
    ['blocked', 'block', 'policy_block'],
    ['dmarc', 'block', 'auth_failure'],
    ['softBounce', 'soft', 'mailbox_full'],
  ])('classifies %s as %s/%s', async (fixture, bounceType, reason) => {
    const [event] = await relayo().handleWebhook('email', withAuth(events[fixture]));
    expect(event).toMatchObject({ type: 'bounced', bounceType, reason });
  });

  it.each([
    ['delivery', 'delivered'],
    ['open', 'opened'],
    ['spamComplaint', 'complained'],
    ['unsubscribe', 'unsubscribed'],
    ['transient', 'deferred'],
  ])('maps %s to %s', async (fixture, type) => {
    const [event] = await relayo().handleWebhook('email', withAuth(events[fixture]));
    expect(event!.type).toBe(type);
  });

  it('keeps click URLs and skips auto-replies and reactivations', async () => {
    expect((await relayo().handleWebhook('email', withAuth(events.click)))[0]).toMatchObject({ url: 'https://empresa.com/factura/123' });
    await expect(relayo().handleWebhook('email', withAuth(events.autoResponder))).resolves.toEqual([]);
    await expect(relayo().handleWebhook('email', withAuth(events.reactivated))).resolves.toEqual([]);
  });

  it('refuses requests without the right credentials', async () => {
    await expect(relayo().handleWebhook('email', { headers: {}, body: events.delivery })).rejects.toThrow(/Invalid webhook signature/);
    await expect(
      relayo().handleWebhook('email', withAuth(events.delivery, { username: 'postmark', password: 'wrong' })),
    ).rejects.toThrow(/Invalid webhook signature/);
  });

  it('demands credentials unless authentication is off', async () => {
    const req = { headers: {}, body: events.delivery };
    await expect(createRelayo({ email: postmark({ serverToken: 't' }) }).handleWebhook('email', req)).rejects.toThrow(/does not sign webhooks/);
    await expect(
      createRelayo({ email: postmark({ serverToken: 't', webhook: { authenticate: false } }) }).handleWebhook('email', req),
    ).resolves.toHaveLength(1);
  });
});
