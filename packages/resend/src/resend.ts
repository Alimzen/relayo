import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  AuthenticationError,
  classifyBounce,
  ProviderUnavailableError,
  RateLimitError,
  ValidationError,
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
} from '@alimzen/core';

export const MESSAGE_ID_TAG = 'relayo_message_id';
export const METADATA_TAG = 'relayo_metadata';
const TAG_VALUE = /^[A-Za-z0-9_-]{1,256}$/;
const SMTP_CODE = /\b([245]\d\d)\b/;
const STATUS_CODE = /\b([245]\.\d{1,3}\.\d{1,3})\b/;

export interface ResendWebhookOptions {
  /** Signing secret of the webhook (`whsec_...`), from the Resend dashboard. */
  secret?: string;
  /** Set to false to accept unsigned webhooks. Default true. */
  verifySignature?: boolean;
  /** Reject signatures older than this many seconds. Default 300; `0` turns the check off. */
  toleranceSeconds?: number;
}

export interface ResendDriverOptions {
  apiKey: string;
  /** Overrides the API base URL (proxies, tests). */
  baseUrl?: string;
  /** Request timeout in milliseconds. Default 30 000. */
  timeoutMs?: number;
  /** Provider name reported in results, events and errors. Defaults to `"resend"`. */
  name?: string;
  webhook?: ResendWebhookOptions;
  fetch?: typeof fetch;
}

/**
 * Resend driver. Relayo's message id and `metadata` travel as Resend tags, which come back on every
 * webhook. `idempotencyKey` is sent as the `Idempotency-Key` header (Resend keeps it for 24 hours).
 * `providerOptions` are merged into the request body (e.g. `{ scheduled_at, topic_id }`).
 */
