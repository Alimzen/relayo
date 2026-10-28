import { createHash, createHmac } from 'node:crypto';
import { AuthenticationError, createRelayo, RateLimitError, RejectedError, ValidationError } from '@alimzen/relayo';
import { describe, expect, it, vi } from 'vitest';
import { toEvents, verifyVonageSignature, vonage } from '../src/index.js';

const CALLBACK = 'https://app.example.com/webhooks/relayo/vonage';
const SECRET = 'signature-secret';

function fakeFetch(handler: (form: URLSearchParams) => Response) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => handler(init!.body as URLSearchParams));
}

const ok = (id: string) => Response.json({ 'message-count': '1', messages: [{ to: '34600111222', 'message-id': id, status: '0' }] });
const status = (code: string, text: string) => Response.json({ 'message-count': '1', messages: [{ status: code, 'error-text': text }] });

const driver = (fetch: typeof globalThis.fetch, extra = {}) =>
  vonage({ apiKey: 'key', apiSecret: 'secret', from: 'Empresa', callbackUrl: CALLBACK, fetch, ...extra });

/** A delivery receipt, signed the way Vonage signs them. */
function signed(params: Record<string, string>, method: 'md5hash' | 'sha256' = 'md5hash') {
  const all = { ...params, timestamp: String(Math.floor(Date.now() / 1000)) };
  const base = Object.keys(all)
    .sort()
    .map((k) => `&${k}=${all[k as keyof typeof all].replace(/[&=]/g, '_')}`)
    .join('');
  const sig = method === 'md5hash' ? createHash('md5').update(base + SECRET).digest('hex') : createHmac('sha256', SECRET).update(base).digest('hex');
  return { ...all, sig };
}

const receipt = (status: string, errCode = '0') => ({
  msisdn: '34600111222',
  to: 'Empresa',
  'network-code': '21401',
  messageId: '0A0000001234',
  price: '0.03',
  status,
  scts: '2610181200',
  'err-code': errCode,
  'api-key': 'key',
  'message-timestamp': '2026-10-18 12:00:05',
  'client-ref': 'msg_1',
});

describe('vonage driver', () => {
  it('sends one message per recipient with Relayo\'s id as client-ref', async () => {
    const fetch = fakeFetch(() => ok('0A0000001234'));
    const relayo = createRelayo({ sms: driver(fetch), generateId: () => 'msg_1' });

    const result = await relayo.sms.send({ to: [{ address: '+34600111222' }, { address: '+34600333444' }], body: 'Tu código: 1234' });

    expect(result).toMatchObject({ messageId: 'msg_1', providerMessageId: '0A0000001234', provider: 'vonage' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![0]).toBe('https://rest.nexmo.com/sms/json');
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: `Basic ${Buffer.from('key:secret').toString('base64')}` });
    expect(Object.fromEntries(fetch.mock.calls[0]![1]!.body as URLSearchParams)).toEqual({
      from: 'Empresa',
      to: '34600111222',
      text: 'Tu código: 1234',
      'client-ref': 'msg_1',
      type: 'unicode',
      callback: CALLBACK,
    });
  });

  it('reads each message\'s status: a barred number is skipped among several, others are errors', async () => {
    const fetch = fakeFetch((form) => (form.get('to') === '34600333444' ? status('7', 'Number barred.') : ok('id1')));
    const relayo = createRelayo({ sms: driver(fetch) });
    const result = await relayo.sms.send({ to: [{ address: '+34600111222' }, { address: '+34600333444' }], body: 'hola' });
    expect(result.rejectedRecipients).toEqual(['+34600333444']);
    expect(Object.fromEntries(fetch.mock.calls[0]![1]!.body as URLSearchParams).type).toBe('text');

    const fails = async (code: string) =>
      createRelayo({ sms: driver(fakeFetch(() => status(code, 'x'))) })
        .sms.send({ to: { address: '+34600111222' }, body: 'hola' })
        .catch((e: unknown) => e);
    expect(await fails('1')).toBeInstanceOf(RateLimitError);
    expect(await fails('4')).toBeInstanceOf(AuthenticationError);
    expect(await fails('6')).toBeInstanceOf(RejectedError);
    expect(await fails('15')).toBeInstanceOf(ValidationError);
    expect(() => vonage({ apiKey: '', apiSecret: 'x' })).toThrow(ValidationError);
  });

  it('turns delivery receipts into events, mapped back through client-ref', () => {
    const [delivered] = toEvents(receipt('delivered'), 'vonage');
    expect(delivered).toMatchObject({
      type: 'delivered',
      messageId: 'msg_1',
      providerMessageId: '0A0000001234',
      recipient: '+34600111222',
      timestamp: new Date('2026-10-18T12:00:05Z'),
    });
    expect(toEvents(receipt('failed', '3'), 'vonage')[0]).toMatchObject({ type: 'bounced', bounceType: 'hard', reason: 'user_unknown' });
    expect(toEvents(receipt('rejected', '6'), 'vonage')[0]).toMatchObject({ type: 'bounced', bounceType: 'block', reason: 'content_rejected' });
    expect(toEvents(receipt('failed', '9'), 'vonage')[0]).toMatchObject({ type: 'rejected', reason: 'suppressed' });
    expect(toEvents(receipt('expired', '2'), 'vonage')[0]).toMatchObject({ type: 'bounced', bounceType: 'soft' });
    expect(toEvents(receipt('failed', '99'), 'vonage')[0]).toMatchObject({ type: 'failed' });
    expect(toEvents(receipt('buffered'), 'vonage')[0]).toMatchObject({ type: 'deferred' });
    expect(toEvents(receipt('unknown'), 'vonage')).toEqual([]);
  });

  it('reads receipts posted as JSON or sent in the query, and checks signatures when there is a secret', async () => {
    const unsigned = driver(fakeFetch(() => ok('x')));
    const json = JSON.stringify(receipt('delivered'));
    expect(await unsigned.verifyWebhook!({ headers: {}, body: JSON.parse(json), rawBody: json })).toBe(true);
    expect((await unsigned.parseWebhook!({ headers: {}, body: undefined, url: `/hooks?${new URLSearchParams(receipt('delivered'))}` }))[0]).toMatchObject({
      type: 'delivered',
    });

    const md5 = signed(receipt('delivered'));
    const strict = driver(fakeFetch(() => ok('x')), { webhook: { signatureSecret: SECRET } });
    expect(await strict.verifyWebhook!({ headers: {}, body: md5 })).toBe(true);
    expect(await strict.verifyWebhook!({ headers: {}, body: { ...md5, status: 'failed' } })).toBe(false);
    expect(await strict.verifyWebhook!({ headers: {}, body: receipt('delivered') })).toBe(false);

    const sha = signed(receipt('delivered'), 'sha256');
    expect(verifyVonageSignature(sha, SECRET, 'sha256')).toBe(true);
    expect(verifyVonageSignature({ ...sha, timestamp: '1000' }, SECRET, 'sha256')).toBe(false);
  });
});
