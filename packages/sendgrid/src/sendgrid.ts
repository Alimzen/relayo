import {
  ValidationError,
  type Driver,
  type EmailMessage,
  type Recipient,
  type RelayoEvent,
  type SendContext,
  type SendResult,
  type WebhookRequest,
} from '@alimzen/relayo';
import { errorFromResponse, networkError } from './errors.js';
import { MESSAGE_ID_ARG, METADATA_ARG, parseSendGridEvent, type SendGridEvent } from './events.js';
import { parsePublicKey, verifySignature } from './signature.js';

const BASE_URLS = {
  global: 'https://api.sendgrid.com',
  eu: 'https://api.eu.sendgrid.com',
} as const;

const MAX_CATEGORIES = 10;

export interface SendGridWebhookOptions {
  /** Verification key from Settings → Mail Settings → Signed Event Webhook (base64 or PEM). */
  publicKey?: string;
  /** Set to false to accept unsigned webhooks (e.g. behind your own authentication). Default true. */
  verifySignature?: boolean;
  /** Reject signatures older than this many seconds. Off by default. */
  toleranceSeconds?: number;
}

export interface SendGridDriverOptions {
  apiKey: string;
  /** `"eu"` for accounts with EU data residency. Default `"global"`. */
  region?: keyof typeof BASE_URLS;
  /** Overrides the API base URL (proxies, tests). */
  baseUrl?: string;
  /** Request timeout in milliseconds. Default 30 000. */
  timeoutMs?: number;
  /** Validate messages without delivering them (SendGrid sandbox mode). */
  sandbox?: boolean;
  /** Provider name reported in results, events and errors. Defaults to `"sendgrid"`. */
  name?: string;
  webhook?: SendGridWebhookOptions;
  /** Custom fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * SendGrid (v3 Mail Send API) driver. Point the Event Webhook at your endpoint and pass each request,
 * with its raw body, to `relayo.handleWebhook('email', req)`.
 *
 * Relayo's message id and `metadata` travel as `custom_args`, which SendGrid echoes on every event and
 * does not show to recipients. Message `tags` become SendGrid categories (at most 10).
 * `providerOptions` are merged into the request body (e.g. `{ send_at, asm, ip_pool_name }`).
 */
export function sendgrid(options: SendGridDriverOptions): Driver<EmailMessage> {
  if (!options.apiKey) throw new ValidationError('sendgrid() needs an apiKey');
  const name = options.name ?? 'sendgrid';
  const baseUrl = (options.baseUrl ?? BASE_URLS[options.region ?? 'global']).replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const webhook = options.webhook ?? {};
  const publicKey = webhook.publicKey ? parsePublicKey(webhook.publicKey) : undefined;

  return {
    name,
    channel: 'email',
    capabilities: {
      batch: false,
      attachments: true,
      // send_at, up to 72 hours ahead.
      scheduling: true,
      tracking: true,
      webhooks: true,
      // Dynamic templates (d-…), filled with dynamic_template_data.
      templates: true,
    },

    async send(message, context) {
      const body = toSendGridRequest(message, context, { sandbox: options.sandbox ?? false });
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/v3/mail/send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        });
      } catch (error) {
        throw networkError(error, name);
      }
      if (!response.ok) throw await errorFromResponse(response, name);

      const result: SendResult = { messageId: context.messageId, provider: name, status: 'queued' };
      const providerMessageId = response.headers.get('x-message-id');
      if (providerMessageId) result.providerMessageId = providerMessageId;
      return result;
    },

    verifyWebhook(req) {
      if (webhook.verifySignature === false) return true;
      if (!publicKey) {
        throw new ValidationError(
          `Driver "${name}" has no webhook.publicKey; add the Signed Event Webhook key or set webhook.verifySignature to false`,
          { provider: name },
        );
      }
      return verifySignature(
        req,
        publicKey,
        webhook.toleranceSeconds === undefined ? {} : { toleranceSeconds: webhook.toleranceSeconds },
      );
    },

    parseWebhook(req: WebhookRequest): RelayoEvent[] {
      const body = readBody(req);
      if (!Array.isArray(body)) {
        throw new ValidationError('SendGrid webhooks carry a JSON array of events', { provider: name, raw: body });
      }
      return (body as SendGridEvent[]).flatMap((event) => parseSendGridEvent(event, name) ?? []);
    },
  };
}

function readBody(req: WebhookRequest): unknown {
  const source = req.rawBody ?? req.body;
  if (typeof source === 'string') return JSON.parse(source);
  if (source instanceof Uint8Array) return JSON.parse(Buffer.from(source).toString('utf8'));
  return source;
}

interface SendGridAddress {
  email: string;
  name?: string;
}

export function toSendGridRequest(
  message: EmailMessage,
  context: SendContext,
  options: { sandbox?: boolean } = {},
): Record<string, unknown> {
  const tags = message.tags ?? [];
  if (tags.length > MAX_CATEGORIES) {
    throw new ValidationError(`SendGrid accepts at most ${MAX_CATEGORIES} categories (tags); got ${tags.length}`);
  }

  const customArgs: Record<string, string> = { [MESSAGE_ID_ARG]: context.messageId };
  if (message.metadata) customArgs[METADATA_ARG] = JSON.stringify(message.metadata);

  const to = Array.isArray(message.to) ? message.to : [message.to];
  const personalization: Record<string, unknown> = { to: to.map(toAddress) };
  if (message.cc?.length) personalization.cc = message.cc.map(toAddress);
  if (message.bcc?.length) personalization.bcc = message.bcc.map(toAddress);
  if (message.template?.variables) personalization.dynamic_template_data = message.template.variables;

  // SendGrid requires text/plain before text/html.
  const content: Array<{ type: string; value: string }> = [];
  if (message.text !== undefined) content.push({ type: 'text/plain', value: message.text });
  if (message.html !== undefined) content.push({ type: 'text/html', value: message.html });

  const body: Record<string, unknown> = {
    personalizations: [personalization],
    from: toAddress(message.from),
    // A dynamic template brings its own subject and content.
    ...(message.subject !== undefined && { subject: message.subject }),
    ...(content.length && { content }),
    ...(message.template && { template_id: message.template.id }),
    custom_args: customArgs,
  };
  if (message.sendAt) body.send_at = sendAt(message.sendAt);
  if (message.replyTo) body.reply_to = toAddress(message.replyTo);
  if (message.headers && Object.keys(message.headers).length) body.headers = message.headers;
  if (tags.length) body.categories = tags;
  if (message.attachments?.length) {
    body.attachments = message.attachments.map((a) => ({
      content: Buffer.from(typeof a.content === 'string' ? Buffer.from(a.content, 'utf8') : a.content).toString('base64'),
      filename: a.filename,
      disposition: a.cid ? 'inline' : 'attachment',
      ...(a.contentType && { type: a.contentType }),
      ...(a.cid && { content_id: a.cid }),
    }));
  }
  if (options.sandbox) body.mail_settings = { sandbox_mode: { enable: true } };

  return { ...body, ...message.providerOptions };
}

/** SendGrid takes a unix time in seconds, at most 72 hours ahead. */
function sendAt(date: Date): number {
  if (date.getTime() > Date.now() + MAX_SCHEDULE_MS) {
    throw new ValidationError('SendGrid can schedule a send at most 72 hours ahead');
  }
  return Math.floor(date.getTime() / 1000);
}

const MAX_SCHEDULE_MS = 72 * 3_600_000;

function toAddress(recipient: Recipient): SendGridAddress {
  return recipient.name ? { email: recipient.address, name: recipient.name } : { email: recipient.address };
}
