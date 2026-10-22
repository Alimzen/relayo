import { createHmac, timingSafeEqual } from 'node:crypto';
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

export const SIGNATURE_HEADER = 'x-twilio-signature';
/** Query parameter of the status callback URL that carries Relayo's message id back. */
export const MESSAGE_ID_PARAM = 'relayo_message_id';

export interface TwilioWebhookOptions {
  /** Set to false to accept unsigned callbacks (local development). Default true. */
  verifySignature?: boolean;
}

export interface TwilioDriverOptions {
  accountSid: string;
  authToken: string;
  /** Sender: a Twilio number (E.164) or an alphanumeric sender id. Needed unless `messagingServiceSid` is set. */
  from?: string;
  /** Send through a Messaging Service (`MG...`) instead of a single number. */
  messagingServiceSid?: string;
  /**
   * Public URL of your webhook for this driver, e.g. `https://app.example.com/webhooks/relayo/sms`. Twilio posts
   * each message's status there; Relayo adds the message id to it, so the events map back.
   */
  statusCallback?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Provider name reported in results, events and errors. Defaults to `"twilio"`. */
  name?: string;
  webhook?: TwilioWebhookOptions;
  fetch?: typeof fetch;
}

/** Twilio's carrier error codes, as Relayo bounce types. */
const CARRIER_ERRORS: Record<number, { bounceType: BounceType; reason: BounceReason }> = {
  30003: { bounceType: 'soft', reason: 'temporary_failure' }, // unreachable handset
  30004: { bounceType: 'block', reason: 'policy_block' }, // blocked by the recipient
  30005: { bounceType: 'hard', reason: 'user_unknown' }, // unknown handset
  30006: { bounceType: 'hard', reason: 'unknown' }, // landline or unreachable carrier
  30007: { bounceType: 'block', reason: 'content_rejected' }, // carrier filtering
  30008: { bounceType: 'soft', reason: 'unknown' },
};
/** Errors that mean "not sent at all" rather than a delivery failure. */
const REJECTIONS: Record<number, RejectEvent['reason']> = {
  21610: 'suppressed', // the recipient replied STOP
  21211: 'invalid_recipient',
  21614: 'invalid_recipient',
  21612: 'invalid_recipient',
};

/**
 * Twilio SMS driver. Sends one message per recipient through the Messages API; statuses come back to
 * `statusCallback` (signed with your auth token), and STOP replies to your number's incoming webhook.
 */
export function twilio(options: TwilioDriverOptions): Driver<SmsMessage> {
  if (!options.accountSid || !options.authToken) throw new ValidationError('twilio() needs accountSid and authToken');
  if (!options.from && !options.messagingServiceSid) throw new ValidationError('twilio() needs a from number or a messagingServiceSid');
  const name = options.name ?? 'twilio';
  const baseUrl = (options.baseUrl ?? 'https://api.twilio.com').replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const auth = `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString('base64')}`;

  return {
    name,
    channel: 'sms',
    capabilities: { batch: false, attachments: false, scheduling: false, tracking: false, webhooks: true },

    async send(message, context) {
      const recipients = (Array.isArray(message.to) ? message.to : [message.to]).map((r) => r.address);
      const sids: string[] = [];
      const rejected: string[] = [];
      let lastError: RelayoError | undefined;

      for (const to of recipients) {
        const form = new URLSearchParams({ To: to, Body: message.body });
        if (options.messagingServiceSid) form.set('MessagingServiceSid', options.messagingServiceSid);
        else form.set('From', message.from ?? options.from!);
        if (options.statusCallback) form.set('StatusCallback', withMessageId(options.statusCallback, context.messageId));

        let response: Response;
        try {
          response = await doFetch(`${baseUrl}/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}/Messages.json`, {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form,
            signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
          });
        } catch (error) {
          throw new ProviderUnavailableError(`Twilio request failed: ${(error as Error).message}`, { provider: name, cause: error });
        }
        if (response.ok) {
          sids.push(((await response.json()) as { sid: string }).sid);
          continue;
        }
        const error = await errorFromResponse(response, name);
        // A bad or opted-out number only affects that recipient; anything else stops the send.
        if (!(error instanceof RejectedError) || recipients.length === 1) throw error;
        rejected.push(to);
        lastError = error;
      }

      if (!sids.length && lastError) throw lastError;
      const result: SendResult = { messageId: context.messageId, provider: name, status: 'queued' };
      if (sids[0]) result.providerMessageId = sids[0];
      if (rejected.length) result.rejectedRecipients = rejected;
      return result;
    },

    verifyWebhook(req) {
      if (options.webhook?.verifySignature === false) return true;
      const url = resolveUrl(req.url, options.statusCallback);
      if (!url) {
        throw new ValidationError(`Driver "${name}" needs req.url (and statusCallback for relative URLs) to check Twilio signatures`, { provider: name });
      }
      return verifyTwilioSignature(req, url, options.authToken);
    },

    parseWebhook(req) {
      const params = formParams(req);
      const url = resolveUrl(req.url, options.statusCallback);
      const messageId = url ? (new URL(url).searchParams.get(MESSAGE_ID_PARAM) ?? '') : '';
      return toEvents(params, messageId, name);
    },
  };
}

