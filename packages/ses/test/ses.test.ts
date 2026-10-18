import { generateKeyPairSync, sign } from 'node:crypto';
import {
  MessageRejected,
  SendEmailCommand,
  TooManyRequestsException,
  type SESv2Client,
} from '@aws-sdk/client-sesv2';
import {
  AuthenticationError,
  createRelayo,
  failover,
  memory,
  ProviderUnavailableError,
  RateLimitError,
  RejectedError,
  ValidationError,
  WebhookVerificationError,
  type BounceEvent,
  type EmailMessage,
} from '@alimzen/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatAddress,
  parseSesEvent,
  ses,
  stringToSign,
  toRelayoError,
  toSendEmailInput,
  type SesEvent,
  type SnsMessage,
} from '../src/index.js';
import fixtures from './fixtures/ses-events.json';

const events = fixtures as unknown as Record<string, SesEvent>;

const message: EmailMessage = {
  from: { address: 'facturas@empresa.com', name: 'Facturas' },
  to: { address: 'cliente@example.com' },
  subject: 'Tu factura de octubre',
  html: '<p>Hola</p>',
  metadata: { facturaId: '123' },
  tags: ['facturas', 'mes octubre'],
};

function fakeClient(send: (command: SendEmailCommand) => unknown) {
  return { send: vi.fn(async (c: SendEmailCommand) => send(c)) } as unknown as SESv2Client & {
    send: ReturnType<typeof vi.fn>;
  };
}

// --- SNS signing helpers: a local key pair stands in for Amazon's certificate ---
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem';
const TOPIC = 'arn:aws:sns:us-east-1:123456789012:relayo-events';
const fetchCertificate = vi.fn(async () => publicKey.export({ type: 'spki', format: 'pem' }).toString());

function snsMessage(fields: Partial<SnsMessage>): SnsMessage {
  const msg = {
    Type: 'Notification',
    MessageId: 'sns-0001',
    TopicArn: TOPIC,
    Message: '{}',
    Timestamp: '2026-10-17T10:00:04.000Z',
    SignatureVersion: '2',
    SigningCertURL: CERT_URL,
    Signature: '',
    ...fields,
  } as SnsMessage;
  const algorithm = msg.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256';
  msg.Signature = sign(algorithm, Buffer.from(stringToSign(msg)), privateKey).toString('base64');
  return msg;
}

const notification = (event: SesEvent, fields: Partial<SnsMessage> = {}) =>
  snsMessage({ Message: JSON.stringify(event), ...fields });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sending', () => {
  it('sends through SESv2 with Relayo id as tag and header, metadata header and configuration set', async () => {
    const client = fakeClient(() => ({ MessageId: 'ses-123', $metadata: {} }));
    const relayo = createRelayo({
      email: ses({ client, configurationSetName: 'relayo' }),
      generateId: () => 'msg_1',
    });

    const result = await relayo.email.send(message);

    expect(result).toEqual({ messageId: 'msg_1', providerMessageId: 'ses-123', provider: 'ses', status: 'queued' });
    const input = (client.send.mock.calls[0]![0] as SendEmailCommand).input;
    expect(input).toMatchObject({
      FromEmailAddress: '"Facturas" <facturas@empresa.com>',
      Destination: { ToAddresses: ['cliente@example.com'] },
      ConfigurationSetName: 'relayo',
      EmailTags: [
        { Name: 'relayo_message_id', Value: 'msg_1' },
        { Name: 'facturas', Value: 'true' },
        { Name: 'mes_octubre', Value: 'true' },
      ],
    });
    expect(input.Content?.Simple?.Headers).toEqual([
      { Name: 'X-Relayo-Message-ID', Value: 'msg_1' },
      { Name: 'X-Relayo-Metadata', Value: Buffer.from('{"facturaId":"123"}').toString('base64url') },
    ]);
  });

  it('maps attachments and leaves metadata out when asked', () => {
    const input = toSendEmailInput(
      { ...message, attachments: [{ filename: 'logo.png', content: new Uint8Array([1]), cid: 'logo' }] },
      { messageId: 'msg_1' },
      { metadataHeader: false },
    );
    expect(input.Content?.Simple?.Attachments).toEqual([
      { FileName: 'logo.png', RawContent: new Uint8Array([1]), ContentDisposition: 'INLINE', ContentId: 'logo' },
    ]);
    expect(input.Content?.Simple?.Headers).toHaveLength(1);
  });

  it('formats display names safely', () => {
    expect(formatAddress({ address: 'a@x.com', name: 'Pérez, Ana' })).toBe(
      `=?UTF-8?B?${Buffer.from('Pérez, Ana').toString('base64')}?= <a@x.com>`,
    );
    expect(formatAddress({ address: 'a@x.com', name: 'Ana "La" Jefa' })).toBe('"Ana \\"La\\" Jefa" <a@x.com>');
  });

  it.each([
    [new MessageRejected({ message: 'Email address is not verified.', $metadata: { httpStatusCode: 400 } }), RejectedError],
    [new TooManyRequestsException({ message: 'Too many requests', $metadata: { httpStatusCode: 429 } }), RateLimitError],
    [Object.assign(new Error('The security token included in the request is invalid.'), { name: 'UnrecognizedClientException', $metadata: { httpStatusCode: 403 } }), AuthenticationError],
    [Object.assign(new Error('Missing final @domain'), { name: 'BadRequestException', $fault: 'client', $metadata: { httpStatusCode: 400 } }), ValidationError],
    [Object.assign(new Error('Internal error'), { name: 'InternalServiceErrorException', $fault: 'server', $metadata: { httpStatusCode: 500 } }), ProviderUnavailableError],
    [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), ProviderUnavailableError],
  ])('maps SDK error %#', async (error, expected) => {
    const relayo = createRelayo({ email: ses({ client: fakeClient(() => Promise.reject(error)) }) });
    const thrown = await relayo.email.send(message).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(expected);
    expect(thrown).toMatchObject({ provider: 'ses' });
  });

  it('keeps AWS details in raw', () => {
    const error = toRelayoError(
      new MessageRejected({ message: 'nope', $metadata: { httpStatusCode: 400, requestId: 'req-1' } }),
      'ses',
    );
    expect(error.raw).toEqual({ name: 'MessageRejected', message: 'nope', httpStatusCode: 400, requestId: 'req-1' });
  });
});

