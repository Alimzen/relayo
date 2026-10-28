# @alimzen/relayo-messagebird

[MessageBird](https://developers.messagebird.com/api/sms-messaging/) SMS driver for [Relayo](https://github.com/Alimzen/relayo): sends through the MessageBird SMS API and turns its signed status reports into Relayo's normalized events.

```sh
npm install @alimzen/relayo @alimzen/relayo-messagebird
```

No dependencies besides the core; uses `fetch` (Node 20+).

## Sending

```ts
import { createRelayo } from '@alimzen/relayo';
import { messagebird } from '@alimzen/relayo-messagebird';

const relayo = createRelayo({
  sms: messagebird({
    accessKey: process.env.MESSAGEBIRD_ACCESS_KEY!,
    originator: 'MyShop', // a number (E.164) or an alphanumeric sender of up to 11 characters
    signingKey: process.env.MESSAGEBIRD_SIGNING_KEY!, // Dashboard → Developers → signing key
    reportUrl: 'https://app.example.com/webhooks/relayo/messagebird',
  }),
});

await relayo.sms.send({ to: [{ address: '+34600111222' }, { address: '+34600333444' }], body: 'Your order is on its way' });
```

- Up to 50 recipients per request (more are split). Relayo's message id travels as `reference`: MessageBird only sends status reports for messages that have one, and they carry it back.
- `datacoding: auto`: accents and emoji go as unicode, the rest as plain GSM.
- `sendAt` schedules the message (`scheduledDatetime`).
- Errors: a wrong access key is an `AuthenticationError`, no valid recipients a `RejectedError`, no balance or a 5xx a `ProviderUnavailableError` (so `failover()` moves on), anything else a `ValidationError`.

## Status reports

MessageBird calls `reportUrl` (or the URL set in the dashboard) with a GET whose query holds the report. Pass the full URL the request came to as `req.url`: the signature covers it.

```ts
app.get('/webhooks/relayo/messagebird', async (req, res) => {
  await relayo.handleWebhook('sms', { headers: req.headers, body: undefined, url: req.originalUrl });
  res.sendStatus(200);
});
```

The signature is the `MessageBird-Signature-JWT` header: an HS256 token keyed with your signing key, issued by `MessageBird`, valid between `nbf` and `exp` (60 seconds of leeway, `webhook.leewaySeconds`), with the SHA-256 of the URL called (`url_hash`) and of the body, when there is one (`payload_hash`). A path in `req.url` is resolved against `reportUrl`.

| Status report | Relayo event |
| --- | --- |
| `sent` | `accepted` |
| `buffered` | `deferred` |
| `delivered` | `delivered` |
| `expired` | `bounced` · soft · `temporary_failure` |
| `delivery_failed` | `bounced`, by `statusReason`: an unknown subscriber or invalid number → hard · `user_unknown`; barred, blocked or filtered → block · `policy_block`; an unavailable or absent subscriber → soft · `temporary_failure`; otherwise soft · `unknown` |

## License

MIT
