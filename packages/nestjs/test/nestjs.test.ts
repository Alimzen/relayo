import 'reflect-metadata';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Inject, Injectable, Module, Scope, type INestApplication, type NestApplicationOptions } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  memory,
  type BounceEvent,
  type EmailMessage,
  type MemoryDriver,
  type RelayoEvent,
} from '@alimzen/core';
import { sendgrid, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '@alimzen/sendgrid';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OnRelayoEvent,
  RELAYO_CLIENT,
  RelayoModule,
  RelayoService,
  type RelayoModuleExtras,
  type RelayoModuleOptions,
} from '../src/index.js';

const message: EmailMessage = {
  from: { address: 'facturas@empresa.com' },
  to: { address: 'cliente@empresa.com' },
  subject: 'Tu factura',
  text: 'Hola',
  metadata: { facturaId: '123' },
};

@Injectable()
class BillingService {
  readonly bounces: BounceEvent[] = [];
  readonly all: RelayoEvent[] = [];

  constructor(@Inject(RelayoService) private readonly relayo: RelayoService) {}

  sendInvoice() {
    return this.relayo.email.send(message);
  }

  @OnRelayoEvent('bounced')
  onBounce(event: BounceEvent) {
    this.bounces.push(event);
  }

  @OnRelayoEvent('*')
  onAnything(event: RelayoEvent) {
    this.all.push(event);
  }
}

@Injectable()
class FailingHandler {
  @OnRelayoEvent('complained')
  onComplaint() {
    throw new Error('database down');
  }
}

@Injectable({ scope: Scope.REQUEST })
class RequestScopedHandler {
  static calls = 0;
  @OnRelayoEvent('delivered')
  onDelivered() {
    RequestScopedHandler.calls++;
  }
}

const apps: INestApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function start(
  relayo: RelayoModuleOptions & RelayoModuleExtras,
  { fastify = false, appOptions = { rawBody: true } as NestApplicationOptions } = {},
) {
  const moduleRef = await Test.createTestingModule({
    imports: [RelayoModule.forRoot(relayo)],
    providers: [BillingService, FailingHandler, RequestScopedHandler],
  }).compile();
  const app = fastify
    ? moduleRef.createNestApplication(new FastifyAdapter(), appOptions)
    : moduleRef.createNestApplication(appOptions);
  apps.push(app);
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl(), billing: app.get(BillingService) };
}

function post(url: string, body: string, headers: Record<string, string> = {}) {
  return fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
}

describe('RelayoModule', () => {
  it('provides RelayoService and delivers events to @OnRelayoEvent methods', async () => {
    const driver = memory();
    const { app, billing } = await start({ email: driver });

    const { messageId } = await billing.sendInvoice();
    await app.get(RelayoService).emit(driver.createEvent(messageId, 'bounced', { bounceType: 'hard', reason: 'user_unknown' }));
    await app.get(RelayoService).emit(driver.createEvent(messageId, 'delivered'));

    expect(driver.sent).toHaveLength(1);
    expect(billing.bounces).toEqual([expect.objectContaining({ messageId, bounceType: 'hard', metadata: { facturaId: '123' } })]);
    expect(billing.all.map((e) => e.type)).toEqual(['bounced', 'delivered']);
    expect(RequestScopedHandler.calls).toBe(0);
  });

  it('exposes the raw Relayo instance and unsubscribes handlers on shutdown', async () => {
    const driver = memory();
    const { app, billing } = await start({ email: driver });
    const relayo = app.get(RELAYO_CLIENT);
    const { messageId } = await billing.sendInvoice();

    await app.close();
    apps.length = 0;
    await relayo.emit(driver.createEvent(messageId, 'delivered'));

    expect(billing.all).toHaveLength(0);
  });

  it('supports forRootAsync with injected configuration', async () => {
    const driver = memory({ name: 'from-config' });
    @Module({ providers: [{ provide: 'CONFIG', useValue: { driver } }], exports: ['CONFIG'] })
    class ConfigModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        RelayoModule.forRootAsync({
          imports: [ConfigModule],
          inject: ['CONFIG'],
          useFactory: async (config: { driver: MemoryDriver<EmailMessage> }) => ({ email: config.driver }),
        }),
      ],
      providers: [BillingService],
    }).compile();
    const app = moduleRef.createNestApplication();
    apps.push(app);
    await app.init();

    await expect(app.get(BillingService).sendInvoice()).resolves.toMatchObject({ provider: 'from-config' });
  });

  it('does not expose webhook routes unless asked', async () => {
    const { url } = await start({ email: memory() });
    expect((await post(`${url}/webhooks/relayo/email`, '[]')).status).toBe(404);
  });
});

