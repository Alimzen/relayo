import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  AuthenticationError,
  ProviderUnavailableError,
  RateLimitError,
  RejectedError,
  ValidationError,
  type BounceEvent,
  type BounceReason,
  type BounceType,
  type Driver,
  type RejectEvent,
  type RelayoError,
  type RelayoEvent,
  type SendResult,
  type SmsMessage,
  type WebhookRequest,
} from '@alimzen/relayo';

/** How Vonage signs webhooks, once signing is enabled on the account (by Vonage support). */
export type VonageSignatureMethod = 'md5hash' | 'md5' | 'sha1' | 'sha256' | 'sha512';

export interface VonageWebhookOptions {
  /**
   * The account's signature secret: delivery receipts must then carry a valid `sig`. Without it, receipts are
   * accepted unsigned, so keep the callback URL secret (a token in its path or query).
   */
  signatureSecret?: string;
  /** Default `md5hash`, Vonage's default. */
  signatureMethod?: VonageSignatureMethod;
  /** Seconds a signed receipt stays valid. Default 300; 0 does not check it. */
  toleranceSeconds?: number;
}

export interface VonageDriverOptions {
  apiKey: string;
  apiSecret: string;
  /** Sender: a Vonage number (E.164) or an alphanumeric sender id where the country allows it. */
  from?: string;
  /**
   * Public URL of your webhook for this driver. Vonage posts each message's delivery receipt there; set it
   * here or in the Vonage dashboard. Receipts carry Relayo's message id in `client-ref`.
   */
  callbackUrl?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Provider name reported in results, events and errors. Defaults to `"vonage"`. */
  name?: string;
  webhook?: VonageWebhookOptions;
  fetch?: typeof fetch;
}

interface VonageResponse {
  'message-count'?: string;
  messages?: Array<{ to?: string; 'message-id'?: string; status?: string; 'error-text'?: string }>;
}

/** The SMS API's per-message status codes (the response's `status`), as Relayo errors. */
function sendError(code: number, text: string, provider: string, raw: unknown): RelayoError {
  const message = `Vonage status ${code}: ${text}`;
  const options = { provider, raw };
  switch (code) {
    case 1: // throttled
    case 10: // too many connections
      return new RateLimitError(message, options);
    case 4: // invalid credentials
    case 8: // account suspended
      return new AuthenticationError(message, options);
    case 5: // internal error
    case 9: // no credit: another provider may still send
      return new ProviderUnavailableError(message, options);
    case 6: // unroutable number
    case 7: // number barred
    case 17: // blocked by the provider
    case 33: // number deactivated
      return new RejectedError(message, options);
    default: // missing or invalid parameters, sender id, length, demo mode
      return new ValidationError(message, options);
  }
}

/** The error codes of delivery receipts (`err-code`), as Relayo events. */
const RECEIPT_ERRORS: Record<number, { bounceType: BounceType; reason: BounceReason } | { reject: RejectEvent['reason'] } | 'failed'> = {
  1: { bounceType: 'soft', reason: 'unknown' },
  2: { bounceType: 'soft', reason: 'temporary_failure' }, // absent subscriber, temporary
  3: { bounceType: 'hard', reason: 'user_unknown' }, // absent subscriber, permanent: the number is gone
  4: { bounceType: 'block', reason: 'policy_block' }, // barred by the user
  5: { bounceType: 'soft', reason: 'unknown' }, // portability error
  6: { bounceType: 'block', reason: 'content_rejected' }, // anti-spam
  7: { bounceType: 'soft', reason: 'temporary_failure' }, // handset busy
  8: { bounceType: 'soft', reason: 'temporary_failure' }, // network error
  9: { reject: 'suppressed' }, // the user asked not to get messages from this service
  10: 'failed', // illegal message: our own parameters
  11: 'failed', // unroutable: the provider's routing
  12: { bounceType: 'hard', reason: 'user_unknown' }, // destination unreachable
  13: { bounceType: 'block', reason: 'policy_block' }, // age restriction
  14: { bounceType: 'block', reason: 'policy_block' }, // blocked by the carrier
  15: { bounceType: 'soft', reason: 'temporary_failure' }, // prepaid without funds
  16: { bounceType: 'soft', reason: 'rate_limited' }, // gateway quota
  17: { bounceType: 'block', reason: 'content_rejected' }, // blocked by the provider
  20: { bounceType: 'block', reason: 'policy_block' }, // Fraud Defender rules (20-25)
  22: { bounceType: 'block', reason: 'rate_limited' },
  23: { bounceType: 'block', reason: 'policy_block' },
  24: { bounceType: 'block', reason: 'policy_block' },
  25: { bounceType: 'block', reason: 'policy_block' },
  39: { bounceType: 'block', reason: 'auth_failure' }, // sender not allowed for the US
  41: { bounceType: 'soft', reason: 'rate_limited' }, // daily limit
  50: { bounceType: 'block', reason: 'auth_failure' }, // registration filters (entity, header, content, consent)
  51: { bounceType: 'block', reason: 'auth_failure' },
  52: { bounceType: 'block', reason: 'auth_failure' },
  53: { bounceType: 'block', reason: 'policy_block' },
  54: 'failed',
  99: 'failed',
};

