# @alimzen/nestjs

NestJS module for [Relayo](../core): configure drivers once, inject `RelayoService` anywhere, react to
delivery events with `@OnRelayoEvent()`, and receive provider webhooks with a ready-made controller.

```sh
npm install @alimzen/core @alimzen/nestjs @alimzen/sendgrid
```

Works with NestJS 11 and 12, on Express and Fastify. NestJS 12 is ESM-only: a CommonJS project on
NestJS 12 needs Node.js 20.19+ or 22.12+.

## Setup

```ts
// main.ts: the raw body is needed to verify webhook signatures
const app = await NestFactory.create(AppModule, { rawBody: true });
```

```ts
// app.module.ts
import { failover } from '@alimzen/core';
import { RelayoModule } from '@alimzen/nestjs';
import { sendgrid } from '@alimzen/sendgrid';
import { ses } from '@alimzen/ses';

@Module({
  imports: [
    RelayoModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        email: failover([
          ses({ region: 'eu-west-1' }),
          sendgrid({ apiKey: config.getOrThrow('SENDGRID_API_KEY'), webhook: { publicKey: config.getOrThrow('SENDGRID_WEBHOOK_KEY') } }),
        ]),
      }),
      webhooks: true,
    }),
  ],
})
export class AppModule {}
```

`RelayoModule.forRoot({ email, sms, webhooks })` does the same with static options. The module is global
by default (`isGlobal: false` to opt out).

## Sending and handling events

```ts
import { OnRelayoEvent, RelayoService } from '@alimzen/nestjs';
import type { BounceEvent, RelayoEvent } from '@alimzen/core';

@Injectable()
export class InvoiceMailer {
  constructor(private readonly relayo: RelayoService) {}

  send(invoice: Invoice) {
    return this.relayo.email.send({
      from: { address: 'billing@example.com' },
      to: { address: invoice.customerEmail },
      subject: `Invoice ${invoice.number}`,
      html: renderInvoice(invoice),
      metadata: { invoiceId: invoice.id },
    });
  }

  @OnRelayoEvent('bounced')
  async onBounce(event: BounceEvent) {
    if (event.bounceType === 'hard') await this.contacts.markInvalid(event.recipient);
  }

  @OnRelayoEvent('complained', 'unsubscribed')
  async onOptOut(event: RelayoEvent) {
    await this.contacts.stopSending(event.recipient);
  }
}
```

`@OnRelayoEvent()` takes one or more event types, or `'*'` for all, and works on singleton providers.
Request-scoped providers are skipped with a warning. `RelayoService` has the same API as the `Relayo`
instance (`email`, `sms`, `on`, `off`, `emit`, `handleWebhook`); the `RELAYO_CLIENT` token gives you the
instance itself.

## Webhooks

With `webhooks: true` (or `{ path: 'hooks/mail' }`) the module adds:

- `POST /webhooks/relayo/:channel`, e.g. `/webhooks/relayo/email`
- `POST /webhooks/relayo/:channel/:provider`, e.g. `/webhooks/relayo/email/sendgrid`. Use this form with
  `failover()`, one URL per provider.

| Response | When |
| --- | --- |
| `200 { received: n }` | Events verified, normalized and handled |
| `401` | Signature check failed |
| `400` | Unknown channel or payload the driver doesn't understand |
| `500` | A handler threw. The provider will deliver the webhook again, so handlers should be idempotent (use `event.id`) |

The controller reads `req.rawBody` (enable `rawBody: true`). JSON posted as `text/plain`, as Amazon SNS does,
is read too. If a signature fails and no raw body was available, the module logs a hint once.
