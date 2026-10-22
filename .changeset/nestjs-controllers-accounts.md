---
'@alimzen/relayo-nestjs': minor
---

`@OnRelayoEvent()` now works on controllers too (it was silently ignored there), and the module logs every handler it subscribes at startup. `RelayoService.account(name)` and `accounts`, and `?account=<name>` on the webhook routes. Needs `@alimzen/relayo` 0.3.
