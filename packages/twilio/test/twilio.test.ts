import { createHmac } from 'node:crypto';
import { AuthenticationError, createRelayo, RejectedError, WebhookVerificationError } from '@alimzen/relayo';
import { describe, expect, it, vi } from 'vitest';
import { twilio } from '../src/index.js';

const TOKEN = 'auth-token-123';
const CALLBACK = 'https://app.example.com/webhooks/relayo/sms';

function fakeFetch(handler: (form: URLSearchParams) => Response) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => handler(init!.body as URLSearchParams));
}

/** A status callback as Twilio would post it: form body, signed over the full URL. */
function callback(url: string, params: Record<string, string>, token = TOKEN) {
  const body = new URLSearchParams(params).toString();
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const signature = createHmac('sha1', token).update(data).digest('base64');
  return { headers: { 'x-twilio-signature': signature }, body, rawBody: body, url };
}

const driver = (fetch: typeof globalThis.fetch) =>
  twilio({ accountSid: 'AC123', authToken: TOKEN, from: '+15550001111', statusCallback: CALLBACK, fetch });

describe('twilio driver', () => {
  it('sends one message per recipient, with the status callback carrying Relayo\'s id', async () => {
    const fetch = fakeFetch(() => Response.json({ sid: 'SM1', status: 'queued' }, { status: 201 }));
    const relayo = createRelayo({ sms: driver(fetch), generateId: () => 'msg_1' });

    const result = await relayo.sms.send({ to: [{ address: '+34600111222' }, { address: '+34600333444' }], body: 'Tu código: 1234' });

    expect(result).toMatchObject({ messageId: 'msg_1', providerMessageId: 'SM1', provider: 'twilio' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![0]).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: `Basic ${Buffer.from(`AC123:${TOKEN}`).toString('base64')}` });
    const form = fetch.mock.calls[0]![1]!.body as URLSearchParams;
    expect(Object.fromEntries(form)).toEqual({
      To: '+34600111222',
      Body: 'Tu código: 1234',
      From: '+15550001111',
      StatusCallback: `${CALLBACK}?relayo_message_id=msg_1`,
    });
  });

  it('skips a bad or opted-out number among several, and maps errors', async () => {
    const fetch = fakeFetch((form) =>
      form.get('To') === '+1000'
        ? Response.json({ code: 21211, message: "The 'To' number is not a valid phone number." }, { status: 400 })
        : Response.json({ sid: 'SM2' }, { status: 201 }),
    );
    const result = await createRelayo({ sms: driver(fetch) }).sms.send({ to: [{ address: '+1000' }, { address: '+34600111222' }], body: 'x' });
    expect(result.rejectedRecipients).toEqual(['+1000']);

    await expect(createRelayo({ sms: driver(fetch) }).sms.send({ to: { address: '+1000' }, body: 'x' })).rejects.toBeInstanceOf(RejectedError);
    const unauthorized = fakeFetch(() => Response.json({ code: 20003, message: 'Authenticate' }, { status: 401 }));
    await expect(createRelayo({ sms: driver(unauthorized) }).sms.send({ to: { address: '+34600111222' }, body: 'x' })).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it('verifies the signature over the full URL and maps statuses to events', async () => {
    const relayo = createRelayo({ sms: driver(vi.fn()) });
    const url = `${CALLBACK}?relayo_message_id=msg_1`;

    const bounced = await relayo.handleWebhook('sms', callback(url, { MessageSid: 'SM1', MessageStatus: 'undelivered', To: '+34600111222', ErrorCode: '30005' }));
    expect(bounced).toEqual([
      expect.objectContaining({ type: 'bounced', bounceType: 'hard', reason: 'user_unknown', messageId: 'msg_1', providerMessageId: 'SM1', recipient: '+34600111222' }),
    ]);
    const delivered = await relayo.handleWebhook('sms', callback(url, { MessageSid: 'SM1', MessageStatus: 'delivered', To: '+34600111222' }));
    expect(delivered[0]).toMatchObject({ type: 'delivered', channel: 'sms' });
    const optedOut = await relayo.handleWebhook('sms', callback(url, { MessageSid: 'SM1', MessageStatus: 'failed', To: '+34600111222', ErrorCode: '21610' }));
    expect(optedOut[0]).toMatchObject({ type: 'rejected', reason: 'suppressed' });
    expect(await relayo.handleWebhook('sms', callback(url, { MessageSid: 'SM1', MessageStatus: 'queued', To: '+3' }))).toEqual([]);

    // The path alone resolves against the status callback's origin.
    const relative = callback(url, { MessageSid: 'SM1', MessageStatus: 'delivered', To: '+3' });
    expect(await relayo.handleWebhook('sms', { ...relative, url: '/webhooks/relayo/sms?relayo_message_id=msg_1' })).toHaveLength(1);

    await expect(relayo.handleWebhook('sms', callback(url, { MessageSid: 'SM1', MessageStatus: 'delivered', To: '+3' }, 'other-token'))).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
    const tampered = callback(url, { MessageSid: 'SM1', MessageStatus: 'delivered', To: '+3' });
    await expect(relayo.handleWebhook('sms', { ...tampered, url: `${CALLBACK}?relayo_message_id=other` })).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('turns a STOP reply into an unsubscribe of the sender', async () => {
    const relayo = createRelayo({ sms: driver(vi.fn()) });
    const events = await relayo.handleWebhook('sms', callback(CALLBACK, { MessageSid: 'SM9', From: '+34600111222', To: '+15550001111', Body: 'STOP', OptOutType: 'STOP' }));
    expect(events).toEqual([expect.objectContaining({ type: 'unsubscribed', recipient: '+34600111222' })]);
  });
});
