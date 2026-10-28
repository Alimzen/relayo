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
  type RelayoError,
  type RelayoEvent,
  type SendResult,
  type SmsMessage,
  type WebhookRequest,
} from '@alimzen/relayo';

export const SIGNATURE_HEADER = 'messagebird-signature-jwt';
/** Most recipients one request can carry. */
const MAX_RECIPIENTS = 50;

export interface MessageBirdWebhookOptions {
  /** Set to false to accept unsigned status reports (local development). Default true. */
  verifySignature?: boolean;
  /** Seconds of clock difference accepted on the token's nbf and exp. Default 60. */
  leewaySeconds?: number;
}

export interface MessageBirdDriverOptions {
  accessKey: string;
  /** Sender: a number (E.164) or an alphanumeric sender id (up to 11 characters) where the country allows it. */
  originator?: string;
  /** The dashboard's signing key, to check the status reports' `MessageBird-Signature-JWT`. */
  signingKey?: string;
  /** Your webhook's public URL; without it, status reports go to the URL set in the dashboard. */
  reportUrl?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Provider name reported in results, events and errors. Defaults to `"messagebird"`. */
  name?: string;
  webhook?: MessageBirdWebhookOptions;
  fetch?: typeof fetch;
}

interface MessageBirdMessage {
  id: string;
  recipients?: { items?: Array<{ recipient: number | string; status: string }> };
}

/**
 * MessageBird SMS driver (`rest.messagebird.com/messages`). Sends up to 50 recipients per request with Relayo's
 * message id as `reference`; status reports, which MessageBird only sends for messages with a reference, come
 * back with it.
 */
export function messagebird(options: MessageBirdDriverOptions): Driver<SmsMessage> {
  if (!options.accessKey) throw new ValidationError('messagebird() needs an accessKey');
  const name = options.name ?? 'messagebird';
  const baseUrl = (options.baseUrl ?? 'https://rest.messagebird.com').replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    name,
    channel: 'sms',
    capabilities: { batch: true, attachments: false, scheduling: true, tracking: false, webhooks: true, templates: false },

    async send(message, context) {
      const recipients = (Array.isArray(message.to) ? message.to : [message.to]).map((r) => r.address);
      const originator = message.from ?? options.originator;
      if (!originator) throw new ValidationError(`Driver "${name}" has no sender: set originator`, { provider: name });
      const ids: string[] = [];
      const rejected: string[] = [];

      for (let i = 0; i < recipients.length; i += MAX_RECIPIENTS) {
        const chunk = recipients.slice(i, i + MAX_RECIPIENTS);
        const body = {
          originator,
          recipients: chunk.map((r) => r.replace(/^\+/, '')),
          body: message.body ?? '',
          reference: context.messageId,
          // Accents and emoji in unicode, the rest in plain GSM: MessageBird picks.
          datacoding: 'auto',
          ...(options.reportUrl && { reportUrl: options.reportUrl }),
          ...(message.sendAt && { scheduledDatetime: message.sendAt.toISOString() }),
        };
        let response: Response;
        try {
          response = await doFetch(`${baseUrl}/messages`, {
            method: 'POST',
            headers: { Authorization: `AccessKey ${options.accessKey}`, Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
          });
        } catch (error) {
          throw new ProviderUnavailableError(`MessageBird request failed: ${(error as Error).message}`, { provider: name, cause: error });
        }
        if (!response.ok) throw await errorFromResponse(response, name);
        const data = (await response.json()) as MessageBirdMessage;
        ids.push(data.id);
        for (const item of data.recipients?.items ?? []) {
          if (item.status === 'delivery_failed') rejected.push(`+${String(item.recipient).replace(/^\+/, '')}`);
        }
      }

      const result: SendResult = { messageId: context.messageId, provider: name, status: 'queued' };
      if (ids[0]) result.providerMessageId = ids[0];
      if (rejected.length) result.rejectedRecipients = rejected;
      return result;
    },

    verifyWebhook(req) {
      if (options.webhook?.verifySignature === false) return true;
      if (!options.signingKey) {
        throw new ValidationError(`Driver "${name}" needs signingKey to check status reports (or webhook.verifySignature: false)`, { provider: name });
      }
      if (!req.url) throw new ValidationError(`Driver "${name}" needs req.url to check status reports: the signature covers it`, { provider: name });
      const url = new URL(req.url, options.reportUrl ?? 'http://localhost').toString();
      return verifyMessageBirdSignature(req, url, options.signingKey, options.webhook?.leewaySeconds);
    },

    parseWebhook(req) {
      return toEvents(reportParams(req), name);
    },
  };
}

async function errorFromResponse(response: Response, provider: string): Promise<RelayoError> {
  const body = (await response.json().catch(() => ({}))) as { errors?: Array<{ code?: number; description?: string; parameter?: string }> };
  const first = body.errors?.[0];
  const message = `MessageBird ${response.status}: ${first?.description ?? response.statusText}`;
  const options = { provider, raw: { status: response.status, ...body } };
  if (response.status === 401 || first?.code === 2) return new AuthenticationError(message, options);
  if (response.status === 429) return new RateLimitError(message, options);
  // 9: no (correct) recipients.
  if (first?.code === 9) return new RejectedError(message, options);
  // 25: not enough balance, a provider problem another one may not have.
  if (response.status >= 500 || first?.code === 25) return new ProviderUnavailableError(message, options);
  return new ValidationError(message, options);
}

