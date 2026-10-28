import { createHash, createHmac } from 'node:crypto';
import { AuthenticationError, createRelayo, RejectedError, ValidationError } from '@alimzen/relayo';
import { describe, expect, it, vi } from 'vitest';
import { messagebird, toEvents } from '../src/index.js';

const KEY = 'signing-key';
const REPORT_URL = 'https://app.example.com/webhooks/relayo/messagebird';

function fakeFetch(handler: (body: Record<string, unknown>) => Response) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => handler(JSON.parse(String(init!.body)) as Record<string, unknown>));
}

const created = (recipients: string[], status = 'sent') =>
  Response.json(
    { id: 'mb_1', recipients: { totalCount: recipients.length, items: recipients.map((r) => ({ recipient: Number(r), status })) } },
    { status: 201 },
  );

const driver = (fetch: typeof globalThis.fetch) => messagebird({ accessKey: 'live_key', originator: 'Empresa', signingKey: KEY, reportUrl: REPORT_URL, fetch });

/** A JWT as MessageBird signs its requests. */
function jwt(claims: Record<string, unknown>, key = KEY) {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const payload = enc(claims);
  return `${head}.${payload}.${createHmac('sha256', key).update(`${head}.${payload}`).digest('base64url')}`;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const now = () => Math.floor(Date.now() / 1000);

const report = (status: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({
    id: 'mb_1',
    reference: 'msg_1',
    recipient: '34600111222',
    status,
    statusDatetime: '2026-10-18T12:00:05+00:00',
    ...extra,
  });

describe('messagebird driver', () => {
  it('sends to many recipients per request, with Relayo\'s id as reference', async () => {
    const fetch = fakeFetch((body) => created(body.recipients as string[]));
    const relayo = createRelayo({ sms: driver(fetch), generateId: () => 'msg_1' });
    const result = await relayo.sms.send({ to: [{ address: '+34600111222' }, { address: '+34600333444' }], body: 'Tu código: 1234' });

    expect(result).toMatchObject({ messageId: 'msg_1', providerMessageId: 'mb_1', provider: 'messagebird', status: 'queued' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('https://rest.messagebird.com/messages');
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: 'AccessKey live_key' });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({
      originator: 'Empresa',
      recipients: ['34600111222', '34600333444'],
      body: 'Tu código: 1234',
      reference: 'msg_1',
      datacoding: 'auto',
      reportUrl: REPORT_URL,
    });
    // More than 50: one request per 50.
    const many = Array.from({ length: 120 }, (_, i) => ({ address: `+3460000${String(i).padStart(4, '0')}` }));
    await relayo.sms.send({ to: many, body: 'x' });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('maps API errors', async () => {
    const fails = (status: number, code: number) =>
      createRelayo({ sms: driver(fakeFetch(() => Response.json({ errors: [{ code, description: 'x' }] }, { status }))) })
        .sms.send({ to: { address: '+34600111222' }, body: 'x' })
        .catch((e: unknown) => e);
    expect(await fails(401, 2)).toBeInstanceOf(AuthenticationError);
    expect(await fails(422, 9)).toBeInstanceOf(RejectedError);
    expect(await fails(422, 10)).toBeInstanceOf(ValidationError);
  });

  it('turns status reports into events', () => {
    const params = (status: string, extra = {}) => Object.fromEntries(report(status, extra));
    expect(toEvents(params('delivered'), 'messagebird')[0]).toMatchObject({
      type: 'delivered',
      messageId: 'msg_1',
      providerMessageId: 'mb_1',
      recipient: '+34600111222',
      timestamp: new Date('2026-10-18T12:00:05Z'),
    });
    expect(toEvents(params('sent'), 'messagebird')[0]?.type).toBe('accepted');
    expect(toEvents(params('delivery_failed', { statusReason: 'unknown subscriber', statusErrorCode: '1' }), 'messagebird')[0]).toMatchObject({
      type: 'bounced',
      bounceType: 'hard',
      reason: 'user_unknown',
      diagnostic: 'unknown subscriber · error 1',
    });
    expect(toEvents(params('delivery_failed', { statusReason: 'unavailable subscriber' }), 'messagebird')[0]).toMatchObject({ bounceType: 'soft' });
    expect(toEvents(params('expired'), 'messagebird')[0]).toMatchObject({ type: 'bounced', bounceType: 'soft', reason: 'temporary_failure' });
    expect(toEvents(params('scheduled'), 'messagebird')).toEqual([]);
  });

  it('checks the signature over the URL called, and the body when there is one', async () => {
    const d = driver(fakeFetch(() => created([])));
    const url = `${REPORT_URL}?${report('delivered')}`;
    const good = jwt({ iss: 'MessageBird', nbf: now() - 5, exp: now() + 300, jti: 'j1', url_hash: sha256(url) });
    const req = (token: string, target = url) => ({ headers: { 'MessageBird-Signature-JWT': token }, body: undefined, url: target });

    expect(await d.verifyWebhook!(req(good))).toBe(true);
    expect((await d.parseWebhook!(req(good)))[0]).toMatchObject({ type: 'delivered', messageId: 'msg_1' });
    // Another URL (a changed query), another key, an expired token, another issuer.
    expect(await d.verifyWebhook!(req(good, url.replace('delivered', 'expired')))).toBe(false);
    expect(await d.verifyWebhook!(req(jwt({ iss: 'MessageBird', exp: now() + 300, url_hash: sha256(url) }, 'other')))).toBe(false);
    expect(await d.verifyWebhook!(req(jwt({ iss: 'MessageBird', exp: now() - 600, url_hash: sha256(url) })))).toBe(false);
    expect(await d.verifyWebhook!(req(jwt({ iss: 'Someone', exp: now() + 300, url_hash: sha256(url) })))).toBe(false);
    expect(await d.verifyWebhook!({ headers: {}, body: undefined, url })).toBe(false);

    // A POST with a body: its hash must match.
    const body = JSON.stringify(Object.fromEntries(report('delivered')));
    const posted = jwt({ iss: 'MessageBird', exp: now() + 300, url_hash: sha256(REPORT_URL), payload_hash: sha256(body) });
    expect(await d.verifyWebhook!({ headers: { 'messagebird-signature-jwt': posted }, body: JSON.parse(body), rawBody: body, url: REPORT_URL })).toBe(true);
    expect(await d.verifyWebhook!({ headers: { 'messagebird-signature-jwt': posted }, body: {}, rawBody: `${body} `, url: REPORT_URL })).toBe(false);
  });
});
