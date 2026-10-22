import { createHmac } from 'node:crypto';
import { createRelayo } from '@alimzen/relayo';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_BASE_URL, relayoCloud, relayoCloudSms } from '../src/index.js';

const accepted = () => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ id: 'sim_1', status: 'queued' }, { status: 202 }));

describe('relayoCloud', () => {
  it('sends email to the hosted platform by default, as "relayo"', async () => {
    const fetch = accepted();
    const relayo = createRelayo({ email: relayoCloud({ apiKey: 'rly_live_x', fetch }), generateId: () => 'msg_1' });
    const result = await relayo.email.send({ from: { address: 'a@empresa.com' }, to: { address: 'ana@cliente.com' }, subject: 's', text: 't' });

    expect(fetch.mock.calls[0]![0]).toBe(`${DEFAULT_BASE_URL}/v1/messages`);
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: 'Bearer rly_live_x' });
    expect(result).toMatchObject({ messageId: 'msg_1', providerMessageId: 'sim_1', provider: 'relayo' });
  });

  it('sends SMS with the same key, and can target another installation', async () => {
    const fetch = accepted();
    const relayo = createRelayo({ sms: relayoCloudSms({ apiKey: 'rly_test_x', baseUrl: 'http://localhost:3000', fetch }) });
    await relayo.sms.send({ to: { address: '+34600111222' }, body: 'Hola' });
    expect(fetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/sms');
  });

  it('verifies the platform webhook signature', async () => {
    const relayo = createRelayo({ email: relayoCloud({ apiKey: 'k', webhook: { secret: 'whsec_x' } }) });
    const raw = JSON.stringify({ id: 'e1', type: 'delivered', channel: 'email', provider: 'relayo', messageId: 'm', recipient: 'a@b.co', timestamp: new Date().toISOString(), raw: {} });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', 'whsec_x').update(`${t}.${raw}`).digest('hex');
    const events = await relayo.handleWebhook('email', { headers: { 'relayo-signature': `t=${t},v1=${v1}` }, body: JSON.parse(raw), rawBody: raw });
    expect(events).toEqual([expect.objectContaining({ type: 'delivered', provider: 'relayo' })]);
  });
});
