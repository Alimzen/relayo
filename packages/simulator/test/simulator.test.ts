import { createHmac } from 'node:crypto';
import { AuthenticationError, createRelayo, ProviderUnavailableError, ValidationError } from '@alimzen/core';
import { describe, expect, it, vi } from 'vitest';
import { scenarioAddress, simulator } from '../src/index.js';

const fakeFetch = (response: () => Response | Promise<Response>) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response());
const SECRET = 'whsec_test';

function signed(event: unknown, timestamp = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(event);
  const v1 = createHmac('sha256', SECRET).update(`${timestamp}.${raw}`).digest('hex');
  return { headers: { 'relayo-signature': `t=${timestamp},v1=${v1}` }, body: JSON.parse(raw) as unknown, rawBody: raw };
}

const bounce = {
  id: 'sim_1:hard-bounce@sim.relayo.dev:1',
  type: 'bounced',
  channel: 'email',
  provider: 'simulator',
  messageId: 'msg_1',
  providerMessageId: 'sim_1',
  recipient: 'hard-bounce@sim.relayo.dev',
  timestamp: '2026-10-18T12:00:00.000Z',
  bounceType: 'hard',
  reason: 'user_unknown',
  smtpCode: 550,
  enhancedCode: '5.1.1',
  raw: { scenario: { name: 'hard-bounce' } },
};

describe('simulator driver', () => {
  it('posts to /v1/messages with Relayo\'s message id', async () => {
    const fetch = fakeFetch(() => Response.json({ id: 'sim_1', status: 'queued' }, { status: 202 }));
    const relayo = createRelayo({
      email: simulator({ apiKey: 'sim_live_x', baseUrl: 'http://localhost:3000/', fetch }),
      generateId: () => 'msg_1',
    });

    const result = await relayo.email.send({
      from: { address: 'a@empresa.com' },
      to: { address: scenarioAddress('hard-bounce') },
      subject: 's',
      text: 't',
      metadata: { k: 'v' },
    });

    expect(result).toEqual({ messageId: 'msg_1', providerMessageId: 'sim_1', provider: 'simulator', status: 'queued' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/v1/messages');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer sim_live_x' });
    expect(JSON.parse(init!.body as string)).toMatchObject({
      to: [{ address: 'hard-bounce@sim.relayo.dev' }],
      metadata: { k: 'v' },
      relayoMessageId: 'msg_1',
    });
  });

  it.each([
    [400, ValidationError],
    [401, AuthenticationError],
    [503, ProviderUnavailableError],
  ])('maps HTTP %i', async (status, expected) => {
    const fetch = fakeFetch(() => Response.json({ message: 'nope' }, { status }));
    const relayo = createRelayo({ email: simulator({ apiKey: 'k', baseUrl: 'http://x', fetch }) });
    await expect(relayo.email.send({ from: { address: 'a@b.c' }, to: { address: 'c@d.e' }, subject: 's', text: 't' })).rejects.toBeInstanceOf(expected);
  });

  it('needs a baseUrl: there is no default host to send API keys to', () => {
    expect(() => simulator({ apiKey: 'k', baseUrl: '' })).toThrow(/baseUrl/);
  });

  it('verifies webhook signatures and returns the event as sent', async () => {
    const relayo = createRelayo({ email: simulator({ apiKey: 'k', baseUrl: 'http://x', webhook: { secret: SECRET } }) });
    const [event] = await relayo.handleWebhook('email', signed(bounce));
    expect(event).toMatchObject({ type: 'bounced', bounceType: 'hard', messageId: 'msg_1' });
    expect(event!.timestamp).toEqual(new Date('2026-10-18T12:00:00.000Z'));

    await expect(relayo.handleWebhook('email', { ...signed(bounce), rawBody: JSON.stringify({ ...bounce, type: 'delivered' }) })).rejects.toThrow(
      /Invalid webhook signature/,
    );
    await expect(relayo.handleWebhook('email', signed(bounce, Math.floor(Date.now() / 1000) - 3600))).rejects.toThrow(
      /Invalid webhook signature/,
    );
  });

  it('builds scenario addresses', () => {
    expect(scenarioAddress('greylist', 3)).toBe('greylist+3@sim.relayo.dev');
    expect(scenarioAddress('delay', '30m', 'sim.local')).toBe('delay+30m@sim.local');
  });
});