describe('event normalization', () => {
  const parse = (event: SesEvent) => parseSesEvent(event, { provider: 'ses', deliveryId: 'sns-1' });

  it('maps a 5.1.1 bounce to hard/user_unknown with Relayo id and metadata', () => {
    const [event] = parse(events.bounceUserUnknown!) as BounceEvent[];
    expect(event).toMatchObject({
      id: 'sns-1:0',
      type: 'bounced',
      channel: 'email',
      provider: 'ses',
      messageId: '7b1f3c9e-6a4d-4c1e-9d2b-1f0e8a7c6b5d',
      providerMessageId: '0100017e8f8a0a0a-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-000000',
      recipient: 'cliente@example.com',
      bounceType: 'hard',
      reason: 'user_unknown',
      smtpCode: 550,
      enhancedCode: '5.1.1',
      metadata: { facturaId: '123' },
    });
    expect(event!.timestamp).toEqual(new Date('2026-10-17T10:00:02.669Z'));
    expect(event!.raw).toBe(events.bounceUserUnknown);
  });

  it('treats a permanent bounce from a blocklist as block, not hard', () => {
    expect(parse(events.bounceBlocklisted!)[0]).toMatchObject({ bounceType: 'block', reason: 'reputation_block' });
  });

  it('uses the SES subtype when there is no SMTP status', () => {
    expect(parse(events.bounceMailboxFull!)[0]).toMatchObject({ bounceType: 'soft', reason: 'mailbox_full' });
    expect(parse(events.notificationBounce!)[0]).toMatchObject({
      type: 'bounced',
      bounceType: 'hard',
      reason: 'user_unknown',
      messageId: '000001378603177f-notification-msg',
    });
  });

  it('turns suppression-list bounces into rejected events', () => {
    expect(parse(events.bounceSuppressed!)[0]).toMatchObject({
      type: 'rejected',
      reason: 'suppressed',
      recipient: 'suprimido@example.com',
    });
  });

  it.each([
    ['complaint', 'complained', 1],
    ['delivery', 'delivered', 2],
    ['deliveryDelay', 'deferred', 1],
    ['send', 'accepted', 1],
    ['reject', 'rejected', 1],
    ['click', 'clicked', 1],
  ])('maps %s to %s', (fixture, type, count) => {
    const result = parse(events[fixture]!);
    expect(result).toHaveLength(count);
    expect(result.every((e) => e.type === type)).toBe(true);
    expect(new Set(result.map((e) => e.id)).size).toBe(count);
  });

  it('keeps the clicked URL', () => {
    expect(parse(events.click!)[0]).toMatchObject({ url: 'https://empresa.com/factura/123' });
  });
});

