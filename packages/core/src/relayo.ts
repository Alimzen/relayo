import { ValidationError, WebhookVerificationError } from './errors.js';
import type { Driver, SendContext, SendResult, WebhookRequest } from './types/driver.js';
import type { EventOf, EventType, RelayoEvent } from './types/events.js';
import type { BaseMessage, Channel, EmailMessage, SmsMessage } from './types/message.js';
import { validate } from './validate.js';

export interface RelayoConfig {
  email?: Driver<EmailMessage>;
  sms?: Driver<SmsMessage>;
  /** Generates Relayo message ids. Defaults to `crypto.randomUUID()`. */
  generateId?: () => string;
}

export interface ChannelClient<M extends BaseMessage> {
  send(message: M): Promise<SendResult>;
  /**
   * Sends several messages. Uses the driver's native batch when available, otherwise sends them
   * concurrently. All messages are validated before any is sent.
   */
  sendBatch(messages: M[]): Promise<SendResult[]>;
}

export type EventHandler<E extends RelayoEvent = RelayoEvent> = (event: E) => void | Promise<void>;

export interface Relayo {
  readonly email: ChannelClient<EmailMessage>;
  readonly sms: ChannelClient<SmsMessage>;

  /** Subscribes to an event type, or `'*'` for all. Returns an unsubscribe function. */
  on<T extends EventType>(type: T, handler: EventHandler<EventOf<T>>): () => void;
  on(type: '*', handler: EventHandler): () => void;
  off<T extends EventType>(type: T, handler: EventHandler<EventOf<T>>): void;
  off(type: '*', handler: EventHandler): void;

  /** Dispatches an already-normalized event to the registered handlers. */
  emit(event: RelayoEvent): Promise<void>;

  /**
   * Verifies and parses a provider webhook with the channel's driver, then emits every resulting event.
   * Handler errors propagate so the HTTP layer can answer with an error and let the provider retry.
   */
  handleWebhook(channel: Channel, req: WebhookRequest): Promise<RelayoEvent[]>;
}

type AnyHandler = EventHandler<any>;

export function createRelayo(config: RelayoConfig): Relayo {
  const generateId = config.generateId ?? (() => globalThis.crypto.randomUUID());
  const handlers = new Map<EventType | '*', Set<AnyHandler>>();

  for (const channel of ['email', 'sms'] as const) {
    const driver = config[channel];
    if (driver && driver.channel !== channel) {
      throw new ValidationError(
        `Driver "${driver.name}" is a ${driver.channel} driver but was configured for ${channel}`,
        { provider: driver.name },
      );
    }
  }

  function getDriver<M extends BaseMessage>(channel: Channel): Driver<M> {
    const driver = config[channel];
    if (!driver) throw new ValidationError(`No ${channel} driver configured`);
    return driver as unknown as Driver<M>;
  }

  function client<M extends BaseMessage>(channel: Channel): ChannelClient<M> {
    return {
      async send(message) {
        const driver = getDriver<M>(channel);
        validate(message, driver);
        return driver.send(message, { messageId: generateId() });
      },
      async sendBatch(messages) {
        const driver = getDriver<M>(channel);
        messages.forEach((m) => validate(m, driver));
        const contexts: SendContext[] = messages.map(() => ({ messageId: generateId() }));
        if (driver.capabilities.batch && driver.sendBatch) {
          return driver.sendBatch(messages, contexts);
        }
        return Promise.all(messages.map((m, i) => driver.send(m, contexts[i]!)));
      },
    };
  }

  async function emit(event: RelayoEvent): Promise<void> {
    for (const key of [event.type, '*'] as const) {
      for (const handler of handlers.get(key) ?? []) {
        await handler(event);
      }
    }
  }

  return {
    email: client<EmailMessage>('email'),
    sms: client<SmsMessage>('sms'),

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
      const driver = getDriver(channel);
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
      const events = await driver.parseWebhook(req);
      for (const event of events) await emit(event);
      return events;
    },
  };
}
