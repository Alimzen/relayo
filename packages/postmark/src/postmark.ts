import { timingSafeEqual } from 'node:crypto';
import {
  AuthenticationError,
  classifyBounce,
  ProviderUnavailableError,
  RateLimitError,
  RejectedError,
  ValidationError,
  type BounceClassification,
  type BounceEvent,
  type ClickEvent,
  type Driver,
  type EmailMessage,
  type EventType,
  type Recipient,
  type RejectEvent,
  type RelayoError,
  type RelayoEvent,
  type SendContext,
  type SendResult,
  type WebhookRequest,
} from '@alimzen/relayo';

export const MESSAGE_ID_KEY = 'relayo_message_id';
const SMTP_CODE = /\b([245]\d\d)\b/;
const STATUS_CODE = /\b([245]\.\d{1,3}\.\d{1,3})\b/;

export interface PostmarkWebhookOptions {
  /**
   * Postmark does not sign webhooks. Put credentials in the webhook URL
   * (`https://user:pass@example.com/webhooks/postmark`) and set them here: requests without them are refused.
   */
  basicAuth?: { username: string; password: string };
  /** Set to false to accept webhooks without credentials (e.g. behind your own authentication). Default true. */
  authenticate?: boolean;
}

export interface PostmarkDriverOptions {
  /** Server API token. */
  serverToken: string;
  /** Message stream. Default `"outbound"` (transactional); use your broadcast stream for bulk mail. */
  messageStream?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Provider name reported in results, events and errors. Defaults to `"postmark"`. */
  name?: string;
  webhook?: PostmarkWebhookOptions;
  fetch?: typeof fetch;
}

/**
 * Postmark driver. Relayo's message id and your `metadata` travel in Postmark's `Metadata`, which comes back
 * on every webhook. Postmark accepts one tag per message. `providerOptions` are merged into the request body
 * (e.g. `{ TrackOpens: true, TrackLinks: 'HtmlAndText' }`).
 */
export function postmark(options: PostmarkDriverOptions): Driver<EmailMessage> {
  if (!options.serverToken) throw new ValidationError('postmark() needs a serverToken');
  const name = options.name ?? 'postmark';
  const baseUrl = (options.baseUrl ?? 'https://api.postmarkapp.com').replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const webhook = options.webhook ?? {};

  return {
    name,
    channel: 'email',
    // Templates go to /email/withTemplate; Postmark has no scheduled sending.
    capabilities: { batch: false, attachments: true, scheduling: false, tracking: true, webhooks: true, templates: true },

    async send(message, context) {
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}${message.template ? '/email/withTemplate' : '/email'}`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Postmark-Server-Token': options.serverToken,
          },
          body: JSON.stringify(toPostmarkRequest(message, context, options.messageStream)),
          signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        });
      } catch (error) {
        throw new ProviderUnavailableError(`Postmark request failed: ${(error as Error).message}`, { provider: name, cause: error });
      }
      const body = (await response.json().catch(() => ({}))) as { ErrorCode?: number; Message?: string; MessageID?: string };
      if (!response.ok || (body.ErrorCode ?? 0) !== 0) throw errorFrom(response.status, body, name);

      const result: SendResult = { messageId: context.messageId, provider: name, status: 'queued' };
      if (body.MessageID) result.providerMessageId = body.MessageID;
      return result;
    },

    verifyWebhook(req) {
      if (webhook.authenticate === false) return true;
      if (!webhook.basicAuth) {
        throw new ValidationError(
          `Driver "${name}" has no webhook.basicAuth; Postmark does not sign webhooks, so put credentials in the webhook URL and here, or set webhook.authenticate to false`,
          { provider: name },
        );
      }
      return checkBasicAuth(req, webhook.basicAuth);
    },

    parseWebhook(req) {
      const body = readBody(req) as PostmarkWebhook;
      if (!body || typeof body.RecordType !== 'string') {
        throw new ValidationError('Unrecognized Postmark webhook payload', { provider: name, raw: body });
      }
      return parsePostmarkEvent(body, name);
    },
  };
}

export function toPostmarkRequest(message: EmailMessage, context: SendContext, messageStream?: string): Record<string, unknown> {
  if ((message.tags?.length ?? 0) > 1) {
    throw new ValidationError(`Postmark accepts one tag per message; got ${message.tags!.length}`);
  }
  const to = Array.isArray(message.to) ? message.to : [message.to];
  const body: Record<string, unknown> = {
    From: formatAddress(message.from),
    To: to.map(formatAddress).join(', '),
    Metadata: { ...message.metadata, [MESSAGE_ID_KEY]: context.messageId },
  };
  if (message.template) {
    // A number is a template id; anything else, its alias. The template brings subject and bodies.
    const id = message.template.id;
    if (/^\d+$/.test(id)) body.TemplateId = Number(id);
    else body.TemplateAlias = id;
    body.TemplateModel = message.template.variables ?? {};
  } else {
    body.Subject = message.subject;
  }
  if (messageStream) body.MessageStream = messageStream;
  if (message.cc?.length) body.Cc = message.cc.map(formatAddress).join(', ');
  if (message.bcc?.length) body.Bcc = message.bcc.map(formatAddress).join(', ');
  if (message.replyTo) body.ReplyTo = formatAddress(message.replyTo);
  if (!message.template && message.html !== undefined) body.HtmlBody = message.html;
  if (!message.template && message.text !== undefined) body.TextBody = message.text;
  if (message.tags?.[0]) body.Tag = message.tags[0];
  if (message.headers && Object.keys(message.headers).length) {
    body.Headers = Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value }));
  }
  if (message.attachments?.length) {
    body.Attachments = message.attachments.map((a) => ({
      Name: a.filename,
      Content: Buffer.from(typeof a.content === 'string' ? Buffer.from(a.content, 'utf8') : a.content).toString('base64'),
      ContentType: a.contentType ?? 'application/octet-stream',
      ...(a.cid && { ContentID: `cid:${a.cid}` }),
    }));
  }
  return { ...body, ...message.providerOptions };
}

function formatAddress(recipient: Recipient): string {
  return recipient.name ? `"${recipient.name.replace(/["\\]/g, '\\$&')}" <${recipient.address}>` : recipient.address;
}

