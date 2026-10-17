import { isRelayoError, ValidationError, type RelayoError } from './errors.js';
import type { Driver, DriverCapabilities, SendContext, WebhookRequest } from './types/driver.js';
import type { BaseMessage } from './types/message.js';

export interface FailoverAttempt<M extends BaseMessage> {
  /** Driver that failed. */
  from: string;
  /** Driver tried next. */
  to: string;
  error: RelayoError;
  message: M;
  context: SendContext;
}

export interface FailoverOptions<M extends BaseMessage> {
  /** Name reported for the composite driver. Defaults to `failover(a,b,...)`. */
  name?: string;
  /**
   * Whether to try the next driver after an error. Defaults to `error.retryable` for `RelayoError`s.
   * Anything else (a bug in a driver, an unexpected exception) is rethrown: it may have happened after
   * the provider accepted the message, and failing over would send it twice.
   */
  shouldFailover?: (error: unknown, driver: Driver<M>) => boolean;
  /** Called every time a send moves on to the next driver. Useful for logs and metrics. */
  onFailover?: (attempt: FailoverAttempt<M>) => void;
}

export interface FailoverDriver<M extends BaseMessage> extends Driver<M> {
  readonly drivers: readonly Driver<M>[];
}

const CAPABILITIES = ['batch', 'attachments', 'scheduling', 'tracking', 'webhooks'] as const;

function defaultShouldFailover(error: unknown): boolean {
  return isRelayoError(error) && error.retryable;
}

/** Features a message needs from a driver. */
function requirements(message: BaseMessage): Array<keyof DriverCapabilities> {
  const needs: Array<keyof DriverCapabilities> = [];
  if ((message as { attachments?: unknown[] }).attachments?.length) needs.push('attachments');
  return needs;
}

/**
 * Tries drivers in order: when one fails with a retryable error (outage, rate limit) the next one gets
 * the same message and the same Relayo `messageId`. Non-retryable errors (validation, auth, rejection)
 * stop immediately, since another provider would not fix them. Drivers that lack a capability the message
 * needs (e.g. attachments) are skipped.
 *
 * Webhooks are routed to the driver named in `req.provider`; without it, to the first driver whose
 * signature check accepts the request.
 */
export function failover<M extends BaseMessage>(
  drivers: readonly [Driver<M>, ...Driver<M>[]],
  options: FailoverOptions<M> = {},
): FailoverDriver<M> {
  if (drivers.length === 0) throw new ValidationError('failover() needs at least one driver');
  const channel = drivers[0].channel;
  const names = new Set<string>();
  for (const driver of drivers) {
    if (driver.channel !== channel) {
      throw new ValidationError(`failover() mixes ${channel} and ${driver.channel} drivers ("${driver.name}")`);
    }
    if (names.has(driver.name)) {
      throw new ValidationError(`failover() has two drivers named "${driver.name}"; give them distinct names`);
    }
    names.add(driver.name);
  }

  const name = options.name ?? `failover(${drivers.map((d) => d.name).join(',')})`;
  const shouldFailover = options.shouldFailover ?? defaultShouldFailover;
  // Which driver accepted a webhook in verifyWebhook, so parseWebhook doesn't have to guess again.
  const verifiedBy = new WeakMap<WebhookRequest, Driver<M>>();

  // The composite supports a feature if any driver does; each send then skips the drivers that don't.
  const capabilities = Object.fromEntries(
    CAPABILITIES.map((c) => [c, c === 'batch' ? false : drivers.some((d) => d.capabilities[c])]),
  ) as unknown as DriverCapabilities;

  /** Finds the driver a webhook belongs to; `verified` tells whether its signature was already checked. */
  async function resolveWebhookDriver(req: WebhookRequest): Promise<{ driver: Driver<M>; verified: boolean }> {
    const expected = [...names].join(', ');
    if (req.provider !== undefined) {
      const driver = drivers.find((d) => d.name === req.provider);
      if (!driver) throw new ValidationError(`Unknown provider "${req.provider}" in webhook; expected one of: ${expected}`);
      return { driver, verified: false };
    }
    for (const driver of drivers) {
      if (!driver.verifyWebhook || !driver.parseWebhook) continue;
      try {
        if (await driver.verifyWebhook(req)) return { driver, verified: true };
      } catch {
        // A payload from another provider can make a verifier throw; that just means "not mine".
      }
    }
    const parsers = drivers.filter((d) => d.parseWebhook);
    if (parsers.length === 1) return { driver: parsers[0]!, verified: false };
    throw new ValidationError(
      `Could not tell which provider sent this webhook; set "provider" on the request (one of: ${expected})`,
    );
  }

  return {
    name,
    channel,
    capabilities,
    drivers,

    async send(message, context) {
      const needs = requirements(message);
      const eligible = drivers.filter((d) => needs.every((n) => d.capabilities[n]));
      if (eligible.length === 0) {
        throw new ValidationError(`No driver in ${name} supports: ${needs.join(', ')}`);
      }

      for (let i = 0; ; i++) {
        const driver = eligible[i]!;
        try {
          return await driver.send(message, context);
        } catch (error) {
          const next = eligible[i + 1];
          if (!next || !shouldFailover(error, driver)) throw error;
          if (isRelayoError(error)) {
            options.onFailover?.({ from: driver.name, to: next.name, error, message, context });
          }
        }
      }
    },

    async verifyWebhook(req) {
      const { driver, verified } = await resolveWebhookDriver(req);
      if (!verified && driver.verifyWebhook && !(await driver.verifyWebhook(req))) return false;
      verifiedBy.set(req, driver);
      return true;
    },

    async parseWebhook(req) {
      const driver = verifiedBy.get(req) ?? (await resolveWebhookDriver(req)).driver;
      if (!driver.parseWebhook) {
        throw new ValidationError(`Driver "${driver.name}" does not support webhooks`, { provider: driver.name });
      }
      return driver.parseWebhook(req);
    },
  };
}
