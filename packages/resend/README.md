# @alimzen/resend

[Resend](https://resend.com) driver for [Relayo](../core): sends through the Resend API and turns its signed
webhooks into Relayo events. No SDK, no runtime dependencies.

```sh
npm install @alimzen/core @alimzen/resend
```

## Sending

```ts
import { createRelayo } from '@alimzen/core';
import { resend } from '@alimzen/resend';

const relayo = createRelayo({
  email: resend({ apiKey: process.env.RESEND_API_KEY!, webhook: { secret: process.env.RESEND_WEBHOOK_SECRET! } }),
});

await relayo.email.send({ ...message, idempotencyKey: `invoice-${invoice.id}` });
```

| Option | |
| --- | --- |
| `apiKey` | Required |
| `webhook.secret` | Signing secret of the webhook (`whsec_...`) |
| `webhook.toleranceSeconds` | Reject signatures older than this (default 300; `0` turns the check off) |
| `webhook.verifySignature` | Set to `false` to accept unsigned webhooks |
| `timeoutMs`, `baseUrl`, `fetch`, `name` | Request timeout (default 30 000), endpoint and fetch overrides, provider name (default `"resend"`) |

- `idempotencyKey` is sent as `Idempotency-Key`: Resend won't send the same message twice within 24 hours.
- Relayo's `messageId` and your `metadata` travel as Resend tags, which come back on every webhook.
  Tags only allow `A-Z a-z 0-9 _ -` and 256 characters, so `metadata` is encoded (base64url JSON) and must
  stay small; larger metadata is refused with a `ValidationError` before calling Resend.
- Message `tags` become Resend tags (`{ name: tag, value: 'true' }`).
- `providerOptions` are merged into the request body (e.g. `{ scheduled_at: 'in 1 hour', topic_id }`).

| Resend answer | Relayo error | Retryable |
| --- | --- | --- |
| 401, 403 (bad key, unverified domain, testing mode) | `AuthenticationError` | no |
| 429 `rate_limit_exceeded`, `daily_quota_exceeded`, `monthly_quota_exceeded` | `RateLimitError` (`retryAfter` from the headers, or until midnight UTC for the daily quota) | yes |
| 409 `concurrent_idempotent_requests`, `resource_locked`; 5xx; network errors | `ProviderUnavailableError` | yes |
| Other 4xx (400, 409 `invalid_idempotent_request`, 422) | `ValidationError` | no |

## Receiving events

Add a webhook in the Resend dashboard pointing at your endpoint, copy its signing secret into
`webhook.secret`, and pass each request **with its raw body** to `relayo.handleWebhook('email', req)`.
Resend signs with Svix (HMAC-SHA256 of `svix-id.svix-timestamp.body`).

| Resend event | Relayo event |
| --- | --- |
| `email.sent` | `accepted` |
| `email.delivered` | `delivered` |
| `email.delivery_delayed` | `deferred` |
| `email.bounced` | `bounced`; suppression-list bounces become `rejected` (`suppressed`) |
| `email.suppressed` | `rejected` (`suppressed`) |
| `email.complained` | `complained` |
| `email.opened` / `email.clicked` | `opened` / `clicked` (with `url`) |
| `email.failed` | `failed` |

Other events (`email.scheduled`, `domain.*`, `contact.*`...) are ignored. Event ids derive from `svix-id`,
which Resend keeps on retries.