/** Postmark API error codes: https://postmarkapp.com/developer/api/overview#error-codes */
function errorFrom(status: number, body: { ErrorCode?: number; Message?: string }, provider: string): RelayoError {
  const code = body.ErrorCode;
  const message = `Postmark ${status}${code ? ` (ErrorCode ${code})` : ''}: ${body.Message ?? 'request failed'}`;
  const options = { provider, raw: { status, errorCode: code, message: body.Message } };

  if (status === 429) return new RateLimitError(message, options);
  if (status >= 500 || code === 100 || code === 101) return new ProviderUnavailableError(message, options);
  if (status === 401 || code === 10) return new AuthenticationError(message, options);
  // 406: inactive recipient (bounced, complained or unsubscribed before).
  if (code === 406) return new RejectedError(message, options);
  // 412/413: account pending or not approved; 501: sender signature not found.
  if (code === 412 || code === 413 || code === 501) return new AuthenticationError(message, options);
  return new ValidationError(message, options);
}

function checkBasicAuth(req: WebhookRequest, credentials: { username: string; password: string }): boolean {
  const value = header(req, 'authorization');
  if (!value?.startsWith('Basic ')) return false;
  const given = Buffer.from(value.slice(6).trim(), 'base64');
  const expected = Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

interface PostmarkWebhook {
  RecordType: string;
  ID?: number;
  Type?: string;
  MessageID?: string;
  Metadata?: Record<string, string>;
  Email?: string;
  Recipient?: string;
  Description?: string;
  Details?: string;
  Inactive?: boolean;
  BouncedAt?: string;
  DeliveredAt?: string;
  ReceivedAt?: string;
  ChangedAt?: string;
  OriginalLink?: string;
  SuppressSending?: boolean;
  SuppressionReason?: string | null;
}

/** Postmark bounce types that are delivery problems, and how to read them when the details say nothing more. */
const BOUNCE_TYPES: Record<string, BounceClassification> = {
  HardBounce: { bounceType: 'hard', reason: 'user_unknown' },
  BadEmailAddress: { bounceType: 'hard', reason: 'user_unknown' },
  SoftBounce: { bounceType: 'soft', reason: 'temporary_failure' },
  Blocked: { bounceType: 'block', reason: 'policy_block' },
  DMARCPolicy: { bounceType: 'block', reason: 'auth_failure' },
  SpamNotification: { bounceType: 'block', reason: 'content_rejected' },
  VirusNotification: { bounceType: 'block', reason: 'content_rejected' },
  Unknown: { bounceType: 'soft', reason: 'unknown' },
};
/** Not about delivering this message: challenge requests, address changes, relay tests... */
const IGNORED_BOUNCE_TYPES = new Set(['AutoResponder', 'AddressChange', 'Subscribe', 'OpenRelayTest', 'ChallengeVerification', 'InboundError']);

export function parsePostmarkEvent(webhook: PostmarkWebhook, provider: string): RelayoEvent[] {
  const recipient = webhook.Recipient ?? webhook.Email ?? '';
  const metadata = { ...webhook.Metadata };
  const relayoId = metadata[MESSAGE_ID_KEY];
  delete metadata[MESSAGE_ID_KEY];

  const make = (type: EventType, at: string | undefined): RelayoEvent => {
    const event: RelayoEvent = {
      id: webhook.ID !== undefined ? `${webhook.RecordType}:${webhook.ID}` : `${webhook.MessageID}:${webhook.RecordType}:${recipient}:${at}`,
      type,
      channel: 'email',
      provider,
      messageId: relayoId ?? webhook.MessageID ?? '',
      recipient,
      timestamp: at ? new Date(at) : new Date(),
      raw: webhook,
    };
    if (webhook.MessageID) event.providerMessageId = webhook.MessageID;
    if (Object.keys(metadata).length) event.metadata = metadata;
    return event;
  };

  switch (webhook.RecordType) {
    case 'Delivery':
      return [make('delivered', webhook.DeliveredAt)];
    case 'Open':
      return [make('opened', webhook.ReceivedAt)];
    case 'Click': {
      const event: ClickEvent = { ...make('clicked', webhook.ReceivedAt), type: 'clicked' };
      if (webhook.OriginalLink) event.url = webhook.OriginalLink;
      return [event];
    }
    case 'SpamComplaint':
      return [make('complained', webhook.BouncedAt)];
    case 'SubscriptionChange':
      // Unsubscribes are recorded as manual suppressions; bounces and complaints have their own webhooks.
      return webhook.SuppressSending && webhook.SuppressionReason === 'ManualSuppression'
        ? [make('unsubscribed', webhook.ChangedAt)]
        : [];
    case 'Bounce':
      return bounceEvents(webhook, make);
    default:
      return [];
  }
}

function bounceEvents(webhook: PostmarkWebhook, make: (type: EventType, at: string | undefined) => RelayoEvent): RelayoEvent[] {
  const type = webhook.Type ?? 'Unknown';
  if (IGNORED_BOUNCE_TYPES.has(type)) return [];
  if (type === 'Transient' || type === 'DnsError') return [make('deferred', webhook.BouncedAt)];
  if (type === 'SpamComplaint') return [make('complained', webhook.BouncedAt)];
  if (type === 'Unsubscribe') return [make('unsubscribed', webhook.BouncedAt)];
  if (type === 'ManuallyDeactivated' || type === 'Unconfirmed') {
    const event: RejectEvent = { ...make('rejected', webhook.BouncedAt), type: 'rejected', reason: 'suppressed' };
    if (webhook.Description) event.diagnostic = webhook.Description;
    return [event];
  }
  if (type === 'SMTPApiError' || type === 'TemplateRenderingFailed') return [make('failed', webhook.BouncedAt)];

  const diagnostic = webhook.Details ? webhook.Details.replace(/^smtp;\s*/i, '') : undefined;
  const smtpCode = Number(SMTP_CODE.exec(diagnostic ?? '')?.[1] ?? 0) || undefined;
  const enhancedCode = STATUS_CODE.exec(diagnostic ?? '')?.[1];
  const fallback = BOUNCE_TYPES[type] ?? BOUNCE_TYPES.Unknown!;

  let { bounceType, reason } = diagnostic
    ? classifyBounce({ diagnostic, ...(smtpCode && { smtpCode }), ...(enhancedCode && { enhancedCode }) })
    : fallback;
  // The details only had a generic code: Postmark's own type says more.
  if (reason === 'unknown' || reason === 'temporary_failure') ({ bounceType, reason } = fallback);
  // Postmark blames the sender (block list, DMARC, spam filter): never invalidate the contact.
  if (fallback.bounceType === 'block' && bounceType !== 'block') ({ bounceType, reason } = fallback);
  // Unknown NDRs: Postmark deactivates the address only when it is sure the address is bad.
  if (type === 'Unknown') bounceType = webhook.Inactive ? 'hard' : 'soft';

  const event: BounceEvent = { ...make('bounced', webhook.BouncedAt), type: 'bounced', bounceType, reason };
  if (smtpCode) event.smtpCode = smtpCode;
  if (enhancedCode) event.enhancedCode = enhancedCode;
  if (diagnostic) event.diagnostic = diagnostic;
  return [event];
}

function readBody(req: WebhookRequest): unknown {
  const source = req.rawBody ?? req.body;
  if (typeof source === 'string') return JSON.parse(source);
  if (source instanceof Uint8Array) return JSON.parse(Buffer.from(source).toString('utf8'));
  return source;
}

function header(req: WebhookRequest, name: string): string | undefined {
  const value = Object.entries(req.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? value[0] : value;
}
