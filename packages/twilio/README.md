# @alimzen/relayo-twilio

Twilio SMS driver for [Relayo](https://github.com/Alimzen/relayo): send through the Twilio Messages API and
get every status (delivered, undelivered, failed) and STOP reply as normalized Relayo events.

```sh
npm install @alimzen/relayo @alimzen/relayo-twilio
```

```ts
import { createRelayo } from '@alimzen/relayo';
import { twilio } from '@alimzen/relayo-twilio';

const relayo = createRelayo({
  sms: twilio({
    accountSid: process.env.TWILIO_ACCOUNT_SID!,
    authToken: process.env.TWILIO_AUTH_TOKEN!,
    from: '+15550001111', // or messagingServiceSid: 'MG…'
    statusCallback: 'https://app.example.com/webhooks/relayo/sms',
  }),
});

await relayo.sms.send({ to: { address: '+34600111222' }, body: 'Your code is 482913', metadata: { userId: '42' } });
relayo.on('bounced', (event) => event.channel === 'sms' && markPhoneInvalid(event.recipient));
```

## Webhooks

Twilio posts each message's status to `statusCallback`. The driver adds Relayo's message id to that URL
(`?relayo_message_id=…`), so the events carry it, and checks Twilio's signature (`X-Twilio-Signature`, HMAC-SHA1
of the full URL and the parameters, keyed with your auth token). Pass the URL the request came to as
`req.url` (the NestJS module does it for you); a path is resolved against `statusCallback`.

To turn STOP replies into `unsubscribed` events, point your number's incoming-message webhook at the same URL.

| Twilio | Relayo event |
| --- | --- |
| `sent` | `accepted` |
| `delivered` | `delivered` |
| `undelivered` 30005 / 30006 | `bounced` hard (unknown handset, landline) |
| `undelivered` 30003, 30008 | `bounced` soft (unreachable, unknown error) |
| `undelivered` 30004 / 30007 | `bounced` block (blocked, carrier filtering) |
| `failed` 21610 | `rejected` / `suppressed` (the recipient replied STOP) |
| `failed` 21211, 21612, 21614 | `rejected` / `invalid_recipient` |
| `failed` (others) | `failed` |
| Incoming STOP (`OptOutType=STOP`) | `unsubscribed` |

Twilio has no message metadata, so these events carry no `metadata`: look the message up by `event.messageId`.
Through the Relayo platform (`@alimzen/relayo-cloud`), events do carry it, since the platform stores each message.

## License

MIT
