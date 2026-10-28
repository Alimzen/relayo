# @alimzen/relayo-twilio

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

- 1ee8f2c: WhatsApp through Twilio: SMS recipients can be written `whatsapp:+34600111222` (the core accepts the prefix) and the Twilio driver sends them from `whatsappFrom`. Approved templates go in `providerOptions.twilio` (`contentSid`, `contentVariables`) for messages outside the 24-hour window. Errors 63016 (outside the window) and 63003/63024 (no WhatsApp account) map to `rejected`.

## 0.1.0

### Minor Changes

- 4af7dca: New `@alimzen/relayo-twilio`: SMS through Twilio, with signed status callbacks and STOP replies as Relayo events. `WebhookRequest.url` carries the URL the provider called (Twilio signs it), and the NestJS webhook controller fills it in.
