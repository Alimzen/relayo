# @alimzen/relayo-vonage

[Vonage](https://www.vonage.com/communications-apis/sms/) SMS driver for [Relayo](https://github.com/Alimzen/relayo): sends through the Vonage SMS API and turns its delivery receipts into Relayo's normalized events.

```sh
npm install @alimzen/relayo @alimzen/relayo-vonage
```

No dependencies besides the core; uses `fetch` (Node 20+).

## Sending

```ts
import { createRelayo } from '@alimzen/relayo';
import { vonage } from '@alimzen/relayo-vonage';

const relayo = createRelayo({
  sms: vonage({
    apiKey: process.env.VONAGE_API_KEY!,
    apiSecret: process.env.VONAGE_API_SECRET!,
    from: 'MyShop', // a Vonage number (E.164) or an alphanumeric sender where the country allows it
    callbackUrl: 'https://app.example.com/webhooks/relayo/vonage',
  }),
});

await relayo.sms.send({ to: { address: '+34600111222' }, body: 'Your code is 482913', metadata: { userId: '42' } });
```

- One request per recipient. Relayo's message id travels as `client-ref`, so every receipt maps back to the message.
- Bodies with accents or emoji go as `unicode`; plain ASCII as `text` (more characters per part).
- Vonage answers `200` even when a message fails; the driver reads each part's `status` and throws the matching error: throttling as `RateLimitError`, bad credentials or a suspended account as `AuthenticationError`, no credit or an internal error as `ProviderUnavailableError` (so `failover()` moves on), an unroutable, barred or deactivated number as `RejectedError` (skipped among several recipients, reported in `rejectedRecipients`).

## Delivery receipts

Point the account's delivery receipt URL (or `callbackUrl`) at your webhook and pass each request to Relayo:

```ts
app.post('/webhooks/relayo/vonage', express.json(), async (req, res) => {
  await relayo.handleWebhook('sms', { headers: req.headers, body: req.body, url: req.originalUrl });
  res.sendStatus(204);
});
```

Receipts posted as JSON, as a form or in the query string (GET) are all read.

| Receipt | Relayo event |
| --- | --- |
| `accepted` | `accepted` |
| `buffered` | `deferred` |
| `delivered` | `delivered` |
| `expired` | `bounced` · soft · `temporary_failure` |
| `failed` / `rejected` | by `err-code`: `3` and `12` → `bounced` · hard · `user_unknown`; `2`, `7`, `8` → soft · `temporary_failure`; `6` and `17` → block · `content_rejected`; `4`, `13`, `14` and Fraud Defender rules → block · `policy_block`; `39` and `50`–`52` (sender registration) → block · `auth_failure`; `9` (the user opted out) → `rejected` · `suppressed`; `10`, `11`, `54`, `99` → `failed` |

### Signatures

Vonage signs webhooks only once its support enables signing on the account. Then pass the signature secret, and the method if it is not the default `md5hash` (`md5`, `sha1`, `sha256` or `sha512` are HMACs):

```ts
vonage({ ..., webhook: { signatureSecret: process.env.VONAGE_SIGNATURE_SECRET!, signatureMethod: 'sha256' } });
```

Signed receipts older than five minutes are refused (`toleranceSeconds`). Without a secret, receipts are accepted unsigned: keep the callback URL secret, with a token in its path.

## License

MIT
