# @alimzen/bounces

Reads the emails that come back to your bounce address and turns them into [Relayo](../core) events:

- **Delivery status notifications** (DSN, RFC 3464) from Postfix, Exim, Gmail, Microsoft 365 and any
  standards-compliant server: failures become `bounced`, delays `deferred`, success reports `delivered`.
- **Spam complaints** from feedback loops (ARF, RFC 5965) become `complained`.
- **Non-standard bounces** that list `X-Failed-Recipients` are understood too.
- **Out-of-office and other auto-replies** are recognized and ignored.

This is what gives you bounce events when you send through your own mail server with
[`@alimzen/smtp`](../smtp): SMTP has no webhooks, so bounces arrive as email. No runtime dependencies.

```sh
npm install @alimzen/core @alimzen/bounces
```

## Usage

```ts
import { parseBounceEmail } from '@alimzen/bounces';

// rawEmail: the full message as received (string or bytes), e.g. from IMAP, an inbound-email
// webhook (SES, Mailgun, Postmark...) or a file.
const { kind, events } = parseBounceEmail(rawEmail);

for (const event of events) await relayo.emit(event); // your relayo.on(...) handlers run as usual
```

`kind` tells you what the email was: `dsn`, `arf`, `non-standard`, `auto-reply` or `unrecognized`. Only the
first three produce events. Leave `unrecognized` mail for a human, or delete it.

Events have the same shape as provider webhooks: `bounced` events carry `bounceType` (`hard`, `soft`,
`block`), `reason`, `smtpCode`, `enhancedCode` and `diagnostic`, classified the same way as every other
driver's. Event ids are derived from the report, so reading the same mailbox twice gives the same ids.

Pass `{ provider: 'mailserver' }` if your SMTP driver uses a name other than `"smtp"`.

## Matching reports to your sends

Most reports quote the original message's headers. `@alimzen/smtp` sends `X-Relayo-Message-ID`,
`X-Relayo-Metadata` and `Message-ID: <relayo-id@your-domain>`, so events come back with your `messageId`
and `metadata`. If a report only quotes the `Message-ID`, the id is recovered from it. Some feedback loops
redact the recipient: those complaints have `recipient: ''`, but still the `messageId`.

## Where bounces go

Receiving servers send reports to the envelope sender (the `Return-Path`), which is your `from` address
unless you change it. To collect them in a dedicated mailbox:

```ts
smtp(transport, { bounceAddress: 'bounces@example.com' });
```
