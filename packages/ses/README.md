# @alimzen/ses

Amazon SES driver for [Relayo](../core): sends through the SES v2 API and turns SES events delivered by
Amazon SNS into Relayo events, verifying SNS signatures.

```sh
npm install @alimzen/core @alimzen/ses
```

## Sending

```ts
import { createRelayo } from '@alimzen/core';
import { ses } from '@alimzen/ses';

const relayo = createRelayo({
  email: ses({
    region: 'us-east-1',
    configurationSetName: 'relayo', // needed for events, see below
    webhook: { topicArns: ['arn:aws:sns:us-east-1:123456789012:ses-events'] },
  }),
});
```

| Option | |
| --- | --- |
| `region`, `credentials` | Passed to the `SESv2Client`. Without them the AWS SDK's defaults apply |
| `client` | An `SESv2Client` you already have (e.g. with custom retries) |
| `configurationSetName` | Configuration set used for event publishing |
| `metadataHeader` | Send `metadata` in the `X-Relayo-Metadata` header (default `true`, see below) |
| `name` | Provider name in results, events and errors (default `"ses"`) |
| `webhook.topicArns` | Only accept these SNS topics. Recommended |
| `webhook.confirmSubscriptions` | Confirm SNS subscriptions automatically (default `true`) |
| `webhook.verifySignature` | Check SNS signatures (default `true`). Turn off only for EventBridge or another trusted channel |

Results have `status: 'queued'`. `providerOptions` are merged into the `SendEmail` request (e.g.
`{ FeedbackForwardingEmailAddress }`).

Relayo's `messageId` goes as the `relayo_message_id` tag and the `X-Relayo-Message-ID` header. `metadata`
goes in the `X-Relayo-Metadata` header as base64 JSON so it comes back in events. **Recipients can see
headers**: set `metadataHeader: false` if your metadata is sensitive (events then come without `metadata`).
Message `tags` become SES tags; characters SES doesn't allow are replaced with `_`.

The AWS SDK retries throttling and server errors on its own (3 attempts by default). If your queue already
retries, pass a `client` created with `maxAttempts: 1`.

## Receiving events

1. In SES, add an **event destination** of type SNS to your configuration set, with the event types you
   want (sends, deliveries, bounces, complaints, rejects, delivery delays, opens, clicks, rendering
   failures, subscriptions).
2. In SNS, create an **HTTPS subscription** to your endpoint (e.g. `https://api.example.com/webhooks/ses`).
3. Pass each request to Relayo with its raw body. SNS posts JSON as `text/plain`:

```ts
app.post('/webhooks/ses', express.text({ type: '*/*' }), async (req, res) => {
  const events = await relayo.handleWebhook('email', { headers: req.headers, body: req.body, rawBody: req.body });
  res.json({ received: events.length });
});
```

The subscription confirmation SNS sends first is handled for you (only `sns.<region>.amazonaws.com` URLs
are visited). Signatures (versions 1 and 2) are checked against Amazon's certificate, fetched once and
cached. Identity notifications (the older "feedback notifications") and EventBridge events (with
`verifySignature: false`) are understood too.

| SES event | Relayo event |
| --- | --- |
| Send | `accepted` |
| Delivery | `delivered` (one per recipient) |
| DeliveryDelay | `deferred` |
| Reject | `rejected` (`content_rejected`) |
| Bounce | `bounced`; suppression-list bounces become `rejected` (`suppressed`) |
| Complaint | `complained`; suppression-list complaints become `rejected` (`suppressed`) |
| Open / Click | `opened` / `clicked` (with `url`) |
| Rendering Failure | `failed` |
| Subscription with `unsubscribeAll` | `unsubscribed` |

Bounces are classified from the SMTP status and diagnostic, refined with SES's bounce subtype: a
"Permanent" bounce from a blocklist becomes `block`/`reputation_block`, not `hard`. Event ids derive from
the SNS message id, so SNS redeliveries keep the same id.
