---
"@alimzen/core": patch
"@alimzen/smtp": patch
---

"Try again later" alone no longer means a rate limit: greylisting and busy servers say it too. `classifyBounce` and the SMTP driver now need explicit throttling words (rate, too many, throttling, limit exceeded); `451 4.7.1 Greylisted, please try again later` is a `ProviderUnavailableError`, not a `RateLimitError`.
