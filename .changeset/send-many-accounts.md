---
'@alimzen/relayo': minor
---

`sendMany(messages, { concurrency })`: sends a list a few at a time and reports what happened to each message, without rejecting because one failed. Several sending accounts in one instance (`accounts`, `relayo.account(name)`); webhooks can name their account (`req.account`) and their events carry `event.account`.
