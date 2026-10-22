import { ValidationError, WebhookVerificationError } from './errors.js';
import type { Driver, SendContext, SendResult, WebhookRequest } from './types/driver.js';
import type { EventOf, EventType, RelayoEvent } from './types/events.js';
import type { BaseMessage, Channel, EmailMessage, SmsMessage } from './types/message.js';
import { withRetry, type RetryOptions } from './retry.js';
import { withUnsubscribeHeaders } from './unsubscribe.js';
import { validate } from './validate.js';

/** The drivers of one sending account: one per channel. */
export interface RelayoAccount {
  email?: Driver<EmailMessage>;
  sms?: Driver<SmsMessage>;
}

export interface RelayoConfig extends RelayoAccount {
  /**
   * More sending accounts besides the default one (`email` / `sms` above), by name: another provider, or
   * the same provider with other credentials. Use them with `relayo.account(name)`; their events carry
   * `event.account`.
   *
   * @example
   * accounts: { marketing: { email: smtp('smtps://news@example.com:pass@smtp.example.com') } }
   */
  accounts?: Record<string, RelayoAccount>;
  /** Generates Relayo message ids. Defaults to `crypto.randomUUID()`. */
  generateId?: () => string;
  /**
   * Retry sends that fail with a retryable error, in process. Off by default: if your sends already go
   * through a queue that retries, leave it off to avoid duplicates.
   */
  retry?: RetryOptions;
}

/** What happened to one message of `sendMany`: sent, or the error that stopped it. */
export type SendOutcome =
  | { ok: true; messageId: string; result: SendResult }
  | { ok: false; messageId: string; error: Error };

export interface SendManyOptions {
  /** How many messages are in flight at once. Default 10. */
  concurrency?: number;
}

export interface ChannelClient<M extends BaseMessage> {
  send(message: M): Promise<SendResult>;
  /**
   * Sends several messages, one outcome per message in the same order, never rejecting because one of
   * them failed: a bad address or a provider error affects only that message. Sends `concurrency` at a
   * time (default 10). `retry` applies to each message.
   *
   * @example
   * const outcomes = await relayo.email.sendMany(customers.map((c) => invoiceEmail(c)));
   * const failed = outcomes.filter((o) => !o.ok);
   */
  sendMany(messages: M[], options?: SendManyOptions): Promise<SendOutcome[]>;
  /**
   * Sends several messages. Uses the driver's native batch when available, otherwise sends them
   * concurrently. All messages are validated before any is sent, and it rejects if any send fails
   * (prefer `sendMany` to know which ones went out). `retry` applies to each message when they are sent
   * one by one, never to a native batch (it would resend the messages that went out).
   */
  sendBatch(messages: M[]): Promise<SendResult[]>;
}

export type EventHandler<E extends RelayoEvent = RelayoEvent> = (event: E) => void | Promise<void>;

/** Sending clients of one account. */
export interface RelayoChannels {
  readonly email: ChannelClient<EmailMessage>;
  readonly sms: ChannelClient<SmsMessage>;
}

export interface Relayo extends RelayoChannels {
  /** The clients of a named account from `config.accounts`. Throws a `ValidationError` for unknown names. */
  account(name: string): RelayoChannels;
  /** Names of the configured accounts (besides the default one). */
  readonly accounts: string[];

  /** Subscribes to an event type, or `'*'` for all. Returns an unsubscribe function. */
  on<T extends EventType>(type: T, handler: EventHandler<EventOf<T>>): () => void;
  on(type: '*', handler: EventHandler): () => void;
  off<T extends EventType>(type: T, handler: EventHandler<EventOf<T>>): void;
  off(type: '*', handler: EventHandler): void;

  /** Dispatches an already-normalized event to the registered handlers. */
  emit(event: RelayoEvent): Promise<void>;

  /**
   * Verifies and parses a provider webhook with the channel's driver, then emits every resulting event.
   * Set `req.account` for webhooks of a named account: its driver checks them, and the events carry it.
   * Handler errors propagate so the HTTP layer can answer with an error and let the provider retry.
   */
  handleWebhook(channel: Channel, req: WebhookRequest): Promise<RelayoEvent[]>;
}

type AnyHandler = EventHandler<any>;

const DEFAULT_CONCURRENCY = 10;

