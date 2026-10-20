import { readFileSync } from 'node:fs';
import { createRelayo, memory, type BounceEvent } from '@alimzen/relayo';
import { describe, expect, it, vi } from 'vitest';
import { parseBounceEmail } from '../src/index.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const ID = '7b1f3c9e-6a4d-4c1e-9d2b-1f0e8a7c6b5d';

describe('delivery status notifications (RFC 3464)', () => {
  it('reads a Postfix bounce, with the Relayo id and metadata from the quoted headers', () => {
    const { kind, events } = parseBounceEmail(fixture('postfix-user-unknown.eml'));

    expect(kind).toBe('dsn');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'bounced',
      channel: 'email',
      provider: 'smtp',
      messageId: ID,
      providerMessageId: `<${ID}@empresa.com>`,
      recipient: 'noexiste@example.com',
      bounceType: 'hard',
      reason: 'user_unknown',
      smtpCode: 550,
      enhancedCode: '5.1.1',
      metadata: { invoiceId: '123' },
    });
    expect((events[0] as BounceEvent).diagnostic).toMatch(/^550 5\.1\.1 <noexiste@example.com>: Recipient address rejected/);
    expect(events[0]!.timestamp).toEqual(new Date('2026-10-17T10:00:01Z'));
  });

  it('reads a Gmail bounce and recovers the Relayo id from the Message-ID set by the SMTP driver', () => {
    const { kind, events } = parseBounceEmail(fixture('gmail-user-unknown.eml'));

    expect(kind).toBe('dsn');
    expect(events[0]).toMatchObject({
      messageId: ID,
      recipient: 'noexiste@gmail.com',
      bounceType: 'hard',
      reason: 'user_unknown',
      smtpCode: 550,
    });
    expect(events[0]!.timestamp).toEqual(new Date('2026-10-17T10:00:06Z'));
  });

  it('reads a Microsoft 365 report with CRLF line endings and base64-encoded headers', () => {
    const { events } = parseBounceEmail(fixture('o365-recipient-not-found.eml'), { provider: 'office365' });

    expect(events[0]).toMatchObject({
      provider: 'office365',
      messageId: ID,
      recipient: 'ana@contoso.com',
      bounceType: 'hard',
      reason: 'user_unknown', // 5.1.10 RecipientNotFound, not "null MX"
      metadata: { invoiceId: '123' },
    });
  });

  it('turns several recipients into one event each: a delay and a blocklist refusal', () => {
    const { events } = parseBounceEmail(fixture('postfix-delayed-and-blocked.eml'));

    expect(events.map((e) => [e.type, e.recipient])).toEqual([
      ['deferred', 'lento@example.net'],
      ['bounced', 'cliente@example.org'],
    ]);
    expect(events[1]).toMatchObject({ bounceType: 'block', reason: 'reputation_block', smtpCode: 554 });
  });

  it('reports successful deliveries when the DSN says so', () => {
    const raw = [
      'From: MAILER-DAEMON@mx.example.com',
      'Message-ID: <ok-1@mx.example.com>',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b"',
      '',
      '--b',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; mx.example.com',
      '',
      'Final-Recipient: rfc822; ana@example.com',
      'Action: delivered',
      'Status: 2.0.0',
      '',
      '--b--',
      '',
    ].join('\r\n');

    expect(parseBounceEmail(raw).events).toEqual([expect.objectContaining({ type: 'delivered', recipient: 'ana@example.com' })]);
  });

  it('gives the same ids when the same report is processed twice', () => {
    const a = parseBounceEmail(fixture('postfix-delayed-and-blocked.eml')).events.map((e) => e.id);
    const b = parseBounceEmail(fixture('postfix-delayed-and-blocked.eml').toString('latin1')).events.map((e) => e.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(2);
  });
});

describe('spam complaints (ARF, RFC 5965)', () => {
  it('reads a feedback-loop report as a complaint about the original send', () => {
    const { kind, events } = parseBounceEmail(fixture('arf-abuse.eml'));

    expect(kind).toBe('arf');
    expect(events).toEqual([
      expect.objectContaining({
        type: 'complained',
        recipient: 'cliente@example.com',
        messageId: ID,
        metadata: { invoiceId: '123' },
        timestamp: new Date('2026-10-17T10:00:02Z'),
      }),
    ]);
  });

  it('still identifies the send when the recipient is redacted', () => {
    const { events } = parseBounceEmail(fixture('arf-redacted.eml'));
    expect(events).toEqual([expect.objectContaining({ type: 'complained', recipient: '', messageId: ID })]);
  });

  it('ignores not-spam reports', () => {
    const raw = fixture('arf-abuse.eml').toString('latin1').replace('Feedback-Type: abuse', 'Feedback-Type: not-spam');
    expect(parseBounceEmail(raw)).toEqual({ kind: 'arf', events: [] });
  });
});

describe('other mail at the bounce address', () => {
  it('understands non-standard bounces that list X-Failed-Recipients', () => {
    const { kind, events } = parseBounceEmail(fixture('exim-plain.eml'));

    expect(kind).toBe('non-standard');
    expect(events[0]).toMatchObject({
      type: 'bounced',
      recipient: 'borrado@example.net',
      bounceType: 'hard',
      reason: 'mailbox_disabled',
      enhancedCode: '5.2.1',
    });
  });

  it('ignores out-of-office replies', () => {
    expect(parseBounceEmail(fixture('out-of-office.eml'))).toEqual({ kind: 'auto-reply', events: [] });
  });

  it('leaves unrelated mail alone', () => {
    expect(parseBounceEmail(fixture('regular-reply.eml'))).toEqual({ kind: 'unrecognized', events: [] });
  });
});

describe('with createRelayo', () => {
  it('feeds parsed bounces to the same handlers as provider webhooks', async () => {
    const relayo = createRelayo({ email: memory() });
    const onBounce = vi.fn();
    relayo.on('bounced', onBounce);

    for (const event of parseBounceEmail(fixture('postfix-user-unknown.eml')).events) await relayo.emit(event);

    expect(onBounce).toHaveBeenCalledWith(expect.objectContaining({ messageId: ID, bounceType: 'hard' }));
  });
});
