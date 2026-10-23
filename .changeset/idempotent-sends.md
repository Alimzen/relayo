---
'@alimzen/relayo-simulator': minor
---

Sends carry `Idempotency-Key` with Relayo's message id, so a retry after a timeout is not sent twice (Relayo Sim and the Relayo platform answer it with the first response). A 409 (the first try still running) is a retryable `ProviderUnavailableError`.
