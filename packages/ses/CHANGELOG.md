# @alimzen/relayo-ses

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

- aa0b119: First release: `createRelayo` with message, event and error contracts, `failover()`, `classifyBounce`, an in-memory test driver, an SMTP driver built on Nodemailer, an Amazon SES driver with signed SNS webhooks, a SendGrid driver with the signed Event Webhook, and a NestJS module (`RelayoModule`, `RelayoService`, `@OnRelayoEvent`, webhook controller).
