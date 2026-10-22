# @alimzen/relayo-twilio

## 0.1.0

### Minor Changes

- 4af7dca: New `@alimzen/relayo-twilio`: SMS through Twilio, with signed status callbacks and STOP replies as Relayo events. `WebhookRequest.url` carries the URL the provider called (Twilio signs it), and the NestJS webhook controller fills it in.