/**
 * Vonage SMS driver (the SMS API, `rest.nexmo.com`). Sends one message per recipient with Relayo's message id
 * as `client-ref`; delivery receipts come back to `callbackUrl` and map to the message through it.
 */
export function vonage(options: VonageDriverOptions): Driver<SmsMessage> {
  if (!options.apiKey || !options.apiSecret) throw new ValidationError('vonage() needs apiKey and apiSecret');
  const name = options.name ?? 'vonage';
  const baseUrl = (options.baseUrl ?? 'https://rest.nexmo.com').replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const auth = `Basic ${Buffer.from(`${options.apiKey}:${options.apiSecret}`).toString('base64')}`;

  return {
    name,
    channel: 'sms',
    capabilities: { batch: false, attachments: false, scheduling: false, tracking: false, webhooks: true, templates: false },

    async send(message, context) {
      const recipients = (Array.isArray(message.to) ? message.to : [message.to]).map((r) => r.address);
      const from = message.from ?? options.from;
      if (!from) throw new ValidationError(`Driver "${name}" has no sender: set from`, { provider: name });
      const body = message.body ?? '';
      const ids: string[] = [];
      const rejected: string[] = [];
      let lastError: RelayoError | undefined;

      for (const to of recipients) {
        const form = new URLSearchParams({
          from: from.replace(/^\+/, ''),
          to: to.replace(/^\+/, ''),
          text: body,
          'client-ref': context.messageId,
          // Unicode keeps accents and emoji; plain text otherwise (more characters per message).
          type: /^[\x20-\x7e\r\n]*$/.test(body) ? 'text' : 'unicode',
        });
        if (options.callbackUrl) form.set('callback', options.callbackUrl);

        let response: Response;
        try {
          response = await doFetch(`${baseUrl}/sms/json`, {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form,
            signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
          });
        } catch (error) {
          throw new ProviderUnavailableError(`Vonage request failed: ${(error as Error).message}`, { provider: name, cause: error });
        }
        if (!response.ok) {
          const raw = await response.text().catch(() => '');
          const text = `Vonage ${response.status}: ${raw.slice(0, 200) || response.statusText}`;
          if (response.status === 401 || response.status === 403) throw new AuthenticationError(text, { provider: name });
          if (response.status === 429) throw new RateLimitError(text, { provider: name });
          throw response.status >= 500 ? new ProviderUnavailableError(text, { provider: name }) : new ValidationError(text, { provider: name });
        }
        // HTTP 200 even on errors: each part of the message has its own status ("0" is success).
        const data = (await response.json()) as VonageResponse;
        const failed = data.messages?.find((m) => m.status !== '0');
        if (!failed && data.messages?.length) {
          ids.push(data.messages[0]!['message-id'] ?? '');
          continue;
        }
        const error = sendError(Number(failed?.status ?? 5), failed?.['error-text'] ?? 'no message accepted', name, data);
        // A bad or barred number only affects that recipient; anything else stops the send.
        if (!(error instanceof RejectedError) || recipients.length === 1) throw error;
        rejected.push(to);
        lastError = error;
      }

      if (!ids.length && lastError) throw lastError;
      const result: SendResult = { messageId: context.messageId, provider: name, status: 'queued' };
      if (ids[0]) result.providerMessageId = ids[0];
      if (rejected.length) result.rejectedRecipients = rejected;
      return result;
    },

    verifyWebhook(req) {
      const secret = options.webhook?.signatureSecret;
      if (!secret) return true;
      return verifyVonageSignature(receiptParams(req), secret, options.webhook?.signatureMethod, options.webhook?.toleranceSeconds);
    },

    parseWebhook(req) {
      return toEvents(receiptParams(req), name);
    },
  };
}

