# @alimzen/relayo-simulator

## 0.2.0

### Minor Changes

- 350fcd0: `simulatorSms()`: send SMS to Relayo Sim and get their events (delivered, bounces, opt-outs...) through the same signed webhook. `scenarioNumber(name)` and `SMS_SCENARIO_NUMBERS` give the scenario numbers.

## 0.1.1

### Patch Changes

- 553eac6: Send attachments (base64) and `replyTo` to Relayo Sim. The driver already declared attachment support but dropped them; the simulator now captures the whole message.

## 0.1.0

### Minor Changes

- a1749dc: New `@alimzen/relayo-simulator` driver for Relayo Sim, the delivery simulator: send through its API, verify its signed webhooks, and build scenario addresses with `scenarioAddress()`.
