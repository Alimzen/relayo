# @alimzen/relayo-mailgun

[Mailgun](https://www.mailgun.com) driver for [Relayo](../core): sends through the Mailgun API and turns its
signed webhooks into Relayo events. No SDK, no runtime dependencies.

```sh
npm install @alimzen/relayo @alimzen/relayo-mailgun
```

## Sending

```ts
import { createRelayo } from '@alimzen/relayo';
import { mailgun } from '@alimzen/relayo-mailgun';

const relayo = createRelayo({
  email: mailgun({
    apiKey: process.env.MAILGUN_API_KEY!,
    domain: 'mg.example.com',
    region: 'eu',
    webhook: { signingKey: process.env.MAILGUN_WEBHOOK_SIGNING_KEY! },
  }),
});
```

| Option | |
| --- | --- |
| `apiKey`, `domain` | API key and sending domain. Required |
| `region` | `"eu"` for domains in Mailgun's EU region (default `"us"`) |
| `webhook.signingKey` | HTTP webhook signing key (Settings → API Security). Not the API key |
| `webhook.toleranceSeconds` | Reject signatures older than this. Off by default: Mailgun deliveries can be late |
| `webhook.verifySignature` | Set to `false` to accept unsigned webhooks |
| `timeoutMs`, `baseUrl`, `fetch`, `name` | Request timeout (default 30 000), endpoint and fetch overrides, provider name (default `"mailgun"`) |

- Relayo's `messageId` and your `metadata` travel as custom variables (`v:relayo_message_id`,
  `v:relayo_metadata`) and come back on every webhook as `user-variables`.
- Mailgun accepts up to **3 tags** per message; more are refused with a `ValidationError`.
- Inline attachments (`cid`) are sent with the cid as their file name, which is how Mailgun names inline parts.
- `providerOptions` become extra form fields (e.g. `{ 'o:tracking': 'yes', 'o:deliverytime': '...' }`).

| Mailgun answer | Relayo error | Retryable |
| --- | --- | --- |
| 401, 403 | `AuthenticationError` | no |
| 429 | `RateLimitError` | yes |
| 5xx, network errors | `ProviderUnavailableError` | yes |
| Other 4xx | `ValidationError` | no |

## Templates and scheduling

`template: { id, variables }` sends a template stored in Mailgun (`template`, with the variables as
`t:variables`). `sendAt` becomes `o:deliverytime`: Mailgun schedules up to 7 days ahead, or 3 on some plans.

## Receiving events

In Mailgun, add webhooks for the events you want pointing at your endpoint, copy the HTTP webhook signing
key into `webhook.signingKey`, and pass each request to `relayo.handleWebhook('email', req)`. The signature
(HMAC-SHA256 of `timestamp + token`) is part of the JSON body.

| Mailgun event | Relayo event |
| --- | --- |
| `accepted` | `accepted` |
| `delivered` | `delivered` |
| `failed`, severity `temporary` | `deferred` (Mailgun retries) |
| `failed`, severity `permanent` | `bounced`; `suppress-*` reasons become `rejected` (`suppressed`) |
| `rejected` | `rejected` |
| `complained` | `complained` |
| `unsubscribed` | `unsubscribed` |
| `opened` / `clicked` | `opened` / `clicked` (with `url`) |

Bounces are classified from `delivery-status` (SMTP code, enhanced code and message). A failure with reason
`old` (gave up after retrying) is never `hard`, and `espblock` is a `block`.
