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

export const MESSAGE_ID_VARIABLE = 'relayo_message_id';
export const METADATA_VARIABLE = 'relayo_metadata';
const MAX_TAGS = 3;

const BASE_URLS = { us: 'https://api.mailgun.net', eu: 'https://api.eu.mailgun.net' } as const;

export interface MailgunWebhookOptions {
  /** HTTP webhook signing key (Settings → API Security). Not your API key or sending key. */
  signingKey?: string;
  /** Set to false to accept unsigned webhooks. Default true. */
  verifySignature?: boolean;
  /** Reject signatures older than this many seconds. Off by default: Mailgun deliveries can be late. */
  toleranceSeconds?: number;
}

export interface MailgunDriverOptions {
  apiKey: string;
  /** Sending domain, e.g. `"mg.example.com"`. */
  domain: string;
  /** `"eu"` for domains in Mailgun's EU region. Default `"us"`. */
  region?: keyof typeof BASE_URLS;
  baseUrl?: string;
  timeoutMs?: number;
  /** Provider name reported in results, events and errors. Defaults to `"mailgun"`. */
  name?: string;
  webhook?: MailgunWebhookOptions;
  fetch?: typeof fetch;
}

/**
 * Mailgun driver. Relayo's message id and `metadata` travel as Mailgun custom variables (`v:`), which come
 * back on every webhook as `user-variables`. Mailgun accepts up to 3 tags per message. `providerOptions` are
 * added as form fields (e.g. `{ 'o:tracking': 'yes', 'o:deliverytime': '...' }`).
 */
export function mailgun(options: MailgunDriverOptions): Driver<EmailMessage> {
  if (!options.apiKey) throw new ValidationError('mailgun() needs an apiKey');
  if (!options.domain) throw new ValidationError('mailgun() needs the sending domain');
  const name = options.name ?? 'mailgun';
  const baseUrl = (options.baseUrl ?? BASE_URLS[options.region ?? 'us']).replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const webhook = options.webhook ?? {};
  const auth = `Basic ${Buffer.from(`api:${options.apiKey}`).toString('base64')}`;

  return {
    name,
    channel: 'email',
    capabilities: { batch: false, attachments: true, scheduling: true, tracking: true, webhooks: true },

    async send(message, context) {
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/v3/${encodeURIComponent(options.domain)}/messages`, {
          method: 'POST',
          headers: { Authorization: auth },
          body: toMailgunForm(message, context),
          signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        });
      } catch (error) {
        throw new ProviderUnavailableError(`Mailgun request failed: ${(error as Error).message}`, { provider: name, cause: error });
      }
      if (!response.ok) throw await errorFromResponse(response, name);

      const body = (await response.json().catch(() => ({}))) as { id?: string };
      const result: SendResult = { messageId: context.messageId, provider: name, status: 'queued' };
      if (body.id) result.providerMessageId = stripBrackets(body.id);
      return result;
    },

    verifyWebhook(req) {
      if (webhook.verifySignature === false) return true;
      if (!webhook.signingKey) {
        throw new ValidationError(
          `Driver "${name}" has no webhook.signingKey; add the HTTP webhook signing key or set webhook.verifySignature to false`,
          { provider: name },
        );
      }
      const body = readBody(req) as MailgunWebhook;
      return verifyMailgunSignature(body?.signature, webhook.signingKey, webhook.toleranceSeconds);
    },

    parseWebhook(req) {
      const body = readBody(req) as MailgunWebhook;
      if (!body || typeof body['event-data'] !== 'object') {
        throw new ValidationError('Unrecognized Mailgun webhook payload', { provider: name, raw: body });
      }
      return parseMailgunEvent(body['event-data'], name);
    },
  };
}

export function toMailgunForm(message: EmailMessage, context: SendContext): FormData {
  if ((message.tags?.length ?? 0) > MAX_TAGS) {
    throw new ValidationError(`Mailgun accepts at most ${MAX_TAGS} tags per message; got ${message.tags!.length}`);
  }
  const form = new FormData();
  const to = Array.isArray(message.to) ? message.to : [message.to];
  form.append('from', formatAddress(message.from));
  for (const r of to) form.append('to', formatAddress(r));
  for (const r of message.cc ?? []) form.append('cc', formatAddress(r));
  for (const r of message.bcc ?? []) form.append('bcc', formatAddress(r));
  form.append('subject', message.subject);
  if (message.text !== undefined) form.append('text', message.text);
  if (message.html !== undefined) form.append('html', message.html);
  if (message.replyTo) form.append('h:Reply-To', formatAddress(message.replyTo));
  for (const [key, value] of Object.entries(message.headers ?? {})) form.append(`h:${key}`, value);
  for (const tag of message.tags ?? []) form.append('o:tag', tag);
  form.append(`v:${MESSAGE_ID_VARIABLE}`, context.messageId);
  if (message.metadata) form.append(`v:${METADATA_VARIABLE}`, JSON.stringify(message.metadata));
  for (const a of message.attachments ?? []) {
    const bytes = typeof a.content === 'string' ? Buffer.from(a.content, 'utf8') : a.content;
    const blob = new Blob([bytes], { type: a.contentType ?? 'application/octet-stream' });
    // Mailgun uses the file name as the Content-ID of inline parts.
    form.append(a.cid ? 'inline' : 'attachment', blob, a.cid ?? a.filename);
  }
  for (const [key, value] of Object.entries(message.providerOptions ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) form.append(key, String(item));
  }
  return form;
}

function formatAddress(recipient: Recipient): string {
  return recipient.name ? `"${recipient.name.replace(/["\\]/g, '\\$&')}" <${recipient.address}>` : recipient.address;
}