/** A status report's fields: MessageBird sends them in the query of a GET, or as a form or JSON. */
export function reportParams(req: WebhookRequest): Record<string, string> {
  const source = req.rawBody ?? req.body;
  let params: Record<string, unknown> = {};
  if (typeof source === 'string' || source instanceof Uint8Array) {
    const text = (typeof source === 'string' ? source : Buffer.from(source).toString('utf8')).trim();
    if (text) params = text.startsWith('{') ? (JSON.parse(text) as Record<string, unknown>) : Object.fromEntries(new URLSearchParams(text));
  } else if (source && typeof source === 'object') {
    params = source as Record<string, unknown>;
  }
  if (!Object.keys(params).length && req.url) params = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

const b64url = (value: string) => Buffer.from(value, 'base64url');
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/**
 * MessageBird's request signature: a JWT (HS256, keyed with the signing key) in `MessageBird-Signature-JWT`,
 * issued by MessageBird, valid between nbf and exp, whose `url_hash` is the SHA-256 of the URL called and whose
 * `payload_hash` is the SHA-256 of the body (absent when there is none, as in GET status reports).
 */
export function verifyMessageBirdSignature(req: WebhookRequest, url: string, signingKey: string, leewaySeconds = 60): boolean {
  const header = Object.entries(req.headers).find(([k]) => k.toLowerCase() === SIGNATURE_HEADER)?.[1];
  const token = Array.isArray(header) ? header[0] : header;
  const parts = token?.split('.');
  if (!parts || parts.length !== 3) return false;
  const [head, payload, signature] = parts as [string, string, string];
  let claims: Record<string, unknown>;
  try {
    if ((JSON.parse(b64url(head).toString('utf8')) as { alg?: string }).alg !== 'HS256') return false;
    claims = JSON.parse(b64url(payload).toString('utf8')) as Record<string, unknown>;
  } catch {
    return false;
  }
  const expected = createHmac('sha256', signingKey).update(`${head}.${payload}`).digest();
  const given = b64url(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;

  const now = Date.now() / 1000;
  if (claims.iss !== 'MessageBird') return false;
  if (typeof claims.nbf === 'number' && claims.nbf > now + leewaySeconds) return false;
  if (typeof claims.exp !== 'number' || claims.exp < now - leewaySeconds) return false;
  if (claims.url_hash !== sha256(url)) return false;
  const body = req.rawBody ?? (typeof req.body === 'string' ? req.body : undefined);
  const hasBody = body !== undefined && (typeof body === 'string' ? body.length > 0 : body.length > 0);
  return hasBody ? claims.payload_hash === sha256(body) : claims.payload_hash === undefined;
}

/** Failure reasons of status reports, by their wording, as Relayo bounce types. */
function failureOf(reason: string): { bounceType: BounceType; reason: BounceReason } {
  const text = reason.toLowerCase();
  if (/unknown subscriber|invalid (destination|number)|unallocated/.test(text)) return { bounceType: 'hard', reason: 'user_unknown' };
  if (/barred|blocked|blacklist|spam|filtered|rejected/.test(text)) return { bounceType: 'block', reason: 'policy_block' };
  if (/unavailable|absent|memory|busy|network|timeout|roaming/.test(text)) return { bounceType: 'soft', reason: 'temporary_failure' };
  return { bounceType: 'soft', reason: 'unknown' };
}

/** One status report as Relayo events. */
export function toEvents(params: Record<string, string>, provider: string): RelayoEvent[] {
  const status = params.status;
  const base = {
    id: `${params.id}:${params.recipient}:${status}`,
    channel: 'sms' as const,
    provider,
    messageId: params.reference ?? '',
    providerMessageId: params.id ?? '',
    recipient: params.recipient ? `+${params.recipient.replace(/^\+/, '')}` : '',
    timestamp: params.statusDatetime ? new Date(params.statusDatetime) : new Date(),
    raw: params,
  };
  const diagnostic = [params.statusReason, params.statusErrorCode && `error ${params.statusErrorCode}`].filter(Boolean).join(' · ') || undefined;

  switch (status) {
    case 'sent':
      return [{ ...base, type: 'accepted' }];
    case 'buffered':
      return [{ ...base, type: 'deferred', ...(diagnostic && { diagnostic }) }];
    case 'delivered':
      return [{ ...base, type: 'delivered' }];
    case 'expired': {
      const event: BounceEvent = { ...base, type: 'bounced', bounceType: 'soft', reason: 'temporary_failure', diagnostic: diagnostic ?? 'Expired before delivery' };
      return [event];
    }
    case 'delivery_failed': {
      const event: BounceEvent = { ...base, type: 'bounced', ...failureOf(params.statusReason ?? ''), ...(diagnostic && { diagnostic }) };
      return [event];
    }
    default:
      // scheduled: nothing to report.
      return [];
  }
}
