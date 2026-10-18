# @alimzen/simulator

## 0.1.1

### Patch Changes

- 553eac6: Send attachments (base64) and `replyTo` to Relayo Sim. The driver already declared attachment support but dropped them; the simulator now captures the whole message.

## 0.1.0

### Minor Changes

- a1749dc: New `@alimzen/simulator` driver for Relayo Sim, the delivery simulator: send through its API, verify its signed webhooks, and build scenario addresses with `scenarioAddress()`.