describe('webhooks through SNS', () => {
  const driver = () => ses({ client: fakeClient(() => ({})), webhook: { fetchCertificate, topicArns: [TOPIC] } });

  it('verifies, parses and emits a signed notification', async () => {
    const relayo = createRelayo({ email: driver() });
    const onBounce = vi.fn();
    relayo.on('bounced', onBounce);

    const body = JSON.stringify(notification(events.bounceUserUnknown!));
    const result = await relayo.handleWebhook('email', { headers: {}, body, rawBody: body });

    expect(result).toHaveLength(1);
    expect(onBounce).toHaveBeenCalledWith(expect.objectContaining({ id: 'sns-0001:0', bounceType: 'hard' }));
  });

  it('accepts signature version 1 and an already-parsed body', async () => {
    const relayo = createRelayo({ email: driver() });
    const body = notification(events.delivery!, { SignatureVersion: '1' });
    await expect(relayo.handleWebhook('email', { headers: {}, body })).resolves.toHaveLength(2);
  });

  it.each([
    ['a tampered message', (m: SnsMessage) => ({ ...m, Message: m.Message.replace('5.1.1', '4.2.2') })],
    ['a foreign topic', (m: SnsMessage) => snsMessage({ ...m, TopicArn: 'arn:aws:sns:us-east-1:999:evil' })],
    ['a certificate outside amazonaws.com', (m: SnsMessage) => snsMessage({ ...m, SigningCertURL: 'https://evil.example.com/cert.pem' })],
    ['an unknown signature version', (m: SnsMessage) => ({ ...m, SignatureVersion: '3' as '2' })],
  ])('rejects %s', async (_, tamper) => {
    const relayo = createRelayo({ email: driver() });
    const handler = vi.fn();
    relayo.on('*', handler);

    const body = tamper(notification(events.bounceUserUnknown!));
    await expect(relayo.handleWebhook('email', { headers: {}, body })).rejects.toThrow(WebhookVerificationError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('confirms subscriptions only against SNS URLs', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const relayo = createRelayo({ email: driver() });
    const subscribeUrl = `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${TOPIC}&Token=t`;

    const body = snsMessage({ Type: 'SubscriptionConfirmation', SubscribeURL: subscribeUrl, Token: 't' });
    await expect(relayo.handleWebhook('email', { headers: {}, body })).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(subscribeUrl);
  });

  it('fetches each signing certificate once', async () => {
    fetchCertificate.mockClear();
    const relayo = createRelayo({ email: driver() });
    await relayo.handleWebhook('email', { headers: {}, body: notification(events.send!) });
    await relayo.handleWebhook('email', { headers: {}, body: notification(events.send!) });
    expect(fetchCertificate).toHaveBeenCalledOnce();
  });

  it('works as one leg of a failover: falls back on outages and routes webhooks by signature', async () => {
    const outage = Object.assign(new Error('Service unavailable'), {
      name: 'InternalServiceErrorException',
      $fault: 'server',
      $metadata: { httpStatusCode: 503 },
    });
    const backup = memory({ name: 'backup' });
    const relayo = createRelayo({
      email: failover([
        ses({ client: fakeClient(() => Promise.reject(outage)), webhook: { fetchCertificate, topicArns: [TOPIC] } }),
        backup,
      ]),
    });

    const { messageId, provider } = await relayo.email.send(message);
    expect(provider).toBe('backup');

    // A signed SNS notification goes to SES...
    const fromSes = await relayo.handleWebhook('email', { headers: {}, body: notification(events.send!) });
    expect(fromSes[0]).toMatchObject({ provider: 'ses', type: 'accepted' });

    // ...and a payload SES can't verify falls through to the driver that can parse it, when named.
    const fromBackup = await relayo.handleWebhook('email', {
      provider: 'backup',
      headers: {},
      body: backup.createEvent(messageId, 'delivered'),
    });
    expect(fromBackup[0]).toMatchObject({ provider: 'backup', type: 'delivered', messageId });
  });

  it('parses EventBridge events when signature checks are off', async () => {
    const relayo = createRelayo({ email: ses({ client: fakeClient(() => ({})), webhook: { verifySignature: false } }) });
    const body = { id: 'eb-1', 'detail-type': 'Email Bounced', source: 'aws.ses', detail: events.bounceUserUnknown };
    const [event] = await relayo.handleWebhook('email', { headers: {}, body });
    expect(event).toMatchObject({ id: 'eb-1:0', type: 'bounced' });
  });
});
