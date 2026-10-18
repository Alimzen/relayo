# Relayo

**Provider-agnostic email and SMS for Node.js, with one normalized event model for everything that comes back.**

Sending an email is easy with any provider. The hard part is what comes back: bounces, complaints,
deferrals, drops and unsubscribes arrive in a different shape from every provider, and getting them wrong
has real costs, like marking good contacts invalid because your own IP got blocklisted.

Relayo gives you one API to send, and one set of events to react to, whatever provider is underneath.

```ts
import { createRelayo, failover } from '@alimzen/core';
import { ses } from '@alimzen/ses';
import { sendgrid } from '@alimzen/sendgrid';

const relayo = createRelayo({
  email: failover([ses({ region: 'us-east-1' }), sendgrid({ apiKey: process.env.SENDGRID_API_KEY! })]),
});

await relayo.email.send({
  from: { address: 'billing@example.com' },
  to: { address: 'customer@example.com' },
  subject: 'Your October invoice',
  html: '<p>...</p>',
  metadata: { invoiceId: '123' },
});

relayo.on('bounced', (event) => {
  if (event.bounceType === 'hard') markInvalid(event.recipient); // user_unknown, domain_invalid...
  if (event.bounceType === 'block') alertDeliverabilityTeam(event.reason); // your setup, not the contact
  // event.metadata.invoiceId tells you which record this was about
});
```

> **Status:** pre-release (0.x). APIs may still change.

## Packages

| Package | What it does |
| --- | --- |
| [`@alimzen/core`](packages/core) | `createRelayo`, message/event/error contracts, `failover()`, `classifyBounce`, in-memory test driver |
| [`@alimzen/smtp`](packages/smtp) | Any SMTP server, built on Nodemailer |
| [`@alimzen/ses`](packages/ses) | Amazon SES (v2 API), events through SNS with signature verification |
| [`@alimzen/sendgrid`](packages/sendgrid) | SendGrid v3 API, signed Event Webhook |
| [`@alimzen/nestjs`](packages/nestjs) | `RelayoModule`, injectable `RelayoService`, `@OnRelayoEvent()`, webhook controller |

SMS (Twilio) and more email providers (Mailgun, Postmark, Resend) are on the roadmap.

## Ideas worth knowing

- **One event model.** `accepted`, `delivered`, `deferred`, `bounced`, `complained`, `rejected`, `opened`,
  `clicked`, `unsubscribed`, `failed`. Every event keeps the provider's original payload in `raw`.
- **Bounces you can act on.** `bounceType` is `hard` (the address is bad), `soft` (temporary, retries
  exhausted) or `block` (policy, reputation, authentication: fix your own setup, keep the contact).
  `reason` narrows it down: `user_unknown`, `mailbox_full`, `reputation_block`, `auth_failure`...
- **Your ids travel with the message.** Relayo generates a `messageId` for every send and carries it, along
  with your `metadata`, to every event, so you always know which record an event belongs to.
- **Errors say whether to retry.** Every error is a `RelayoError` with a `code` and a `retryable` flag.
  `failover()` uses it to switch providers on outages and rate limits, and stops on errors another
  provider wouldn't fix.
- **No hidden retries.** The core doesn't retry on its own: in production retries usually live in a queue
  (e.g. BullMQ), and two layers of retries mean duplicate emails.

## Development

```sh
pnpm install
pnpm test        # all packages
pnpm typecheck
pnpm build       # dual ESM/CJS with tsup
pnpm changeset   # describe a change for the next release
```

Requires Node.js 20+ and pnpm 8+. Design notes, roadmap and architecture decisions (in Spanish) live in
[docs/contexto.md](docs/contexto.md).