async function errorFromResponse(response: Response, provider: string): Promise<RelayoError> {
  const text = await response.text().catch(() => '');
  let detail = text;
  try {
    detail = (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    // plain text
  }
  const status = response.status;
  const message = `Mailgun ${status}: ${detail}`;
  const options = { provider, raw: { status, message: detail } };

  if (status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    return new RateLimitError(message, retryAfter > 0 ? { ...options, retryAfter } : options);
  }
  if (status === 401 || status === 403) return new AuthenticationError(message, options);
  if (status >= 500) return new ProviderUnavailableError(message, options);
  return new ValidationError(message, options);
}

/** Hex HMAC-SHA256 of `timestamp + token`, keyed with the webhook signing key. */
export function verifyMailgunSignature(
  signature: MailgunWebhook['signature'] | undefined,
  signingKey: string,
  toleranceSeconds?: number,
): boolean {
  if (!signature?.timestamp || !signature.token || !signature.signature) return false;
  if (toleranceSeconds !== undefined && Math.abs(Date.now() / 1000 - Number(signature.timestamp)) > toleranceSeconds) {
    return false;
  }
  const expected = createHmac('sha256', signingKey).update(`${signature.timestamp}${signature.token}`).digest();
  const given = Buffer.from(signature.signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

interface MailgunEventData {
  event: string;
  id: string;
  timestamp: number;
  recipient?: string;
  severity?: 'permanent' | 'temporary';
  reason?: string;
  url?: string;
  'user-variables'?: Record<string, string> | unknown[];
  'delivery-status'?: {
    code?: number;
    message?: string;
    description?: string | null;
    'enhanced-code'?: string | null;
    'bounce-type'?: string;
  };
  message?: { headers?: { 'message-id'?: string } };
  reject?: { reason?: string; description?: string };
}

interface MailgunWebhook {
  signature?: { timestamp: string; token: string; signature: string };
  'event-data': MailgunEventData;
}

const TYPES: Record<string, EventType> = {
  accepted: 'accepted',
  delivered: 'delivered',
  failed: 'bounced',
  rejected: 'rejected',
  opened: 'opened',
  clicked: 'clicked',
  unsubscribed: 'unsubscribed',
  complained: 'complained',
};

export function parseMailgunEvent(data: MailgunEventData, provider: string): RelayoEvent[] {
  let type = TYPES[data.event];
  if (!type) return [];
  // Temporary failures are retried by Mailgun.
  if (data.event === 'failed' && data.severity === 'temporary') type = 'deferred';

  const variables = Array.isArray(data['user-variables']) ? {} : (data['user-variables'] ?? {});
  const providerMessageId = data.message?.headers?.['message-id'];
  const base: RelayoEvent = {
    id: `${data.id}:${data.timestamp}`,
    type,
    channel: 'email',
    provider,
    messageId: variables[MESSAGE_ID_VARIABLE] ?? providerMessageId ?? '',
    recipient: data.recipient ?? '',
    timestamp: new Date(data.timestamp * 1000),
    raw: data,
  };
  if (providerMessageId) base.providerMessageId = stripBrackets(providerMessageId);
  const metadata = decodeMetadata(variables[METADATA_VARIABLE]);
  if (metadata) base.metadata = metadata;

  if (type === 'bounced') return [failed(base, data)];
  if (type === 'rejected') {
    const event: RejectEvent = { ...base, type: 'rejected', reason: 'unknown' };
    const diagnostic = data.reject?.description ?? data.reject?.reason;
    if (diagnostic) event.diagnostic = diagnostic;
    return [event];
  }
  if (type === 'clicked') {
    const event: ClickEvent = { ...base, type: 'clicked' };
    if (data.url) event.url = data.url;
    return [event];
  }
  return [base];
}

function failed(base: RelayoEvent, data: MailgunEventData): RelayoEvent {
  const reason = data.reason ?? '';
  // Mailgun did not even try: the address is on one of its suppression lists.
  if (reason.startsWith('suppress-')) {
    const event: RejectEvent = { ...base, type: 'rejected', reason: 'suppressed' };
    event.diagnostic = reason;
    return event;
  }

  const status = data['delivery-status'] ?? {};
  const diagnostic = [status.code, status.message || status.description].filter(Boolean).join(' ') || undefined;
  const enhancedCode = status['enhanced-code'] ?? undefined;
  let classification = classifyBounce({
    ...(status.code && { smtpCode: status.code }),
    ...(enhancedCode && { enhancedCode }),
    ...(diagnostic && { diagnostic }),
  });
  // "old": gave up after retrying temporary failures. "espblock": Mailgun's own policy blocked the send.
  if (reason === 'old' && classification.bounceType === 'hard') classification = { ...classification, bounceType: 'soft' };
  if (reason === 'espblock') classification = { bounceType: 'block', reason: 'policy_block' };

  const event: BounceEvent = { ...base, type: 'bounced', ...classification };
  if (status.code) event.smtpCode = status.code;
  if (enhancedCode) event.enhancedCode = enhancedCode;
  if (diagnostic) event.diagnostic = diagnostic;
  return event;
}

function stripBrackets(id: string): string {
  return id.replace(/^<|>$/g, '');
}

function decodeMetadata(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
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
