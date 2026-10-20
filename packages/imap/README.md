# @alimzen/relayo-imap

Reads your bounce mailbox over IMAP and turns bounce reports and spam complaints into [Relayo](../core)
events, using [`@alimzen/relayo-bounces`](../bounces). The missing piece when you send through your own mail
server with [`@alimzen/relayo-smtp`](../smtp): bounces arrive as email, and this reads them for you.

```sh
npm install @alimzen/relayo @alimzen/relayo-smtp @alimzen/relayo-imap
```

## Usage

```ts
import { createRelayo } from '@alimzen/relayo';
import { bounceMailbox } from '@alimzen/relayo-imap';
import { smtp } from '@alimzen/relayo-smtp';

const relayo = createRelayo({
  email: smtp(process.env.SMTP_URL!, { bounceAddress: 'bounces@example.com' }),
});
relayo.on('bounced', (e) => markInvalid(e.recipient));

const bounces = bounceMailbox({
  connection: {
    host: 'imap.example.com',
    port: 993,
    secure: true,
    auth: { user: 'bounces@example.com', pass: process.env.IMAP_PASS! },
  },
});

const watcher = bounces.watch((event) => relayo.emit(event), {
  intervalMs: 60_000,
  onError: (error) => logger.warn(error.message),
});
// on shutdown: await watcher.stop();
```

`bounces.poll(onEvent)` does a single pass instead, useful from a cron job or a queue worker. It
returns how many messages were read, how many events came out of them, the kinds of mail found
(`dsn`, `arf`, `non-standard`, `auto-reply`, `unrecognized`) and the messages whose handler failed.

## Options

| Option | |
| --- | --- |
| `connection` | [ImapFlow](https://imapflow.com) options: `host`, `port`, `secure`, `auth` (`{ user, pass }` or `{ user, accessToken }` for OAuth2) |
| `mailbox` | Folder to read (default `"INBOX"`) |
| `processed` | What to do with reports, complaints and auto-replies: `"seen"` (default), `"delete"` or `{ moveTo: 'Processed' }` |
| `unrecognized` | What to do with other mail (replies from people, spam): `"seen"` (default), `"delete"` or `{ moveTo: 'Review' }` |
| `provider` | Provider name put on the events (default `"smtp"`) |
| `batchSize` | Most messages read per poll (default 100) |

Folders used with `moveTo` are created when missing.

## Delivery guarantees

- Only unseen messages are read, and a message is marked, moved or deleted only after your handler has
  processed all of its events. If the handler throws, the message stays unseen and is read again on the
  next poll: delivery is **at least once**.
- Event ids are derived from the report, so a message read twice yields the same ids. Use `event.id` to
  deduplicate.
- Each poll opens its own connection and closes it at the end; polls never overlap.
- Connection problems throw `ProviderUnavailableError`, bad credentials `AuthenticationError`.

Use a mailbox dedicated to bounces: anything else that arrives there is `unrecognized`.
