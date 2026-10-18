import type { RelayoError } from '../errors.js';
import type { Driver, DriverCapabilities, SendContext, SendResult, WebhookRequest } from '../types/driver.js';
import type { EventOf, EventType, RelayoEvent } from '../types/events.js';
import type { BaseMessage, Channel, EmailMessage, SmsMessage } from '../types/message.js';
import { toRecipients } from '../validate.js';

export interface SentMessage<M extends BaseMessage> {
  message: M;
  result: SendResult;
}

export interface MemoryDriverOptions<M extends BaseMessage> {
  name?: string;
  capabilities?: Partial<DriverCapabilities>;
  /** Return an error to make that send fail, e.g. to test retries or failover. */
  fail?: (message: M, context: SendContext) => RelayoError | undefined;
}

export interface MemoryDriver<M extends BaseMessage> extends Driver<M> {
  /** Every message sent successfully, in order. */
  readonly sent: SentMessage<M>[];
  clear(): void;
  /** Builds a normalized event for a sent message, ready for `relayo.emit()` or as a webhook body. */
  createEvent<T extends EventType>(messageId: string, type: T, extra?: Partial<EventOf<T>>): EventOf<T>;
}

/**
 * In-memory driver for tests. Stores what is sent and treats webhook bodies as
 * already-normalized `RelayoEvent`s (or an array of them).
 */
export function memory(
  options?: MemoryDriverOptions<EmailMessage> & { channel?: 'email' },
): MemoryDriver<EmailMessage>;
export function memory(options: MemoryDriverOptions<SmsMessage> & { channel: 'sms' }): MemoryDriver<SmsMessage>;
export function memory(
  // `never` keeps `fail` compatible with both overloads; the channel decides the real message type.
  options: MemoryDriverOptions<never> & { channel?: Channel } = {},
): MemoryDriver<BaseMessage> {
  const channel = options.channel ?? 'email';
  const name = options.name ?? 'memory';
  const sent: SentMessage<BaseMessage>[] = [];
  let counter = 0;

  const driver: MemoryDriver<BaseMessage> = {
    name,
    channel,
    capabilities: {
      batch: true,
      attachments: true,
      scheduling: false,
      tracking: true,
      webhooks: true,
      ...options.capabilities,
    },
    sent,

    async send(message, context) {
      const error = options.fail?.(message as never, context);
      if (error) throw error;
      const result: SendResult = {
        messageId: context.messageId,
        providerMessageId: `${name}_${++counter}`,
        provider: name,
        status: 'sent',
      };
      sent.push({ message, result });
      return result;
    },

    async sendBatch(messages, contexts) {
      return Promise.all(messages.map((m, i) => driver.send(m, contexts[i]!)));
    },

    clear() {
      sent.length = 0;
    },

    createEvent(messageId, type, extra) {
      const entry = sent.find((s) => s.result.messageId === messageId);
      if (!entry) throw new Error(`No message sent with id "${messageId}"`);
      const event: RelayoEvent = {
        id: `evt_${++counter}`,
        type,
        channel,
        provider: name,
        messageId,
        recipient: toRecipients(entry.message.to)[0]!.address,
        timestamp: new Date(),
        raw: null,
      };
      if (entry.result.providerMessageId) event.providerMessageId = entry.result.providerMessageId;
      if (entry.message.metadata) event.metadata = entry.message.metadata;
      return { ...event, ...extra } as EventOf<typeof type>;
    },

    parseWebhook(req: WebhookRequest): RelayoEvent[] {
      const body = parseBody(req);
      const items: unknown[] = Array.isArray(body) ? body : [body];
      return items.map((item) => {
        const event = item as RelayoEvent;
        return { ...event, timestamp: new Date(event.timestamp), raw: item };
      });
    },
  };

  return driver;
}

/** Accepts an already-parsed body or the raw JSON text/bytes, like real provider drivers do. */
function parseBody(req: WebhookRequest): unknown {
  const source = typeof req.body === 'object' && req.body !== null && !(req.body instanceof Uint8Array) ? req.body : (req.rawBody ?? req.body);
  if (typeof source === 'string') return JSON.parse(source);
  if (source instanceof Uint8Array) return JSON.parse(Buffer.from(source).toString('utf8'));
  return source;
}