describe.each([
  ['Express', false],
  ['Fastify', true],
])('webhook controller on %s', (_, fastify) => {
  it('parses, emits and answers with the number of events', async () => {
    const driver = memory();
    const { url, billing } = await start({ email: driver, webhooks: true }, { fastify });
    const { messageId } = await billing.sendInvoice();
    const body = JSON.stringify([
      driver.createEvent(messageId, 'delivered'),
      driver.createEvent(messageId, 'bounced', { bounceType: 'soft', reason: 'mailbox_full' }),
    ]);

    const response = await post(`${url}/webhooks/relayo/email`, body);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: 2 });
    expect(billing.bounces).toHaveLength(1);
  });

  it('reads JSON posted as text/plain, as Amazon SNS does', async () => {
    const driver = memory();
    const { url, billing } = await start({ email: driver, webhooks: { path: 'hooks' } }, { fastify });
    const { messageId } = await billing.sendInvoice();

    const response = await post(`${url}/hooks/email`, JSON.stringify(driver.createEvent(messageId, 'delivered')), {
      'content-type': 'text/plain; charset=UTF-8',
    });

    expect(response.status).toBe(200);
    expect(billing.all.map((e) => e.type)).toEqual(['delivered']);
  });

  it('answers 401 to bad signatures, 400 to bad requests and 500 when a handler fails', async () => {
    const driver = { ...memory(), verifyWebhook: (req: { headers: Record<string, unknown> }) => req.headers['x-ok'] === '1' };
    const { url, billing } = await start({ email: driver, webhooks: true }, { fastify });
    const { messageId } = await billing.sendInvoice();
    const complaint = JSON.stringify(driver.createEvent(messageId, 'complained'));

    expect((await post(`${url}/webhooks/relayo/email`, '[]')).status).toBe(401);
    expect((await post(`${url}/webhooks/relayo/push`, '[]', { 'x-ok': '1' })).status).toBe(400);
    expect((await post(`${url}/webhooks/relayo/sms`, '[]', { 'x-ok': '1' })).status).toBe(400);
    expect((await post(`${url}/webhooks/relayo/email`, complaint, { 'x-ok': '1' })).status).toBe(500);
  });

  it('verifies a signed SendGrid webhook end to end with the raw body', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const email = sendgrid({
      apiKey: 'k',
      webhook: { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') },
    });
    const { url, billing } = await start({ email, webhooks: true }, { fastify });

    // Spacing that JSON.stringify would not reproduce: only the raw bytes verify.
    const raw = '[ {"email":"cliente@empresa.com","timestamp":1792231207,"event":"bounce","type":"bounce",' +
      '"reason":"550 5.1.1 user unknown","status":"5.1.1","sg_event_id":"e1","relayo_message_id":"msg_1"} ]';
    const timestamp = '1792231300';
    const signature = sign('sha256', Buffer.from(timestamp + raw), privateKey).toString('base64');

    const ok = await post(`${url}/webhooks/relayo/email/sendgrid`, raw, {
      [SIGNATURE_HEADER]: signature,
      [TIMESTAMP_HEADER]: timestamp,
    });
    const tampered = await post(`${url}/webhooks/relayo/email/sendgrid`, raw.replace('5.1.1', '4.2.2'), {
      [SIGNATURE_HEADER]: signature,
      [TIMESTAMP_HEADER]: timestamp,
    });

    expect(ok.status).toBe(200);
    expect(tampered.status).toBe(401);
    expect(billing.bounces).toEqual([expect.objectContaining({ messageId: 'msg_1', bounceType: 'hard', reason: 'user_unknown' })]);
  });

  it('routes /:channel/:provider to the named driver', async () => {
    const driver = memory({ name: 'primary' });
    const { url } = await start({ email: driver, webhooks: true }, { fastify });

    expect((await post(`${url}/webhooks/relayo/email/primary`, '[]')).status).toBe(200);
  });
});
