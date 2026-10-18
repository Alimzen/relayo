---
"@alimzen/core": minor
"@alimzen/smtp": minor
"@alimzen/bounces": minor
"@alimzen/imap": minor
---

Finish the email side of the library:

- `@alimzen/bounces` (new): `parseBounceEmail()` turns bounce reports (DSN, RFC 3464), spam complaints (ARF, RFC 5965) and common non-standard bounces received by email into Relayo events, and recognizes auto-replies.
- `@alimzen/imap` (new): `bounceMailbox()` reads a bounce mailbox over IMAP and emits those events, at least once, marking, moving or deleting each message after its events were handled.
- `@alimzen/core`: optional in-process retries (`retry` in `createRelayo`, off by default) and one-click unsubscribe (`unsubscribe` on email messages, `listUnsubscribeHeaders()`).
- `@alimzen/smtp`: `metadata` travels in an `X-Relayo-Metadata` header so it comes back with bounces (`metadataHeader: false` to disable), and `bounceAddress` sets the envelope sender.
