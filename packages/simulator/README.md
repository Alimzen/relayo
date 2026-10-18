# @alimzen/simulator

Driver for **Relayo Sim**, the delivery simulator. Swap it in for your real provider in tests and CI, send
to scenario addresses, and the simulator answers like the real world: hard bounces, greylisting, blocklists,
full mailboxes, complaints, delays... delivered to your webhook as ordinary Relayo events. Your
`relayo.on(...)` handlers run exactly as they would in production.

```sh
npm install -D @alimzen/core @alimzen/simulator
```

## Usage

```ts
import { createRelayo } from '@alimzen/core';
import { scenarioAddress, simulator } from '@alimzen/simulator';

const relayo = createRelayo({
  email: process.env.CI
    ? simulator({
        apiKey: process.env.RELAYO_SIM_API_KEY!,
        baseUrl: process.env.RELAYO_SIM_URL!,
        webhook: { secret: process.env.RELAYO_SIM_WEBHOOK_SECRET! },
      })
    : ses({ region: 'eu-west-1' }),
});

await relayo.email.send({ ...invoiceEmail, to: { address: scenarioAddress('hard-bounce') } });
// → your relayo.on('bounced') handler gets { bounceType: 'hard', reason: 'user_unknown', ... }
```

Webhooks from the simulator go through `relayo.handleWebhook('email', req)` like any provider's (they are
signed: `Relayo-Signature: t=...,v1=<HMAC-SHA256>`).

## Scenarios

Pick one with the recipient address (`name[+param]@sim.relayo.dev`, or `scenarioAddress(name, param)`) or
with an `X-Sim-Scenario` header that applies to every recipient. Any other address is delivered normally.

| Scenario | What happens |
| --- | --- |
| `hard-bounce` | 550 5.1.1: the mailbox does not exist → `bounced` hard / `user_unknown` |
| `no-mx` | 550 5.1.2: the domain cannot receive mail → `bounced` hard / `domain_invalid` |
| `mailbox-full` | 452 4.2.2: deferred twice, then `bounced` soft / `mailbox_full` |
| `greylist+N` | 451 4.7.1 until attempt N (default 2), then delivered |
| `blocked` | 550 5.7.1 policy → `bounced` block / `policy_block` |
| `blocklisted` | 554 5.7.1 Spamhaus → `bounced` block / `reputation_block` |
| `dmarc` | 550 5.7.26 → `bounced` block / `auth_failure` |
| `too-large` | 552 5.3.4 → `bounced` block / `message_too_large` |
| `rate-limit` | 421 4.7.28: deferred, then delivered |
| `timeout` | No answer (SMTP); deferred and soft-bounced (API) |
| `delay+30m` | Delivered after the given time (s, m or h) |
| `complaint` | Delivered, then marked as spam |
| `unsubscribe` | Delivered, then unsubscribed |
| `engaged` | Delivered, opened, clicked |
| `suppressed` | `rejected` / `suppressed`, never attempted |

The simulator also has an SMTP endpoint (password: your API key), so apps sending through
`@alimzen/smtp`, or any other language, get the same scenarios as live SMTP answers.

Over SMTP, refusing scenarios answer during the session. Add `+async` (`hard-bounce+async@`) to have the
simulator accept the message and bounce it later, mailing a DSN to the envelope sender, as a relay would: that
is how you test reading your bounce mailbox with [`@alimzen/imap`](../imap). Complaints come back as ARF reports.

`baseUrl` is required: the driver never sends your API key to a default host.
