# @alimzen/relayo-postmark

## 0.2.0

### Minor Changes

- a8031b1: Templates and scheduled sends in the core contract, and in the drivers.

  - Messages take `template: { id, variables }` (a template saved with the provider) and `sendAt: Date`. With a
    template, `subject`/`html`/`text` (email) and `body` (SMS) are optional, so their types are now optional too.
  - New optional capability `templates`; `scheduling` now has a field. Validation refuses a template or `sendAt`
    on drivers without them, and `failover()` skips those drivers for such messages.
  - Drivers map them to each provider's own: SendGrid dynamic templates and `send_at` (72 h), Postmark
    `/email/withTemplate`, Mailgun `template` + `t:variables` and `o:deliverytime` (7 days), Resend
    `template` and `scheduled_at` (30 days), SES `Content.Template`, Twilio Content templates and scheduling
    through a Messaging Service (15 min to 35 days). The simulator and cloud drivers send them to
    the Relayo platform.
  - Mailgun and Resend already declared `scheduling` without a way to ask for it; `sendAt` now reaches them.
  - The simulator and cloud drivers send the message's `idempotencyKey` (or Relayo's id) as `Idempotency-Key`.

## 0.1.0

### Minor Changes

- 9c802a9: Finish the email side of the library:

  - `@alimzen/relayo-bounces` (new): `parseBounceEmail()` turns bounce reports (DSN, RFC 3464), spam complaints (ARF, RFC 5965) and common non-standard bounces received by email into Relayo events, and recognizes auto-replies.
  - `@alimzen/relayo-resend`, `@alimzen/relayo-postmark`, `@alimzen/relayo-mailgun` (new): drivers with fetch and no runtime dependencies, errors mapped to Relayo errors, and verified, normalized webhooks. Resend also honors `idempotencyKey`.
  - `@alimzen/relayo-imap` (new): `bounceMailbox()` reads a bounce mailbox over IMAP and emits those events, at least once, marking, moving or deleting each message after its events were handled.
  - `@alimzen/relayo`: optional in-process retries (`retry` in `createRelayo`, off by default) and one-click unsubscribe (`unsubscribe` on email messages, `listUnsubscribeHeaders()`).
  - `@alimzen/relayo-smtp`: `metadata` travels in an `X-Relayo-Metadata` header so it comes back with bounces (`metadataHeader: false` to disable), and `bounceAddress` sets the envelope sender.
