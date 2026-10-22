# @alimzen/relayo-nestjs

## 0.3.0

### Minor Changes

- 4af7dca: New `@alimzen/relayo-twilio`: SMS through Twilio, with signed status callbacks and STOP replies as Relayo events. `WebhookRequest.url` carries the URL the provider called (Twilio signs it), and the NestJS webhook controller fills it in.

## 0.2.0

### Minor Changes

- 350fcd0: `@OnRelayoEvent()` now works on controllers too (it was silently ignored there), and the module logs every handler it subscribes at startup. `RelayoService.account(name)` and `accounts`, and `?account=<name>` on the webhook routes. Needs `@alimzen/relayo` 0.3.

## 0.1.0

### Minor Changes

- aa0b119: First release: `createRelayo` with message, event and error contracts, `failover()`, `classifyBounce`, an in-memory test driver, an SMTP driver built on Nodemailer, an Amazon SES driver with signed SNS webhooks, a SendGrid driver with the signed Event Webhook, and a NestJS module (`RelayoModule`, `RelayoService`, `@OnRelayoEvent`, webhook controller).
