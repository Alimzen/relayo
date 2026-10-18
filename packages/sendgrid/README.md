# @alimzen/sendgrid

SendGrid driver for [Relayo](../core): sends through the v3 Mail Send API and turns the signed Event
Webhook into Relayo events. No SDK, no runtime dependencies: it uses Node's `fetch`.

```sh
npm install @alimzen/core @alimzen/sendgrid
```

## Sending

```ts
import { createRelayo } from '@alimzen/core';
import { sendgrid } from '@alimzen/sendgrid';

const relayo = createRelayo({
  email: sendgrid({
    apiKey: process.env.SENDGRID_API_KEY!,
    webhook: { publicKey: process.env.SENDGRID_WEBHOOK_KEY! },
  }),
});
```

| Option | |
| --- | --- |
| `apiKey` | Required |
| `region` | `"eu"` for accounts with EU data residency (default `"global"`) |
| `sandbox` | Validate messages without delivering them |
| `timeoutMs` | Request timeout (default 30 000) |
| `baseUrl`, `fetch` | Override the endpoint or the fetch implementation (proxies, tests) |
| `name` | Provider name in results, events and errors (default `"sendgrid"`) |
| `webhook.publicKey` | Verification key of the Signed Event Webhook (base64, as shown by SendGrid, or PEM) |
| `webhook.toleranceSeconds` | Reject signatures older than this (replay protection). Off by default |
| `webhook.verifySignature` | Set to `false` to accept unsigned webhooks |

Results have `status: 'queued'` and the `X-Message-Id` as `providerMessageId`. Relayo's `messageId` and your
`metadata` travel as `custom_args`, which SendGrid repeats on every event and recipients don't see. Message
`tags` become categories (at most 10). `providerOptions` are merged into the request body (e.g.
`{ send_at, asm, ip_pool_name }`).

| SendGrid answer | Relayo error | Retryable |
| --- | --- | --- |
| 401, 403 (including an unverified sender) | `AuthenticationError` | no |
| 429 | `RateLimitError` with `retryAfter` | yes |
| 5xx, network errors, timeouts | `ProviderUnavailableError` | yes |
| Other 4xx (400, 413...) | `ValidationError` | no |

SendGrid's error list is in `error.raw.errors`.

## Receiving events

1. In SendGrid, go to **Settings → Mail Settings → Event Webhook**, set your endpoint URL and choose the
   events.
2. Enable **Signed Event Webhook** and copy the verification key into `webhook.publicKey`.
3. Pass each request to Relayo **with the raw body**: the signature covers the exact bytes, so a body that
   was parsed and re-serialized won't verify.

```ts
app.post('/webhooks/sendgrid', express.text({ type: '*/*' }), async (req, res) => {
  const events = await relayo.handleWebhook('email', { headers: req.headers, body: req.body, rawBody: req.body });
  res.json({ received: events.length });
});
```

Without a `publicKey` the driver refuses webhooks with an explicit error, unless you set
`verifySignature: false`.

| SendGrid event | Relayo event |
| --- | --- |
| processed | `accepted` |
| delivered | `delivered` |
| deferred | `deferred` |
| bounce | `bounced` |
| dropped | `rejected` (`suppressed`, `invalid_recipient` or `unknown`) |
| spamreport | `complained` |
| open / click | `opened` / `clicked` (with `url`) |
| unsubscribe, group_unsubscribe | `unsubscribed` |

`group_resubscribe` has no Relayo equivalent and is skipped. Bounces are classified from the SMTP status
and reason, refined with SendGrid's `bounce_classification`: `Reputation`, `Content` and `Frequency or
Volume` become `block` even with a 5xx code, and a `blocked` bounce is never `hard`. Event ids are
SendGrid's `sg_event_id`.
