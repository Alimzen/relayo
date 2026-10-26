---
'@alimzen/relayo': minor
'@alimzen/relayo-simulator': minor
'@alimzen/relayo-cloud': minor
'@alimzen/relayo-sendgrid': minor
'@alimzen/relayo-postmark': minor
'@alimzen/relayo-mailgun': minor
'@alimzen/relayo-resend': minor
'@alimzen/relayo-ses': minor
'@alimzen/relayo-smtp': patch
'@alimzen/relayo-twilio': patch
---

Templates and scheduled sends in the core contract, and in the drivers.

- Messages take `template: { id, variables }` (a template saved with the provider) and `sendAt: Date`. With a
  template, `subject`/`html`/`text` (email) and `body` (SMS) are optional, so their types are now optional too.
- New optional capability `templates`; `scheduling` now has a field. Validation refuses a template or `sendAt`
  on drivers without them, and `failover()` skips those drivers for such messages.
- Drivers map them to each provider's own: SendGrid dynamic templates and `send_at` (72 h), Postmark
  `/email/withTemplate`, Mailgun `template` + `t:variables` and `o:deliverytime` (7 days), Resend
  `template` and `scheduled_at` (30 days), SES `Content.Template`. The simulator and cloud drivers send them to
  the Relayo platform.
- Mailgun and Resend already declared `scheduling` without a way to ask for it; `sendAt` now reaches them.
- The simulator and cloud drivers send the message's `idempotencyKey` (or Relayo's id) as `Idempotency-Key`.