/** Status callback URL with Relayo's message id, so the status maps back to the message. */
function withMessageId(callback: string, messageId: string): string {
  const url = new URL(callback);
  url.searchParams.set(MESSAGE_ID_PARAM, messageId);
  return url.toString();
}

function resolveUrl(url: string | undefined, base: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, base).toString();
  } catch {
    return undefined;
  }
}

function formParams(req: WebhookRequest): Record<string, string> {
  const source = req.rawBody ?? req.body;
  if (typeof source === 'string' || source instanceof Uint8Array) {
    const text = typeof source === 'string' ? source : Buffer.from(source).toString('utf8');
    return Object.fromEntries(new URLSearchParams(text));
  }
  return Object.fromEntries(Object.entries((source ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}

/** Twilio's signature: base64 HMAC-SHA1 of the URL followed by each POST parameter, sorted, as name+value. */
export function verifyTwilioSignature(req: WebhookRequest, url: string, authToken: string): boolean {
  const header = Object.entries(req.headers).find(([k]) => k.toLowerCase() === SIGNATURE_HEADER)?.[1];
  const given = Array.isArray(header) ? header[0] : header;
  if (!given) return false;
  const params = formParams(req);
  const data = url + Object.keys(params).sort().map((key) => key + params[key]).join('');
  const expected = createHmac('sha1', authToken).update(data).digest();
  const actual = Buffer.from(given, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** One status callback (or a STOP reply) as Relayo events. */
export function toEvents(params: Record<string, string>, messageId: string, provider: string): RelayoEvent[] {
  // An incoming reply that opts out: Twilio flags STOP and its synonyms.
  if (params.OptOutType === 'STOP') {
    return [
      {
        id: `${params.MessageSid ?? params.SmsSid}:stop`,
        type: 'unsubscribed',
        channel: 'sms',
        provider,
        messageId,
        recipient: params.From ?? '',
        timestamp: new Date(),
        raw: params,
      },
    ];
  }

  const sid = params.MessageSid ?? params.SmsSid ?? '';
  const status = params.MessageStatus ?? params.SmsStatus;
  const base = {
    id: `${sid}:${status}`,
    channel: 'sms' as const,
    provider,
    messageId,
    providerMessageId: sid,
    recipient: params.To ?? '',
    timestamp: new Date(),
    raw: params,
  };
  const code = Number(params.ErrorCode);
  const diagnostic = params.ErrorMessage ?? (code ? `Twilio error ${code}` : undefined);

  switch (status) {
    case 'sent':
      return [{ ...base, type: 'accepted' }];
    case 'delivered':
      return [{ ...base, type: 'delivered' }];
    case 'read':
      return [{ ...base, type: 'opened' }];
    case 'undelivered': {
      const known = CARRIER_ERRORS[code] ?? { bounceType: 'soft' as const, reason: 'unknown' as const };
      const event: BounceEvent = { ...base, type: 'bounced', ...known, ...(diagnostic && { diagnostic }) };
      return [event];
    }
    case 'failed': {
      const reason = REJECTIONS[code];
      if (reason) {
        const event: RejectEvent = { ...base, type: 'rejected', reason, ...(diagnostic && { diagnostic }) };
        return [event];
      }
      return [{ ...base, type: 'failed' }];
    }
    default:
      // queued, accepted, sending, scheduled, canceled: nothing to report.
      return [];
  }
}

async function errorFromResponse(response: Response, provider: string): Promise<RelayoError> {
  const body = (await response.json().catch(() => ({}))) as { code?: number; message?: string };
  const message = `Twilio ${response.status}: ${body.message ?? response.statusText}`;
  const options = { provider, raw: { status: response.status, ...body } };
  if (body.code !== undefined && REJECTIONS[body.code]) return new RejectedError(message, options);
  if (response.status === 401 || response.status === 403) return new AuthenticationError(message, options);
  if (response.status === 429) return new RateLimitError(message, options);
  if (response.status >= 500) return new ProviderUnavailableError(message, options);
  return new ValidationError(message, options);
}
