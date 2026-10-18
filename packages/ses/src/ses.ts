import {
  SendEmailCommand,
  SESv2Client,
  type Attachment,
  type MessageHeader,
  type MessageTag,
  type SendEmailCommandInput,
  type SESv2ClientConfig,
} from '@aws-sdk/client-sesv2';
import {
  ValidationError,
  type Driver,
  type EmailMessage,
  type Recipient,
  type RelayoEvent,
  type SendContext,
  type SendResult,
  type WebhookRequest,
} from '@alimzen/core';
import { toRelayoError } from './errors.js';
import {
  encodeMetadata,
  MESSAGE_ID_HEADER,
  MESSAGE_ID_TAG,
  METADATA_HEADER,
  parseSesEvent,
  type SesEvent,
} from './events.js';
import { createSnsVerifier, isSnsMessage, isSnsUrl, readBody, type CertificateFetcher } from './sns.js';

export interface SesWebhookOptions {
  /** Only accept SNS messages from these topics. Recommended in production. */
  topicArns?: string[];
  /** Check SNS signatures. Disable only when events arrive through a trusted channel (e.g. EventBridge). Default true. */
  verifySignature?: boolean;
  /** Confirm SNS subscriptions automatically by visiting their SubscribeURL. Default true. */
  confirmSubscriptions?: boolean;
  /** Override how SNS signing certificates are fetched (tests, proxies). */
  fetchCertificate?: CertificateFetcher;
}

export interface SesDriverOptions {
  region?: string;
  credentials?: SESv2ClientConfig['credentials'];
  /** Use an existing client instead of creating one. `region` and `credentials` are then ignored. */
  client?: SESv2Client;
  /** Configuration set used for event publishing (deliveries, bounces, opens, clicks...). */
  configurationSetName?: string;
  /**
   * Send `metadata` in the `X-Relayo-Metadata` header so it comes back in events. Recipients can see
   * the header (base64-encoded JSON), so turn it off if metadata is sensitive. Default true.
   */
  metadataHeader?: boolean;
  /** Provider name reported in results, events and errors. Defaults to `"ses"`. */
  name?: string;
  webhook?: SesWebhookOptions;
}

export interface SesDriver extends Driver<EmailMessage> {
  readonly client: SESv2Client;
}

const TAG_CHARS = /[^A-Za-z0-9_-]/g;

/**
 * Amazon SES (v2 API) driver. Events arrive through SNS: point an SNS HTTPS subscription at your
 * webhook endpoint and pass each request to `relayo.handleWebhook('email', req)`.
 *
 * `providerOptions` are merged into the `SendEmail` request (e.g. `{ FeedbackForwardingEmailAddress }`).
 */
export function ses(options: SesDriverOptions = {}): SesDriver {
  const name = options.name ?? 'ses';
  const client =
    options.client ??
    new SESv2Client({
      ...(options.region && { region: options.region }),
      ...(options.credentials && { credentials: options.credentials }),
    });
  const webhook = options.webhook ?? {};
  const verifySns = createSnsVerifier({
    ...(webhook.topicArns && { topicArns: webhook.topicArns }),
    ...(webhook.fetchCertificate && { fetchCertificate: webhook.fetchCertificate }),
  });

  return {
    name,
    channel: 'email',
    client,
    capabilities: {
      batch: false,
      attachments: true,
      scheduling: false,
      tracking: true,
      webhooks: true,
    },

    async send(message, context) {
      let response;
      try {
        response = await client.send(new SendEmailCommand(toSendEmailInput(message, context, options)));
      } catch (error) {
        throw toRelayoError(error, name);
      }
      const result: SendResult = { messageId: context.messageId, provider: name, status: 'queued' };
      if (response.MessageId) result.providerMessageId = response.MessageId;
      return result;
    },

    async verifyWebhook(req) {
      if (webhook.verifySignature === false) return true;
      const body = readBody(req);
      return isSnsMessage(body) && verifySns(body);
    },

    async parseWebhook(req: WebhookRequest): Promise<RelayoEvent[]> {
      const body = readBody(req) as Record<string, unknown>;

      if (isSnsMessage(body)) {
        if (body.Type === 'SubscriptionConfirmation') {
          if (webhook.confirmSubscriptions !== false) await confirmSubscription(body.SubscribeURL);
          return [];
        }
        if (body.Type !== 'Notification') return [];
        return parseSesEvent(JSON.parse(body.Message) as SesEvent, { provider: name, deliveryId: body.MessageId });
      }
      // EventBridge delivers the SES event under `detail`.
      if (body && typeof body.detail === 'object' && typeof body.id === 'string') {
        return parseSesEvent(body.detail as SesEvent, { provider: name, deliveryId: body.id });
      }
      if (body && typeof body.mail === 'object') return parseSesEvent(body as unknown as SesEvent, { provider: name });

      throw new ValidationError('Unrecognized SES webhook payload', { provider: name, raw: body });
    },
  };
}

