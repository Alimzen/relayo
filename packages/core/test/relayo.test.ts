import { describe, expect, it, vi } from 'vitest';
import {
  createRelayo,
  memory,
  ProviderUnavailableError,
  RateLimitError,
  ValidationError,
  WebhookVerificationError,
  type BounceEvent,
  type EmailMessage,
  type RelayoEvent,
} from '../src/index.js';

const email: EmailMessage = {
  from: { address: 'facturas@empresa.com' },
  to: { address: 'cliente@empresa.com' },
  subject: 'Tu factura de octubre',
  html: '<p>...</p>',
  metadata: { facturaId: '123' },
};

describe('createRelayo', () => {
  it('sends an email through the configured driver with a core-generated messageId', async () => {
    const driver = memory();
    const relayo = createRelayo({ email: driver, generateId: () => 'msg_1' });

    const result = await relayo.email.send(email);

    expect(result).toEqual({
      messageId: 'msg_1',
      providerMessageId: 'memory_1',
      provider: 'memory',
      status: 'sent',
    });
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]!.message).toBe(email);
  });

  it('sends SMS through the sms driver', async () => {
    const sms = memory({ channel: 'sms' });
    const relayo = createRelayo({ sms });

    await relayo.sms.send({ to: { address: '+34600000000' }, body: 'Tu código es 1234' });

    expect(sms.sent[0]!.message.body).toBe('Tu código es 1234');
  });

  it('rejects a driver configured for the wrong channel', () => {
    expect(() => createRelayo({ email: memory({ channel: 'sms' }) as never })).toThrow(ValidationError);
  });

  it('fails when the channel has no driver', async () => {
    const relayo = createRelayo({ email: memory() });
    await expect(relayo.sms.send({ to: { address: '+34600000000' }, body: 'hola' })).rejects.toThrow(
      /No sms driver configured/,
    );
  });

  describe('validation', () => {
    const relayo = createRelayo({ email: memory(), sms: memory({ channel: 'sms' }) });

    it.each([
      ['no body', { ...email, html: undefined }],
      ['bad from', { ...email, from: { address: 'nope' } }],
      ['no recipients', { ...email, to: [] }],
      ['bad cc', { ...email, cc: [{ address: 'x' }] }],
    ])('rejects an email with %s', async (_, message) => {
      const error = await relayo.email.send(message as EmailMessage).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ code: 'validation_error', retryable: false });
    });

    it('rejects SMS numbers not in E.164', async () => {
      await expect(relayo.sms.send({ to: { address: '600000000' }, body: 'hola' })).rejects.toThrow(
        ValidationError,
      );
      await expect(relayo.sms.send({ to: { address: 'whatsapp:600000000' }, body: 'hola' })).rejects.toThrow(ValidationError);
    });

    it('accepts WhatsApp numbers (whatsapp:+E.164) for drivers that route them', async () => {
      await expect(relayo.sms.send({ to: { address: 'whatsapp:+34600000000' }, body: 'hola' })).resolves.toMatchObject({ status: 'sent' });
    });

    it('rejects attachments when the driver does not support them', async () => {
      const r = createRelayo({ email: memory({ capabilities: { attachments: false } }) });
      await expect(
        r.email.send({ ...email, attachments: [{ filename: 'a.pdf', content: 'x' }] }),
      ).rejects.toThrow(/does not support attachments/);
    });

    it('validates the whole batch before sending anything', async () => {
      const driver = memory();
      const r = createRelayo({ email: driver });
      await expect(r.email.sendBatch([email, { ...email, subject: undefined as never }])).rejects.toThrow(
        ValidationError,
      );
      expect(driver.sent).toHaveLength(0);
    });
  });

  it('sends a batch with distinct messageIds', async () => {
    const driver = memory();
    let n = 0;
    const relayo = createRelayo({ email: driver, generateId: () => `msg_${++n}` });

    const results = await relayo.email.sendBatch([email, email]);

    expect(results.map((r) => r.messageId)).toEqual(['msg_1', 'msg_2']);
  });

  it('falls back to individual sends when the driver has no batch support', async () => {
    const driver = memory({ capabilities: { batch: false } });
    const batchSpy = vi.spyOn(driver, 'sendBatch');
    const relayo = createRelayo({ email: driver });

    await relayo.email.sendBatch([email, email]);

    expect(batchSpy).not.toHaveBeenCalled();
    expect(driver.sent).toHaveLength(2);
  });

  it('propagates driver errors with their retryable flag', async () => {
    const relayo = createRelayo({
      email: memory({ fail: () => new RateLimitError('slow down', { provider: 'memory', retryAfter: 5 }) }),
    });

    const error = await relayo.email.send(email).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ retryable: true, retryAfter: 5, provider: 'memory', name: 'RateLimitError' });
  });

  it('marks provider outages as retryable', () => {
    expect(new ProviderUnavailableError('down').retryable).toBe(true);
  });
});

describe('events', () => {
  it('delivers events to typed handlers with metadata', async () => {
    const driver = memory();
    const relayo = createRelayo({ email: driver });
    const bounced = vi.fn<(e: BounceEvent) => void>();
    const all = vi.fn<(e: RelayoEvent) => void>();
    relayo.on('bounced', bounced);
    relayo.on('*', all);

    const { messageId } = await relayo.email.send(email);
    await relayo.emit(
      driver.createEvent(messageId, 'bounced', { bounceType: 'hard', reason: 'user_unknown', smtpCode: 550 }),
    );

    expect(bounced).toHaveBeenCalledOnce();
    expect(bounced.mock.calls[0]![0]).toMatchObject({
      messageId,
      recipient: 'cliente@empresa.com',
      bounceType: 'hard',
      reason: 'user_unknown',
      metadata: { facturaId: '123' },
    });
    expect(all).toHaveBeenCalledOnce();
  });

  it('stops delivering after unsubscribing', async () => {
    const driver = memory();
    const relayo = createRelayo({ email: driver });
    const handler = vi.fn();
    const unsubscribe = relayo.on('delivered', handler);

    const { messageId } = await relayo.email.send(email);
    unsubscribe();
    await relayo.emit(driver.createEvent(messageId, 'delivered'));

    expect(handler).not.toHaveBeenCalled();
  });

  it('parses webhooks with the driver and emits each event', async () => {
    const driver = memory();
    const relayo = createRelayo({ email: driver });
    const handler = vi.fn();
    relayo.on('delivered', handler);

    const { messageId } = await relayo.email.send(email);
    const body = JSON.parse(JSON.stringify([driver.createEvent(messageId, 'delivered')]));
    const events = await relayo.handleWebhook('email', { headers: {}, body });

    expect(events).toHaveLength(1);
    expect(events[0]!.timestamp).toBeInstanceOf(Date);
    expect(events[0]!.raw).toEqual(body[0]);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('refuses webhooks that fail verification', async () => {
    const driver = { ...memory(), verifyWebhook: () => false };
    const relayo = createRelayo({ email: driver });
    const handler = vi.fn();
    relayo.on('*', handler);

    await expect(relayo.handleWebhook('email', { headers: {}, body: [] })).rejects.toThrow(
      WebhookVerificationError,
    );
    expect(handler).not.toHaveBeenCalled();
  });
});
