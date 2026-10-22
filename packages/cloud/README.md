# @alimzen/relayo-cloud

Use the **Relayo platform as your email and SMS provider**: one API key instead of each provider's
credentials, one signed webhook with every event already normalized, and the panel to see what happened to
each message.

```sh
npm install @alimzen/relayo @alimzen/relayo-cloud
```

```ts
import { createRelayo } from '@alimzen/relayo';
import { relayoCloud, relayoCloudSms } from '@alimzen/relayo-cloud';

const options = {
  apiKey: process.env.RELAYO_API_KEY!, // rly_test_… or rly_live_…
  webhook: { secret: process.env.RELAYO_WEBHOOK_SECRET! },
};
const relayo = createRelayo({ email: relayoCloud(options), sms: relayoCloudSms(options) });

await relayo.email.send({ from: { address: 'billing@example.com' }, to: { address: 'ana@example.com' }, subject: 'Your invoice', html });
relayo.on('bounced', (event) => markInvalid(event.recipient));
```

## Test and live keys

The project's keys decide what happens; your code stays the same.

| Key | What it does |
| --- | --- |
| `rly_test_…` | Simulates: scenario addresses (`hard-bounce@sim.relayo.dev`…) and numbers play bounces, complaints, deferrals… Nothing is delivered. |
| `rly_live_…` | Delivers through the providers connected to the project in the panel (SES, SendGrid, Resend, Postmark, Mailgun, SMTP), in order, with failover. |

In live mode the platform also keeps a suppression list (hard bounces, complaints and unsubscribes are not
sent to again) and receives your providers' webhooks, so all their events reach your app through the one
Relayo webhook.

## Options

| Option | |
| --- | --- |
| `apiKey` | A project key from the panel |
| `baseUrl` | Another Relayo installation. Default `https://relayo.alimzen.com` |
| `webhook` | `{ secret }`: the project's webhook secret, to verify incoming events |
| `timeoutMs`, `name`, `fetch` | As in the other drivers |

`scenarioAddress()` and `scenarioNumber()` are re-exported for tests with test keys.

## License

MIT
