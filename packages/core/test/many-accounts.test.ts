import { describe, expect, it } from 'vitest';
import {
  createRelayo,
  memory,
  ProviderUnavailableError,
  ValidationError,
  type EmailMessage,
  type RelayoEvent,
  type SmsMessage,
} from '../src/index.js';

const email = (to: string): EmailMessage => ({
  from: { address: 'facturas@empresa.com' },
  to: { address: to },
  subject: 'Tu factura',
  text: 'Hola',
});

describe('sendMany', () => {
  it('sends every message and reports each one, in order, without stopping at failures', async () => {
    const driver = memory({
      fail: (m) => (m.to as { address: string }).address === 'caido@empresa.com' ? new ProviderUnavailableError('down', { provider: 'memory' }) : undefined,
    });
    const relayo = createRelayo({ email: driver });

    const outcomes = await relayo.email.sendMany([
      email('ana@empresa.com'),
      email('no-es-un-email'),
      email('caido@empresa.com'),
      email('luis@empresa.com'),
    ]);

    expect(outcomes.map((o) => o.ok)).toEqual([true, false, false, true]);
    expect(outcomes[1]!.ok === false && outcomes[1]!.error).toBeInstanceOf(ValidationError);
    expect(outcomes[2]!.ok === false && outcomes[2]!.error).toBeInstanceOf(ProviderUnavailableError);
    expect(new Set(outcomes.map((o) => o.messageId)).size).toBe(4);
    expect(driver.sent.map((s) => (s.message.to as { address: string }).address)).toEqual(['ana@empresa.com', 'luis@empresa.com']);
    const first = outcomes[0]!;
    expect(first.ok && first.result.messageId).toBe(first.messageId);
  });

  it('keeps at most `concurrency` sends in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const base = memory();
    const relayo = createRelayo({
      email: {
        ...base,
        async send(message, context) {
          peak = Math.max(peak, ++inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return base.send(message, context);
        },
      },
    });

    const outcomes = await relayo.email.sendMany(
      Array.from({ length: 12 }, (_, i) => email(`c${i}@empresa.com`)),
      { concurrency: 3 },
    );
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(peak).toBe(3);
  });

  it('handles an empty list and rejects a bad concurrency', async () => {
    const relayo = createRelayo({ email: memory() });
    expect(await relayo.email.sendMany([])).toEqual([]);
    await expect(relayo.email.sendMany([email('a@b.co')], { concurrency: 0 })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('accounts', () => {
  it('sends through the named account and keeps the default one', async () => {
    const transactional = memory({ name: 'ses' });
    const marketing = memory({ name: 'smtp-marketing' });
    const sms = memory({ channel: 'sms', name: 'twilio' });
    const relayo = createRelayo({ email: transactional, accounts: { marketing: { email: marketing }, alerts: { sms } } });

    await relayo.email.send(email('ana@empresa.com'));
    const result = await relayo.account('marketing').email.send(email('luis@empresa.com'));
    await relayo.account('alerts').sms.send({ to: { address: '+34600000000' }, body: 'Hola' } satisfies SmsMessage);

    expect(result.provider).toBe('smtp-marketing');
    expect(transactional.sent).toHaveLength(1);
    expect(marketing.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(1);
    expect(relayo.accounts).toEqual(['marketing', 'alerts']);
  });

  it('says clearly which account is missing a driver, or does not exist', async () => {
    const relayo = createRelayo({ email: memory(), accounts: { marketing: { email: memory() } } });
    await expect(relayo.account('marketing').sms.send({ to: { address: '+34600000000' }, body: 'x' })).rejects.toThrow(
      'No sms driver configured for account "marketing"',
    );
    expect(() => relayo.account('ventas')).toThrow('Unknown account "ventas"');
  });

  it('checks the drivers of every account', () => {
    expect(() => createRelayo({ accounts: { avisos: { email: memory({ channel: 'sms' }) as never } } })).toThrow(
      'configured for email in account "avisos"',
    );
  });

  it('routes webhooks to the account driver and marks their events with it', async () => {
    const marketing = memory({ name: 'smtp-marketing' });
    const relayo = createRelayo({ email: memory(), accounts: { marketing: { email: marketing } } });
    const seen: RelayoEvent[] = [];
    relayo.on('*', (e) => void seen.push(e));
    const { messageId } = await relayo.account('marketing').email.send(email('luis@empresa.com'));

    const events = await relayo.handleWebhook('email', {
      headers: {},
      body: marketing.createEvent(messageId, 'delivered'),
      account: 'marketing',
    });

    expect(events).toEqual([expect.objectContaining({ type: 'delivered', account: 'marketing', provider: 'smtp-marketing' })]);
    expect(seen[0]!.account).toBe('marketing');
    await expect(relayo.handleWebhook('email', { headers: {}, body: [], account: 'nope' })).rejects.toThrow('Unknown account "nope"');
  });
});