async function confirmSubscription(url: string | undefined): Promise<void> {
  if (!isSnsUrl(url)) throw new ValidationError(`Refusing to confirm SNS subscription at ${url}`);
  const response = await fetch(url!);
  if (!response.ok) throw new Error(`SNS subscription confirmation failed: HTTP ${response.status}`);
}

export function toSendEmailInput(
  message: EmailMessage,
  context: SendContext,
  options: Pick<SesDriverOptions, 'configurationSetName' | 'metadataHeader'> = {},
): SendEmailCommandInput {
  const headers: MessageHeader[] = Object.entries(message.headers ?? {}).map(([Name, Value]) => ({ Name, Value }));
  headers.push({ Name: MESSAGE_ID_HEADER, Value: context.messageId });
  if (message.metadata && options.metadataHeader !== false) {
    headers.push({ Name: METADATA_HEADER, Value: encodeMetadata(message.metadata) });
  }

  const tags: MessageTag[] = [{ Name: MESSAGE_ID_TAG, Value: sanitizeTag(context.messageId) }];
  for (const tag of message.tags ?? []) tags.push({ Name: sanitizeTag(tag), Value: 'true' });

  const to = Array.isArray(message.to) ? message.to : [message.to];
  const input: SendEmailCommandInput = {
    FromEmailAddress: formatAddress(message.from),
    Destination: {
      ToAddresses: to.map(formatAddress),
      ...(message.cc && { CcAddresses: message.cc.map(formatAddress) }),
      ...(message.bcc && { BccAddresses: message.bcc.map(formatAddress) }),
    },
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: 'UTF-8' },
        Body: {
          ...(message.html !== undefined && { Html: { Data: message.html, Charset: 'UTF-8' } }),
          ...(message.text !== undefined && { Text: { Data: message.text, Charset: 'UTF-8' } }),
        },
        Headers: headers,
        ...(message.attachments && { Attachments: message.attachments.map(toAttachment) }),
      },
    },
    EmailTags: tags,
    ...(options.configurationSetName && { ConfigurationSetName: options.configurationSetName }),
  };
  if (message.replyTo) input.ReplyToAddresses = [formatAddress(message.replyTo)];
  return { ...input, ...(message.providerOptions as Partial<SendEmailCommandInput> | undefined) };
}

function toAttachment(a: NonNullable<EmailMessage['attachments']>[number]): Attachment {
  return {
    FileName: a.filename,
    RawContent: typeof a.content === 'string' ? Buffer.from(a.content, 'utf8') : a.content,
    ContentDisposition: a.cid ? 'INLINE' : 'ATTACHMENT',
    ...(a.contentType && { ContentType: a.contentType }),
    ...(a.cid && { ContentId: a.cid }),
  };
}

/** RFC 5322 address with the display name quoted, or MIME-encoded when it isn't ASCII. */
export function formatAddress(recipient: Recipient): string {
  if (!recipient.name) return recipient.address;
  const name = /^[\x20-\x7e]*$/.test(recipient.name)
    ? `"${recipient.name.replace(/["\\]/g, '\\$&')}"`
    : `=?UTF-8?B?${Buffer.from(recipient.name, 'utf8').toString('base64')}?=`;
  return `${name} <${recipient.address}>`;
}

function sanitizeTag(value: string): string {
  return value.replace(TAG_CHARS, '_').slice(0, 256);
}
