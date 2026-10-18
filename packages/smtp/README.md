# @alimzen/smtp

SMTP driver for [Relayo](../core), built on [Nodemailer](https://nodemailer.com). Works with any SMTP
server: your own MTA, a relay, or a provider's SMTP endpoint.

```sh
npm install @alimzen/core @alimzen/smtp
```

## Usage

```ts
import { createRelayo } from '@alimzen/core';
import { smtp } from '@alimzen/smtp';

const relayo = createRelayo({
  email: smtp({ host: 'smtp.example.com', port: 587, auth: { user: 'apikey', pass: process.env.SMTP_PASS! } }),
});
```

The first argument is anything Nodemailer's `createTransport` takes:

```ts
smtp('smtps://user:pass@smtp.example.com');           // connection URL
smtp({ pool: true, host: 'smtp.example.com', maxConnections: 5 }); // pooled connections
smtp(existingNodemailerTransporter);                   // a transporter you already have
smtp(options, { name: 'mailrelay' });                  // provider name in results, events and errors
smtp(options, { bounceAddress: 'bounces@example.com' }); // envelope sender: where bounce reports go
```

The driver adds:

- `driver.verify()`: checks the connection and credentials; throws a `RelayoError` on failure.
- `driver.close()`: closes pooled connections.

`providerOptions` on a message are merged into Nodemailer's mail options (`priority`, `dsn`, `list`, ...).

## What it sends

- `Message-ID: <messageId@your-from-domain>` and an `X-Relayo-Message-ID` header with Relayo's id, so
  bounce reports (DSNs) can be matched to the original send.
- `metadata` in an `X-Relayo-Metadata` header (base64 JSON), so it comes back with bounces. Recipients can
  see headers: pass `{ metadataHeader: false }` if your metadata is sensitive.
- Results have `status: 'sent'` once the server accepts the message. If the server refuses some recipients
  and accepts the rest, the refused ones are in `result.rejectedRecipients`.

## Errors

| Server answer | Relayo error | Retryable |
| --- | --- | --- |
| 5xx (e.g. `550 5.1.1`, `554 5.7.1`) | `RejectedError` | no |
| 4xx with throttling (`450 4.2.1`, `421 … try again later`, `4.7.28`) | `RateLimitError` | yes |
| Other 4xx (e.g. `452 4.2.2` mailbox full) | `ProviderUnavailableError` | yes |
| Bad credentials (`535`, `EAUTH`) | `AuthenticationError` | no |
| Connection refused, timeout, TLS, DNS | `ProviderUnavailableError` | yes |
| Invalid envelope or configuration (no server answer) | `ValidationError` | no |

The SMTP details (`responseCode`, `enhancedCode`, `response`, `rejected`) are in `error.raw`.

## Webhooks

SMTP has none. Problems the server reports during the session surface as errors or `rejectedRecipients`;
bounces that happen later arrive as emails to the envelope sender (`bounceAddress`, or your `from`).
[`@alimzen/bounces`](../bounces) turns them, and spam complaints from feedback loops, into Relayo events.
