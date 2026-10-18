import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { AuthenticationError, ProviderUnavailableError, type RelayoEvent } from '@alimzen/core';
import hoodiecrow from 'hoodiecrow-imap';
import { ImapFlow } from 'imapflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bounceMailbox, type BounceMailboxOptions } from '../src/index.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../../bounces/test/fixtures/${name}`, import.meta.url)).toString('binary');
const ID = '7b1f3c9e-6a4d-4c1e-9d2b-1f0e8a7c6b5d';

const servers: Array<ReturnType<typeof hoodiecrow>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** In-memory IMAP server whose INBOX holds the given raw messages. */
async function startServer(messages: string[]) {
  const server = hoodiecrow({
    plugins: ['UIDPLUS', 'MOVE'],
    storage: { INBOX: { messages: messages.map((raw) => ({ raw })) }, '': { separator: '/' } },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.server.address() as AddressInfo;
  const connection = { host: '127.0.0.1', port, secure: false, auth: { user: 'testuser', pass: 'testpass' } };
  return { connection };
}

/** Lists what is left in a mailbox, with flags, using a separate client. */
async function contents(connection: BounceMailboxOptions['connection'], path = 'INBOX') {
  const client = new ImapFlow({ logger: false, ...connection });
  await client.connect();
  const lock = await client.getMailboxLock(path);
  try {
    const all = await client.fetchAll('1:*', { uid: true, flags: true, envelope: true }).catch(() => []);
    return all.map((m) => ({ subject: m.envelope?.subject, seen: m.flags?.has('\\Seen') ?? false }));
  } finally {
    lock.release();
    await client.logout();
  }
}

describe('bounceMailbox', () => {
  it('turns unseen reports into events and marks them as seen', async () => {
    const { connection } = await startServer([
      fixture('postfix-user-unknown.eml'),
      fixture('arf-abuse.eml'),
      fixture('out-of-office.eml'),
      fixture('regular-reply.eml'),
    ]);
    const events: RelayoEvent[] = [];

    const result = await bounceMailbox({ connection }).poll((e) => {
      events.push(e);
    });

    expect(result).toMatchObject({ messages: 4, events: 2, failed: [] });
    expect(result.kinds).toEqual({ dsn: 1, arf: 1, 'auto-reply': 1, unrecognized: 1 });
    expect(events.map((e) => [e.type, e.messageId])).toEqual([
      ['bounced', ID],
      ['complained', ID],
    ]);
    expect((await contents(connection)).every((m) => m.seen)).toBe(true);
  });

  it('does not read the same message twice', async () => {
    const { connection } = await startServer([fixture('postfix-user-unknown.eml')]);
    const mailbox = bounceMailbox({ connection });
    const onEvent = vi.fn();

    await mailbox.poll(onEvent);
    const second = await mailbox.poll(onEvent);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(second.messages).toBe(0);
  });

  it('leaves a message unseen when its handler fails, so the next poll retries it', async () => {
    const { connection } = await startServer([fixture('postfix-user-unknown.eml'), fixture('arf-abuse.eml')]);
    const mailbox = bounceMailbox({ connection });

    const first = await mailbox.poll((e) => {
      if (e.type === 'complained') throw new Error('database down');
    });
    expect(first.failed).toHaveLength(1);
    expect(await contents(connection)).toEqual([
      expect.objectContaining({ seen: true }),
      expect.objectContaining({ seen: false }),
    ]);

    const retried = vi.fn();
    await mailbox.poll(retried);
    expect(retried).toHaveBeenCalledWith(expect.objectContaining({ type: 'complained' }));
  });

  it('moves processed reports and unrecognized mail to their own folders', async () => {
    const { connection } = await startServer([
      fixture('postfix-user-unknown.eml'),
      fixture('gmail-user-unknown.eml'),
      fixture('regular-reply.eml'),
    ]);

    await bounceMailbox({
      connection,
      processed: { moveTo: 'Processed' },
      unrecognized: { moveTo: 'Review' },
    }).poll(() => {});

    expect(await contents(connection)).toEqual([]);
    expect(await contents(connection, 'Processed')).toHaveLength(2);
    expect(await contents(connection, 'Review')).toEqual([
      { subject: 'Re: Tu factura de octubre', seen: true },
    ]);
  });

  it('can delete processed reports', async () => {
    const { connection } = await startServer([fixture('postfix-user-unknown.eml'), fixture('regular-reply.eml')]);

    await bounceMailbox({ connection, processed: 'delete' }).poll(() => {});

    expect(await contents(connection)).toEqual([{ subject: 'Re: Tu factura de octubre', seen: true }]);
  });

  it('reads at most batchSize messages per poll', async () => {
    const { connection } = await startServer([
      fixture('postfix-user-unknown.eml'),
      fixture('gmail-user-unknown.eml'),
      fixture('exim-plain.eml'),
    ]);
    const mailbox = bounceMailbox({ connection, batchSize: 2 });

    expect((await mailbox.poll(() => {})).messages).toBe(2);
    expect((await mailbox.poll(() => {})).messages).toBe(1);
  });

  it('maps bad credentials and unreachable servers to Relayo errors', async () => {
    const { connection } = await startServer([]);
    await expect(
      bounceMailbox({ connection: { ...connection, auth: { user: 'testuser', pass: 'wrong' } } }).poll(() => {}),
    ).rejects.toBeInstanceOf(AuthenticationError);

    const unreachable = { ...connection, port: 1, connectionTimeout: 2000 };
    await expect(bounceMailbox({ connection: unreachable }).poll(() => {})).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('watches the mailbox until stopped', async () => {
    const { connection } = await startServer([fixture('postfix-user-unknown.eml')]);
    const onEvent = vi.fn();
    const polls: number[] = [];

    const watcher = bounceMailbox({ connection }).watch(onEvent, {
      intervalMs: 20,
      onPoll: (r) => polls.push(r.messages),
    });
    await vi.waitFor(() => expect(polls.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    await watcher.stop();

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(polls.slice(0, 2)).toEqual([1, 0]);
  });
});
