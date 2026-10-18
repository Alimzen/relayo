import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  AuthenticationError,
  ProviderUnavailableError,
  RateLimitError,
  ValidationError,
  type Driver,
  type EmailMessage,
  type RelayoError,
  type RelayoEvent,
  type SendResult,
  type WebhookRequest,
} from '@alimzen/core';

export const SIGNATURE_HEADER = 'relayo-signature';
export const DEFAULT_DOMAIN = 'sim.relayo.dev';

export interface SimulatorWebhookOptions {
  /** The project's webhook secret (`whsec_...`). */
  secret?: string;
  /** Set to false to accept unsigned webhooks. Default true. */
  verifySignature?: boolean;
  /** Reject signatures older than this many seconds. Default 300; `0` turns the check off. */
  toleranceSeconds?: number;
}

export interface SimulatorDriverOptions {
  /** Project API key (`sim_live_...`). */
  apiKey: string;
  /** Base URL of the Relayo Sim API, e.g. `http://localhost:3000`. */
  baseUrl: string;
  timeoutMs?: number;
  /** Provider name reported in results and errors. Defaults to `"simulator"`. */
  name?: string;
  webhook?: SimulatorWebhookOptions;
  fetch?: typeof fetch;
}

/**
 * Relayo Sim driver: a drop-in replacement for your real provider in tests and CI. Send to scenario
 * addresses (see `scenarioAddress`) and the simulator plays the scenario back as Relayo events through
 * your webhook: bounces, deferrals, complaints, opens, clicks...
 */
export function simulator(options: SimulatorDriverOptions): Driver<EmailMessage> {
  if (!options.apiKey) throw new ValidationError('simulator() needs an apiKey');
  if (!options.baseUrl) throw new ValidationError('simulator() needs the baseUrl of your Relayo Sim');
  const name = options.name ?? 'simulator';
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const webhook = options.webhook ?? {};

  return {
    name,
    channel: 'email',
    capabilities: { batch: false, attachments: true, scheduling: false, tracking: true, webhooks: true },

    async send(message, context) {
      const to = Array.isArray(message.to) ? message.to : [message.to];
      const body = {
        from: message.from,
        to,
        ...(message.cc && { cc: message.cc }),
        ...(message.bcc && { bcc: message.bcc }),
        subject: message.subject,
        ...(message.html !== undefined && { html: message.html }),
        ...(message.text !== undefined && { text: message.text }),
        ...(message.headers && { headers: message.headers }),
        ...(message.metadata && { metadata: message.metadata }),
        ...(message.tags && { tags: message.tags }),
        relayoMessageId: context.messageId,
      };

      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        });
      } catch (error) {
        throw new ProviderUnavailableError(`Relayo Sim request failed: ${(error as Error).message}`, { provider: name, cause: error });
      }
      if (!response.ok) throw await errorFromResponse(response, name);

      const { id } = (await response.json()) as { id: string };
      const result: SendResult = { messageId: context.messageId, provider: name, status: 'queued' };
      if (id) result.providerMessageId = id;
      return result;
    },

    verifyWebhook(req) {
      if (webhook.verifySignature === false) return true;
      if (!webhook.secret) {
        throw new ValidationError(
          `Driver "${name}" has no webhook.secret; add the project's webhook secret or set webhook.verifySignature to false`,
          { provider: name },
        );
      }
      return verifySimulatorSignature(req, webhook.secret, webhook.toleranceSeconds ?? 300);
    },

    parseWebhook(req) {
      const event = readBody(req) as RelayoEvent;
      if (!event || typeof event.type !== 'string' || typeof event.id !== 'string') {
        throw new ValidationError('Unrecognized Relayo Sim webhook payload', { provider: name, raw: event });
      }
      // The simulator already sends normalized Relayo events.
      return [{ ...event, timestamp: new Date(event.timestamp) }];
    },
  };
}

/** `scenarioAddress('greylist', 3)` → `greylist+3@sim.relayo.dev`. */
export function scenarioAddress(scenario: string, param?: string | number, domain = DEFAULT_DOMAIN): string {
  return `${scenario}${param !== undefined ? `+${param}` : ''}@${domain}`;
}

/** Checks `Relayo-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`. */
export function verifySimulatorSignature(req: WebhookRequest, secret: string, toleranceSeconds = 300): boolean {
  const header = Object.entries(req.headers).find(([k]) => k.toLowerCase() === SIGNATURE_HEADER)?.[1];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || req.rawBody === undefined) return false;
  const parts = Object.fromEntries(value.split(',').map((p) => p.split('=') as [string, string]));
  const timestamp = Number(parts.t);
  if (!timestamp || !parts.v1) return false;
  if (toleranceSeconds > 0 && Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

  const body = typeof req.rawBody === 'string' ? req.rawBody : Buffer.from(req.rawBody).toString('utf8');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
  const given = Buffer.from(parts.v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function errorFromResponse(response: Response, provider: string): Promise<RelayoError> {
  const body = (await response.json().catch(() => ({}))) as { message?: string | string[] };
  const detail = Array.isArray(body.message) ? body.message.join('; ') : (body.message ?? response.statusText);
  const message = `Relayo Sim ${response.status}: ${detail}`;
  const options = { provider, raw: { status: response.status, message: detail } };
  if (response.status === 401 || response.status === 403) return new AuthenticationError(message, options);
  if (response.status === 429) return new RateLimitError(message, options);
  if (response.status >= 500) return new ProviderUnavailableError(message, options);
  return new ValidationError(message, options);
}

function readBody(req: WebhookRequest): unknown {
  const source = req.rawBody ?? req.body;
  if (typeof source === 'string') return JSON.parse(source);
  if (source instanceof Uint8Array) return JSON.parse(Buffer.from(source).toString('utf8'));
  return source;
}