export function resend(options: ResendDriverOptions): Driver<EmailMessage> {
  if (!options.apiKey) throw new ValidationError('resend() needs an apiKey');
  const name = options.name ?? 'resend';
  const baseUrl = (options.baseUrl ?? 'https://api.resend.com').replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const webhook = options.webhook ?? {};

  return {
    name,
    channel: 'email',
    capabilities: { batch: false, attachments: true, scheduling: true, tracking: true, webhooks: true },

    async send(message, context) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      };
      if (message.idempotencyKey) headers['Idempotency-Key'] = message.idempotencyKey;

      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/emails`, {
          method: 'POST',
          headers,
          body: JSON.stringify(toResendRequest(message, context)),
          signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        });
      } catch (error) {
        throw new ProviderUnavailableError(`Resend request failed: ${(error as Error).message}`, { provider: name, cause: error });
      }
      if (!response.ok) throw await errorFromResponse(response, name);

      const body = (await response.json().catch(() => ({}))) as { id?: string };
      const result: SendResult = { messageId: context.messageId, provider: name, status: 'queued' };
      if (body.id) result.providerMessageId = body.id;
      return result;
    },

    verifyWebhook(req) {
      if (webhook.verifySignature === false) return true;
      if (!webhook.secret) {
        throw new ValidationError(
          `Driver "${name}" has no webhook.secret; add the webhook signing secret or set webhook.verifySignature to false`,
          { provider: name },
        );
      }
      return verifySvixSignature(req, webhook.secret, webhook.toleranceSeconds ?? 300);
    },

    parseWebhook(req) {
      const body = readBody(req) as ResendWebhook;
      if (!body || typeof body.type !== 'string' || typeof body.data !== 'object') {
        throw new ValidationError('Unrecognized Resend webhook payload', { provider: name, raw: body });
      }
      return parseResendEvent(body, name, header(req, 'svix-id'));
    },
  };
}

export function toResendRequest(message: EmailMessage, context: SendContext): Record<string, unknown> {
  const tags = [{ name: MESSAGE_ID_TAG, value: context.messageId }];
  if (message.metadata) {
    const encoded = Buffer.from(JSON.stringify(message.metadata), 'utf8').toString('base64url');
    if (!TAG_VALUE.test(encoded)) {
      throw new ValidationError('metadata is too large for Resend: it travels as a tag of at most 256 characters');
    }
    tags.push({ name: METADATA_TAG, value: encoded });
  }
  for (const tag of message.tags ?? []) tags.push({ name: tag.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256), value: 'true' });

  const to = Array.isArray(message.to) ? message.to : [message.to];
  const body: Record<string, unknown> = {
    from: formatAddress(message.from),
    to: to.map(formatAddress),
    subject: message.subject,
    tags,
  };
  if (message.cc?.length) body.cc = message.cc.map(formatAddress);
  if (message.bcc?.length) body.bcc = message.bcc.map(formatAddress);
  if (message.replyTo) body.reply_to = formatAddress(message.replyTo);
  if (message.html !== undefined) body.html = message.html;
  if (message.text !== undefined) body.text = message.text;
  if (message.headers && Object.keys(message.headers).length) body.headers = message.headers;
  if (message.attachments?.length) {
    body.attachments = message.attachments.map((a) => ({
      filename: a.filename,
      content: Buffer.from(typeof a.content === 'string' ? Buffer.from(a.content, 'utf8') : a.content).toString('base64'),
      ...(a.contentType && { content_type: a.contentType }),
      ...(a.cid && { content_id: a.cid }),
    }));
  }
  return { ...body, ...message.providerOptions };
}

function formatAddress(recipient: Recipient): string {
  return recipient.name ? `${recipient.name.replace(/["<>]/g, '')} <${recipient.address}>` : recipient.address;
}

async function errorFromResponse(response: Response, provider: string): Promise<RelayoError> {
  const text = await response.text().catch(() => '');
  let body: { name?: string; message?: string } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // not JSON
  }
  const status = response.status;
  const code = body.name ?? '';
  const raw = { status, name: code, message: body.message ?? text };
  const message = `Resend ${status}${code ? ` ${code}` : ''}: ${body.message ?? text}`;
  const options = { provider, raw };

  if (status === 429) {
    const retryAfter = retryAfterSeconds(response.headers, code);
    return new RateLimitError(message, retryAfter === undefined ? options : { ...options, retryAfter });
  }
  // Someone else holds this idempotency key or resource right now: worth trying again shortly.
  if (status === 409 && (code === 'concurrent_idempotent_requests' || code === 'resource_locked')) {
    return new ProviderUnavailableError(message, options);
  }
  if (status === 401 || status === 403) return new AuthenticationError(message, options);
  if (status >= 500) return new ProviderUnavailableError(message, options);
  return new ValidationError(message, options);
}

function retryAfterSeconds(headers: Headers, code: string): number | undefined {
  const retryAfter = Number(headers.get('retry-after') ?? headers.get('ratelimit-reset'));
  if (retryAfter > 0) return retryAfter;
  if (code === 'daily_quota_exceeded') {
    // The daily quota resets at midnight UTC.
    const now = new Date();
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return Math.ceil((midnight - now.getTime()) / 1000);
  }
  return undefined;
}

/** Svix signature: HMAC-SHA256 of `id.timestamp.body`, keyed with the base64 part of `whsec_...`. */
export function verifySvixSignature(req: WebhookRequest, secret: string, toleranceSeconds: number): boolean {
  const id = header(req, 'svix-id');
  const timestamp = header(req, 'svix-timestamp');
  const signatures = header(req, 'svix-signature');
  if (!id || !timestamp || !signatures || req.rawBody === undefined) return false;
  if (toleranceSeconds > 0 && Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;

  const body = typeof req.rawBody === 'string' ? req.rawBody : Buffer.from(req.rawBody).toString('utf8');
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();

  return signatures.split(' ').some((entry) => {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

interface ResendWebhook {
  type: string;
  created_at: string;
  data: {
    email_id: string;
    created_at?: string;
    to?: string[];
    tags?: Record<string, string>;
    bounce?: { type?: string; subType?: string; message?: string; diagnosticCode?: string[] };
    click?: { link?: string; timestamp?: string };
    failed?: { reason?: string };
    suppressed?: { type?: string; message?: string };
  };
}

const TYPES: Record<string, EventType> = {
  'email.sent': 'accepted',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'deferred',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.failed': 'failed',
  'email.suppressed': 'rejected',
};

export function parseResendEvent(webhook: ResendWebhook, provider: string, deliveryId?: string): RelayoEvent[] {
  const type = TYPES[webhook.type];
  if (!type) return [];
  const { data } = webhook;
  const tags = data.tags ?? {};
  const metadata = decodeMetadata(tags[METADATA_TAG]);
  const timestamp = new Date(data.click?.timestamp ?? webhook.created_at);
  const recipients = data.to?.length ? data.to : [''];

  return recipients.map((recipient, index) => {
    const base: RelayoEvent = {
      id: deliveryId ? `${deliveryId}:${index}` : `${data.email_id}:${webhook.type}:${recipient}:${webhook.created_at}`,
      type,
      channel: 'email',
      provider,
      messageId: tags[MESSAGE_ID_TAG] ?? data.email_id,
      providerMessageId: data.email_id,
      recipient,
      timestamp,
      raw: webhook,
    };
    if (metadata) base.metadata = metadata;

    if (type === 'bounced') return bounced(base, data.bounce ?? {});
    if (type === 'rejected') {
      const event: RejectEvent = { ...base, type: 'rejected', reason: 'suppressed' };
      if (data.suppressed?.message) event.diagnostic = data.suppressed.message;
      return event;
    }
    if (type === 'clicked') {
      const event: ClickEvent = { ...base, type: 'clicked' };
      if (data.click?.link) event.url = data.click.link;
      return event;
    }
    return base;
  });
}

/** Resend sends through Amazon SES and reports SES's bounce types and subtypes. */
function bounced(base: RelayoEvent, bounce: NonNullable<ResendWebhook['data']['bounce']>): RelayoEvent {
  if (bounce.subType === 'Suppressed' || bounce.subType === 'OnAccountSuppressionList') {
    const event: RejectEvent = { ...base, type: 'rejected', reason: 'suppressed' };
    if (bounce.message) event.diagnostic = bounce.message;
    return event;
  }
  const diagnostic = bounce.diagnosticCode?.[0]?.replace(/^smtp;\s*/i, '') ?? bounce.message;
  const smtpCode = Number(SMTP_CODE.exec(diagnostic ?? '')?.[1] ?? 0) || undefined;
  const enhancedCode = STATUS_CODE.exec(diagnostic ?? '')?.[1];
  let { bounceType, reason } = classifyBounce({
    ...(diagnostic && { diagnostic }),
    ...(smtpCode && { smtpCode }),
    ...(enhancedCode && { enhancedCode }),
  });
  if (reason === 'unknown' || reason === 'temporary_failure') {
    if (bounce.subType === 'NoEmail') [bounceType, reason] = ['hard', 'user_unknown'];
    else if (bounce.subType === 'MailboxFull') [bounceType, reason] = ['soft', 'mailbox_full'];
    else if (bounce.subType === 'MessageTooLarge') [bounceType, reason] = ['block', 'message_too_large'];
    else if (bounce.subType === 'ContentRejected' || bounce.subType === 'AttachmentRejected') {
      [bounceType, reason] = ['block', 'content_rejected'];
    }
  }
  if (bounce.type !== 'Permanent' && bounceType === 'hard') bounceType = 'soft';

  const event: BounceEvent = { ...base, type: 'bounced', bounceType, reason };
  if (smtpCode) event.smtpCode = smtpCode;
  if (enhancedCode) event.enhancedCode = enhancedCode;
  if (diagnostic) event.diagnostic = diagnostic;
  return event;
}

function decodeMetadata(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
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
