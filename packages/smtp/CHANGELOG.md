# @alimzen/smtp

## 0.2.0

### Minor Changes

- 9c802a9: Finish the email side of the library:

  - `@alimzen/bounces` (new): `parseBounceEmail()` turns bounce reports (DSN, RFC 3464), spam complaints (ARF, RFC 5965) and common non-standard bounces received by email into Relayo events, and recognizes auto-replies.
  - `@alimzen/resend`, `@alimzen/postmark`, `@alimzen/mailgun` (new): drivers with fetch and no runtime dependencies, errors mapped to Relayo errors, and verified, normalized webhooks. Resend also honors `idempotencyKey`.
  - `@alimzen/imap` (new): `bounceMailbox()` reads a bounce mailbox over IMAP and emits those events, at least once, marking, moving or deleting each message after its events were handled.
  - `@alimzen/core`: optional in-process retries (`retry` in `createRelayo`, off by default) and one-click unsubscribe (`unsubscribe` on email messages, `listUnsubscribeHeaders()`).
  - `@alimzen/smtp`: `metadata` travels in an `X-Relayo-Metadata` header so it comes back with bounces (`metadataHeader: false` to disable), and `bounceAddress` sets the envelope sender.

## 0.1.0

### Minor Changes

- aa0b119: First release: `createRelayo` with message, event and error contracts, `failover()`, `classifyBounce`, an in-memory test driver, an SMTP driver built on Nodemailer, an Amazon SES driver with signed SNS webhooks, a SendGrid driver with the signed Event Webhook, and a NestJS module (`RelayoModule`, `RelayoService`, `@OnRelayoEvent`, webhook controller).
