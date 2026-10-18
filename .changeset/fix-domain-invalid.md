---
"@alimzen/core": patch
---

`classifyBounce`: the Microsoft 365 rule for `X.1.10 RecipientNotFound` no longer turns other domain errors (e.g. `550 5.1.2 Host or domain name not found`) into `user_unknown`; they stay `domain_invalid`. Recognizes more "domain not found" wordings.
