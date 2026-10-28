# @alimzen/relayo-simulator

## 0.3.0

### Minor Changes

- 340fe4e: Sends carry `Idempotency-Key` with Relayo's message id, so a retry after a timeout is not sent twice (Relayo Sim and the Relayo platform answer it with the first response). A 409 (the first try still running) is a retryable `ProviderUnavailableError`.
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

## 0.2.0

### Minor Changes

- 350fcd0: `simulatorSms()`: send SMS to Relayo Sim and get their events (delivered, bounces, opt-outs...) through the same signed webhook. `scenarioNumber(name)` and `SMS_SCENARIO_NUMBERS` give the scenario numbers.

## 0.1.1

### Patch Changes

- 553eac6: Send attachments (base64) and `replyTo` to Relayo Sim. The driver already declared attachment support but dropped them; the simulator now captures the whole message.

## 0.1.0

### Minor Changes

- a1749dc: New `@alimzen/relayo-simulator` driver for Relayo Sim, the delivery simulator: send through its API, verify its signed webhooks, and build scenario addresses with `scenarioAddress()`.