/** A receipt's fields, whether Vonage posted JSON, a form, or sent them in the query (GET). */
export function receiptParams(req: WebhookRequest): Record<string, string> {
  const source = req.rawBody ?? req.body;
  let params: Record<string, unknown> = {};
  if (typeof source === 'string' || source instanceof Uint8Array) {
    const text = (typeof source === 'string' ? source : Buffer.from(source).toString('utf8')).trim();
    params = text.startsWith('{') ? (JSON.parse(text) as Record<string, unknown>) : Object.fromEntries(new URLSearchParams(text));
  } else if (source && typeof source === 'object') {
    params = source as Record<string, unknown>;
  }
  if (!Object.keys(params).length && req.url) {
    params = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
  }
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

/**
 * Vonage's webhook signature: the parameters but `sig`, sorted by name, as `&name=value` with `&` and `=` in
 * values turned into `_`; then MD5 of that plus the secret (`md5hash`) or an HMAC keyed with it.
 */
export function verifyVonageSignature(
  params: Record<string, string>,
  secret: string,
  method: VonageSignatureMethod = 'md5hash',
  toleranceSeconds = 300,
): boolean {
  const given = params.sig;
  if (!given) return false;
  const timestamp = Number(params.timestamp);
  if (toleranceSeconds > 0 && (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds)) return false;
  const base = Object.keys(params)
    .filter((key) => key !== 'sig')
    .sort()
    .map((key) => `&${key}=${params[key]!.replace(/[&=]/g, '_')}`)
    .join('');
  const expected =
    method === 'md5hash' ? createHash('md5').update(base + secret).digest('hex') : createHmac(method, secret).update(base).digest('hex');
  const a = Buffer.from(expected.toLowerCase());
  const b = Buffer.from(given.toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One delivery receipt as Relayo events. */
export function toEvents(params: Record<string, string>, provider: string): RelayoEvent[] {
  const id = params.messageId ?? params['message-id'] ?? '';
  const status = params.status;
  const code = Number(params['err-code'] ?? 0);
  const base = {
    id: `${id}:${status}`,
    channel: 'sms' as const,
    provider,
    messageId: params['client-ref'] ?? '',
    providerMessageId: id,
    recipient: params.msisdn ? `+${params.msisdn.replace(/^\+/, '')}` : '',
    timestamp: receiptTime(params['message-timestamp']),
    raw: params,
  };
  const diagnostic = code ? `Vonage error ${code}` : undefined;

  switch (status) {
    case 'accepted':
      return [{ ...base, type: 'accepted' }];
    case 'buffered':
      return [{ ...base, type: 'deferred', ...(diagnostic && { diagnostic }) }];
    case 'delivered':
      return [{ ...base, type: 'delivered' }];
    case 'expired': {
      const event: BounceEvent = { ...base, type: 'bounced', bounceType: 'soft', reason: 'temporary_failure', diagnostic: diagnostic ?? 'Expired before delivery' };
      return [event];
    }
    case 'failed':
    case 'rejected': {
      const known = RECEIPT_ERRORS[code] ?? { bounceType: status === 'rejected' ? 'block' : 'soft', reason: 'unknown' };
      if (known === 'failed') return [{ ...base, type: 'failed' }];
      if ('reject' in known) {
        const event: RejectEvent = { ...base, type: 'rejected', reason: known.reject, ...(diagnostic && { diagnostic }) };
        return [event];
      }
      const event: BounceEvent = { ...base, type: 'bounced', ...known, ...(diagnostic && { diagnostic }) };
      return [event];
    }
    default:
      // unknown: nothing useful to report.
      return [];
  }
}

/** Receipts say when they were sent as `YYYY-MM-DD HH:MM:SS` (UTC). */
function receiptTime(value: string | undefined): Date {
  const date = value ? new Date(`${value.replace(' ', 'T')}Z`) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}
