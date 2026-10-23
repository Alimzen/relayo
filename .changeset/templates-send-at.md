---
'@alimzen/relayo': minor
'@alimzen/relayo-simulator': minor
'@alimzen/relayo-cloud': minor
'@alimzen/relayo-smtp': patch
'@alimzen/relayo-ses': patch
'@alimzen/relayo-sendgrid': patch
'@alimzen/relayo-resend': patch
'@alimzen/relayo-postmark': patch
'@alimzen/relayo-mailgun': patch
'@alimzen/relayo-twilio': patch
---

Templates and scheduled sends in the core contract.

- Messages take `template: { id, variables }` (a template saved with the provider) and `sendAt: Date`. With a
  template, `subject`/`html`/`text` (email) and `body` (SMS) are optional, so their types are now optional too:
  drivers read them with a fallback.
- New optional capability `templates`; `scheduling` now has a field. Validation refuses a template or `sendAt`
  on drivers without them, and `failover()` skips those drivers for such messages.
- The simulator and cloud drivers support both (the platform's templates and `sendAt`), and send the message's
  `idempotencyKey` (or Relayo's id) as `Idempotency-Key`.
