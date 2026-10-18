import { parseBounceEmail, type BounceEmailKind } from '@alimzen/bounces';
import { AuthenticationError, ProviderUnavailableError, type RelayoError, type RelayoEvent } from '@alimzen/core';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';

/** What to do with a message once it has been handled. */
export type MessageAction = 'seen' | 'delete' | { moveTo: string };

export interface BounceMailboxOptions {
  /** ImapFlow connection options: `host`, `port`, `secure`, `auth` (`{ user, pass }` or `{ user, accessToken }`)... */
  connection: ImapFlowOptions;
  /** Mailbox to read. Default `"INBOX"`. */
  mailbox?: string;
  /** Provider name put on the events (the name of the driver that sent the mail). Default `"smtp"`. */
  provider?: string;
  /** Bounce reports, complaints and auto-replies, once their events were handled. Default `"seen"`. */
  processed?: MessageAction;
  /** Mail that is not a report (a human reply, spam...). Default `"seen"`; `{ moveTo: 'Review' }` keeps it for a person. */
  unrecognized?: MessageAction;
  /** Most messages read per poll. Default 100. */
  batchSize?: number;
}

export interface PollResult {
  /** Messages read in this poll. */
  messages: number;
  events: number;
  kinds: Partial<Record<BounceEmailKind, number>>;
  /** Messages whose handler threw. They stay unseen and are read again on the next poll. */
  failed: Array<{ uid: number; error: unknown }>;
}

export type EventSink = (event: RelayoEvent) => void | Promise<void>;

export interface WatchOptions {
  /** Time between polls. Default 60 000 ms. */
  intervalMs?: number;
  /** Called when a poll fails (connection, credentials...). Polling continues. */
  onError?: (error: RelayoError) => void;
  onPoll?: (result: PollResult) => void;
}

export interface BounceMailbox {
  /** Reads the unseen messages once, passing every event to `onEvent`. */
  poll(onEvent: EventSink): Promise<PollResult>;
  /** Polls until `stop()` is called. Polls never overlap. */
  watch(onEvent: EventSink, options?: WatchOptions): { stop(): Promise<void> };
}

/**
 * Reads a bounce mailbox over IMAP and turns bounce reports and spam complaints into Relayo events.
 *
 * Delivery is at least once: a message is marked (or moved, or deleted) only after `onEvent` has handled
 * all of its events. Event ids are stable, so handlers can deduplicate.
 *
 * @example
 * const bounces = bounceMailbox({ connection: { host: 'imap.example.com', port: 993, secure: true, auth } });
 * bounces.watch((event) => relayo.emit(event));
 */
export function bounceMailbox(options: BounceMailboxOptions): BounceMailbox {
  const mailbox = options.mailbox ?? 'INBOX';
  const processed = options.processed ?? 'seen';
  const unrecognized = options.unrecognized ?? 'seen';
  const batchSize = options.batchSize ?? 100;
  const provider = options.provider ?? 'smtp';

  async function poll(onEvent: EventSink): Promise<PollResult> {
    const result: PollResult = { messages: 0, events: 0, kinds: {}, failed: [] };
    const client = new ImapFlow({ logger: false, ...options.connection });
    try {
      await client.connect();
    } catch (error) {
      throw toRelayoError(error);
    }

    try {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const unseen = (await client.search({ seen: false }, { uid: true })) || [];
        const uids = unseen.slice(0, batchSize);
        if (!uids.length) return result;

        const done = new Map<string, number[]>();
        for (const message of await client.fetchAll(uids, { uid: true, source: true }, { uid: true })) {
          if (!message.source) continue;
          result.messages++;
          const { kind, events } = parseBounceEmail(message.source, { provider });
          result.kinds[kind] = (result.kinds[kind] ?? 0) + 1;
          try {
            for (const event of events) await onEvent(event);
            result.events += events.length;
          } catch (error) {
            result.failed.push({ uid: message.uid, error });
            continue;
          }
          const action = kind === 'unrecognized' ? unrecognized : processed;
          const key = JSON.stringify(action);
          done.set(key, [...(done.get(key) ?? []), message.uid]);
        }

        for (const [key, list] of done) await apply(client, JSON.parse(key) as MessageAction, list);
        return result;
      } finally {
        lock.release();
      }
    } catch (error) {
      throw toRelayoError(error);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  function watch(onEvent: EventSink, watchOptions: WatchOptions = {}) {
    const intervalMs = watchOptions.intervalMs ?? 60_000;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: Promise<void> | undefined;

    const run = () => {
      current = poll(onEvent)
        .then((r) => watchOptions.onPoll?.(r))
        .catch((error: RelayoError) => watchOptions.onError?.(error))
        .finally(() => {
          if (!stopped) timer = setTimeout(run, intervalMs);
        });
    };
    run();

    return {
      async stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        await current;
      },
    };
  }

  return { poll, watch };
}

async function apply(client: ImapFlow, action: MessageAction, uids: number[]): Promise<void> {
  if (action === 'seen') {
    await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
  } else if (action === 'delete') {
    await client.messageDelete(uids, { uid: true });
  } else {
    await client.mailboxCreate(action.moveTo).catch(() => undefined); // already exists
    await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
    const moved = await client.messageMove(uids, action.moveTo, { uid: true });
    if (!moved) throw new Error(`Could not move messages to "${action.moveTo}"`);
  }
}

function toRelayoError(error: unknown): RelayoError {
  if (error instanceof AuthenticationError || error instanceof ProviderUnavailableError) return error;
  const err = error as { authenticationFailed?: boolean; message?: string; responseText?: string };
  const message = `IMAP: ${err.responseText ?? err.message ?? 'request failed'}`;
  if (err.authenticationFailed) return new AuthenticationError(message, { provider: 'imap', cause: error });
  return new ProviderUnavailableError(message, { provider: 'imap', cause: error });
}
