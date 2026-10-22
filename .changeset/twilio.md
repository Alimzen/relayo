---
'@alimzen/relayo-twilio': minor
'@alimzen/relayo': minor
'@alimzen/relayo-nestjs': minor
---

New `@alimzen/relayo-twilio`: SMS through Twilio, with signed status callbacks and STOP replies as Relayo events. `WebhookRequest.url` carries the URL the provider called (Twilio signs it), and the NestJS webhook controller fills it in.
