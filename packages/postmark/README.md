# @alimzen/relayo-postmark

[Postmark](https://postmarkapp.com) driver for [Relayo](../core): sends through the Postmark API and turns its
webhooks into Relayo events. No SDK, no runtime dependencies.

```sh
npm install @alimzen/relayo @alimzen/relayo-postmark
```

## Sending

```ts
import { createRelayo } from '@alimzen/relayo';
import { postmark } from '@alimzen/relayo-postmark';

const relayo = createRelayo({
  email: postmark({
    serverToken: process.env.POSTMARK_SERVER_TOKEN!,
    webhook: { basicAuth: { username: 'postmark', password: process.env.POSTMARK_WEBHOOK_PASSWORD! } },
  }),
});
```

| Option | |
| --- | --- |
| `serverToken` | Server API token. Required |
| `messageStream` | Message stream (default `"outbound"`, transactional). Use your broadcast stream for bulk mail |
| `webhook.basicAuth` | Credentials you put in the webhook URL (see below) |
| `webhook.authenticate` | Set to `false` to accept webhooks without credentials |
| `timeoutMs`, `baseUrl`, `fetch`, `name` | Request timeout (default 30 000), endpoint and fetch overrides, provider name (default `"postmark"`) |

- Relayo's `messageId` and your `metadata` travel in Postmark's `Metadata`, which comes back on every webhook.
  Postmark's own limits on metadata apply.
- Postmark accepts **one tag** per message; more than one is refused with a `ValidationError`.
- `providerOptions` are merged into the request body (e.g. `{ TrackOpens: true, TrackLinks: 'HtmlAndText' }`).

| Postmark answer | Relayo error | Retryable |
| --- | --- | --- |
| 401, ErrorCode 10 (bad token); 412, 413 (account not approved); 501 (sender signature not found) | `AuthenticationError` | no |
| ErrorCode 406 (inactive recipient: bounced, complained or unsubscribed before) | `RejectedError` | no |
| 429 | `RateLimitError` | yes |
| 5xx, ErrorCode 100/101, network errors | `ProviderUnavailableError` | yes |
| Other 422 (ErrorCode 300, 403...) | `ValidationError` | no |

## Receiving events

**Postmark does not sign webhooks.** Protect your endpoint with HTTP basic auth: in Postmark, set the
webhook URL as `https://postmark:<password>@api.example.com/webhooks/postmark` and give the same
credentials in `webhook.basicAuth`. Requests without them are refused. Postmark also publishes the IPs it
sends webhooks from, if you want to allowlist them.

| Postmark record | Relayo event |
| --- | --- |
| `Delivery` | `delivered` |
| `Bounce` `HardBounce`, `BadEmailAddress` | `bounced` (`hard`) |
| `Bounce` `SoftBounce` | `bounced` (`soft`) |
| `Bounce` `Blocked`, `DMARCPolicy`, `SpamNotification`, `VirusNotification` | `bounced` (`block`) |
| `Bounce` `Transient`, `DnsError` | `deferred` |
| `Bounce` `ManuallyDeactivated`, `Unconfirmed` | `rejected` (`suppressed`) |
| `Bounce` `SMTPApiError`, `TemplateRenderingFailed` | `failed` |
| `SpamComplaint` | `complained` |
| `SubscriptionChange` (suppressed manually: an unsubscribe) | `unsubscribed` |
| `Open` / `Click` | `opened` / `clicked` (with `url`) |

Auto-responders, address changes, challenge requests and open relay tests are ignored. Bounces are
classified from the SMTP details first, so a `HardBounce` from a blocklist becomes `block`, not `hard`.