export function createRelayo(config: RelayoConfig): Relayo {
  const generateId = config.generateId ?? (() => globalThis.crypto.randomUUID());
  const handlers = new Map<EventType | '*', Set<AnyHandler>>();
  const accounts = config.accounts ?? {};

  checkAccount(config, 'the default account');
  for (const [name, account] of Object.entries(accounts)) {
    if (!name.trim()) throw new ValidationError('Account names cannot be empty');
    checkAccount(account, `account "${name}"`);
  }

  function getDriver<M extends BaseMessage>(account: RelayoAccount, channel: Channel, label: string): Driver<M> {
    const driver = account[channel];
    if (!driver) throw new ValidationError(`No ${channel} driver configured for ${label}`);
    return driver as unknown as Driver<M>;
  }

  function client<M extends BaseMessage>(account: RelayoAccount, channel: Channel, label: string): ChannelClient<M> {
    const sendOne = (driver: Driver<M>, message: M, context: SendContext) =>
      withRetry(() => driver.send(message, context), config.retry, message, context);

    return {
      async send(input) {
        const driver = getDriver<M>(account, channel, label);
        const message = prepare(input, channel);
        validate(message, driver);
        return sendOne(driver, message, { messageId: generateId() });
      },

      async sendMany(inputs, options = {}) {
        const driver = getDriver<M>(account, channel, label);
        const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
        if (!Number.isInteger(concurrency) || concurrency < 1) {
          throw new ValidationError('sendMany: concurrency must be a whole number of at least 1');
        }
        const outcomes: SendOutcome[] = new Array(inputs.length);
        let next = 0;
        const worker = async () => {
          while (next < inputs.length) {
            const index = next++;
            const context: SendContext = { messageId: generateId() };
            try {
              const message = prepare(inputs[index]!, channel);
              validate(message, driver);
              outcomes[index] = { ok: true, messageId: context.messageId, result: await sendOne(driver, message, context) };
            } catch (error) {
              outcomes[index] = { ok: false, messageId: context.messageId, error: error instanceof Error ? error : new Error(String(error)) };
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, worker));
        return outcomes;
      },

      async sendBatch(inputs) {
        const driver = getDriver<M>(account, channel, label);
        const messages = inputs.map((m) => prepare(m, channel));
        messages.forEach((m) => validate(m, driver));
        const contexts: SendContext[] = messages.map(() => ({ messageId: generateId() }));
        if (driver.capabilities.batch && driver.sendBatch) {
          return driver.sendBatch(messages, contexts);
        }
        return Promise.all(messages.map((m, i) => sendOne(driver, m, contexts[i]!)));
      },
    };
  }

  function channels(account: RelayoAccount, label: string): RelayoChannels {
    return { email: client<EmailMessage>(account, 'email', label), sms: client<SmsMessage>(account, 'sms', label) };
  }

  const named = new Map(Object.entries(accounts).map(([name, account]) => [name, channels(account, `account "${name}"`)]));

  function accountConfig(name: string | undefined): RelayoAccount {
    if (name === undefined) return config;
    const account = accounts[name];
    if (!account) throw new ValidationError(`Unknown account "${name}"`);
    return account;
  }

  function prepare<M extends BaseMessage>(message: M, channel: Channel): M {
    return channel === 'email' ? (withUnsubscribeHeaders(message as unknown as EmailMessage) as unknown as M) : message;
  }

  async function emit(event: RelayoEvent): Promise<void> {
    for (const key of [event.type, '*'] as const) {
      for (const handler of handlers.get(key) ?? []) {
        await handler(event);
      }
    }
  }

  return {
    ...channels(config, 'the default account'),

    account(name) {
      const found = named.get(name);
      if (!found) throw new ValidationError(`Unknown account "${name}"`);
      return found;
    },

    get accounts() {
      return [...named.keys()];
    },

    on(type: EventType | '*', handler: AnyHandler) {
      let set = handlers.get(type);
      if (!set) handlers.set(type, (set = new Set()));
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },

    off(type: EventType | '*', handler: AnyHandler) {
      handlers.get(type)?.delete(handler);
    },

    emit,

    async handleWebhook(channel, req) {
      const label = req.account === undefined ? 'the default account' : `account "${req.account}"`;
      const driver = getDriver(accountConfig(req.account), channel, label);
      if (!driver.parseWebhook) {
        throw new ValidationError(`Driver "${driver.name}" does not support webhooks`, {
          provider: driver.name,
        });
      }
      if (driver.verifyWebhook && !(await driver.verifyWebhook(req))) {
        throw new WebhookVerificationError(`Invalid webhook signature for "${driver.name}"`, {
          provider: driver.name,
        });
      }
      const parsed = await driver.parseWebhook(req);
      const events = req.account === undefined ? parsed : parsed.map((event) => ({ ...event, account: req.account! }));
      for (const event of events) await emit(event);
      return events;
    },
  };
}

function checkAccount(account: RelayoAccount, label: string): void {
  for (const channel of ['email', 'sms'] as const) {
    const driver = account[channel];
    if (driver && driver.channel !== channel) {
      throw new ValidationError(
        `Driver "${driver.name}" is a ${driver.channel} driver but was configured for ${channel} in ${label}`,
        { provider: driver.name },
      );
    }
  }
}
