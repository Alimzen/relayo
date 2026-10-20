import type { AddressInfo } from 'node:net';
import {
  AuthenticationError,
  createRelayo,
  ProviderUnavailableError,
  RateLimitError,
  RejectedError,
  ValidationError,
  type EmailMessage,
} from '@alimzen/relayo';
import { SMTPServer, type SMTPServerOptions } from 'smtp-server';
import { afterEach, describe, expect, it } from 'vitest';
import { MESSAGE_ID_HEADER, METADATA_HEADER, smtp, toMailOptions, toRelayoError } from '../src/index.js';

const message: EmailMessage = {
  from: { address: 'facturas@empresa.com', name: 'Facturas' },
  to: { address: 'ok@sim.test' },
  subject: 'Tu factura de octubre',
  html: '<p>Hola</p>',
  text: 'Hola',
  metadata: { facturaId: '123' },
};

function smtpError(responseCode: number, text: string): Error & { responseCode: number } {
  return Object.assign(new Error(text), { responseCode });
}

/** Local SMTP server that answers depending on the recipient's local part, like the simulator will. */
async function startServer(overrides: Partial<SMTPServerOptions> = {}) {
  const received: string[] = [];
  const envelopes: Array<{ from: string | false; to: string[] }> = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onRcptTo(address, _session, callback) {
      const local = address.address.split('@')[0];
      if (local === 'unknown') return callback(smtpError(550, '5.1.1 User unknown'));
      if (local === 'full') return callback(smtpError(452, '4.2.2 Mailbox full'));
      if (local === 'slow') return callback(smtpError(450, '4.2.1 Too many messages, slow down'));
      callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const blocked = session.envelope.rcptTo.some((r) => r.address.startsWith('blocked@'));
        if (blocked) return callback(smtpError(554, '5.7.1 Message rejected by policy'));
        received.push(Buffer.concat(chunks).toString('utf8'));
        envelopes.push({
          from: session.envelope.mailFrom && session.envelope.mailFrom.address,
          to: session.envelope.rcptTo.map((r) => r.address),
        });
        callback();
      });
    },
    ...overrides,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.server.address() as AddressInfo;
  servers.push(server);
  return { port, received, envelopes };
}

const servers: SMTPServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function driverFor(port: number, extra: object = {}) {
  return smtp({ host: '127.0.0.1', port, secure: false, ignoreTLS: true, ...extra });
}

describe('smtp driver against a real SMTP server', () => {
  it('sends a message through createRelayo with Relayo ids in the headers', async () => {
    const { port, received } = await startServer();
    const relayo = createRelayo({ email: driverFor(port), generateId: () => 'msg_abc' });

    const result = await relayo.email.send({
      ...message,
      attachments: [{ filename: 'factura.pdf', content: new Uint8Array([1, 2, 3]), contentType: 'application/pdf' }],
    });

    expect(result).toEqual({
      messageId: 'msg_abc',
      providerMessageId: '<msg_abc@empresa.com>',
      provider: 'smtp',
      status: 'sent',
    });
    expect(received).toHaveLength(1);
    const raw = received[0]!;
    expect(raw).toContain('Message-ID: <msg_abc@empresa.com>');
    expect(raw).toContain(`${MESSAGE_ID_HEADER}: msg_abc`);
    expect(raw).toContain(`${METADATA_HEADER}: ${Buffer.from('{"facturaId":"123"}').toString('base64url')}`);
    expect(raw).toContain('Subject: Tu factura de octubre');
    expect(raw).toContain('From: Facturas <facturas@empresa.com>');
    expect(raw).toContain('filename=factura.pdf');
  });

  it('uses bounceAddress as envelope sender and keeps every recipient', async () => {
    const { port, received, envelopes } = await startServer();
    const driver = smtp({ host: '127.0.0.1', port, secure: false, ignoreTLS: true }, { bounceAddress: 'bounces@empresa.com' });

    await driver.send(
      { ...message, to: [{ address: 'ok@sim.test' }], cc: [{ address: 'cc@sim.test' }], bcc: [{ address: 'bcc@sim.test' }] },
      { messageId: 'msg_1' },
    );

    expect(envelopes).toEqual([{ from: 'bounces@empresa.com', to: ['ok@sim.test', 'cc@sim.test', 'bcc@sim.test'] }]);
    expect(received[0]).toContain('From: Facturas <facturas@empresa.com>');
    expect(received[0]).not.toContain('bcc@sim.test');
  });

  it('reports recipients refused while the rest were accepted', async () => {
    const { port, received } = await startServer();
    const result = await driverFor(port).send(
      { ...message, to: [{ address: 'ok@sim.test' }, { address: 'unknown@sim.test' }] },
      { messageId: 'msg_1' },
    );

    expect(result.rejectedRecipients).toEqual(['unknown@sim.test']);
    expect(received).toHaveLength(1);
  });

  it('maps a permanent recipient failure (550 5.1.1) to a non-retryable RejectedError', async () => {
    const { port } = await startServer();
    const error = await driverFor(port)
      .send({ ...message, to: { address: 'unknown@sim.test' } }, { messageId: 'msg_1' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RejectedError);
    expect(error).toMatchObject({
      retryable: false,
      provider: 'smtp',
      raw: { code: 'EENVELOPE', responseCode: 550, enhancedCode: '5.1.1', rejected: ['unknown@sim.test'] },
    });
  });

  it('maps a temporary failure (452 4.2.2) to a retryable ProviderUnavailableError', async () => {
    const { port } = await startServer();
    const error = await driverFor(port)
      .send({ ...message, to: { address: 'full@sim.test' } }, { messageId: 'msg_1' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error).toMatchObject({ retryable: true, raw: { responseCode: 452, enhancedCode: '4.2.2' } });
  });

  it('maps throttling replies to RateLimitError', async () => {
    const { port } = await startServer();
    const error = await driverFor(port)
      .send({ ...message, to: { address: 'slow@sim.test' } }, { messageId: 'msg_1' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ retryable: true });
  });

  it('maps a message refused after DATA (554 5.7.1) to RejectedError', async () => {
    const { port } = await startServer();
    const error = await driverFor(port)
      .send({ ...message, to: { address: 'blocked@sim.test' } }, { messageId: 'msg_1' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RejectedError);
    expect(error).toMatchObject({ raw: { responseCode: 554, enhancedCode: '5.7.1' } });
  });

  it('maps bad credentials to AuthenticationError', async () => {
    const { port } = await startServer({
      authOptional: false,
      allowInsecureAuth: true,
      onAuth(_auth, _session, callback) {
        callback(new Error('Invalid username or password'));
      },
    });
    const driver = driverFor(port, { auth: { user: 'u', pass: 'wrong' } });

    await expect(driver.send(message, { messageId: 'msg_1' })).rejects.toBeInstanceOf(AuthenticationError);
    await expect(driver.verify()).rejects.toMatchObject({ retryable: false, code: 'authentication_error' });
  });

  it('maps a refused connection to a retryable ProviderUnavailableError', async () => {
    const { port } = await startServer();
    await new Promise<void>((r) => servers.pop()!.close(() => r()));

    const error = await driverFor(port, { connectionTimeout: 2000 })
      .send(message, { messageId: 'msg_1' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error).toMatchObject({ retryable: true });
  });

  it('verifies a reachable server', async () => {
    const { port } = await startServer();
    await expect(driverFor(port).verify()).resolves.toBeUndefined();
  });
});

describe('toMailOptions', () => {
  it('maps recipients, reply-to, cc/bcc and custom headers', () => {
    const mail = toMailOptions(
      {
        ...message,
        to: [{ address: 'a@x.com', name: 'A' }, { address: 'b@x.com' }],
        cc: [{ address: 'c@x.com' }],
        bcc: [{ address: 'd@x.com' }],
        replyTo: { address: 'soporte@empresa.com' },
        headers: { 'X-Campaign': 'oct' },
      },
      { messageId: 'msg_1' },
    );

    expect(mail).toMatchObject({
      to: [{ name: 'A', address: 'a@x.com' }, 'b@x.com'],
      cc: ['c@x.com'],
      bcc: ['d@x.com'],
      replyTo: 'soporte@empresa.com',
      headers: { 'X-Campaign': 'oct', [MESSAGE_ID_HEADER]: 'msg_1' },
    });
  });

  it('leaves metadata out of the headers when asked', () => {
    const mail = toMailOptions(message, { messageId: 'msg_1' }, { metadataHeader: false });
    expect(mail.headers).toEqual({ [MESSAGE_ID_HEADER]: 'msg_1' });
  });

  it('lets providerOptions pass through to Nodemailer', () => {
    const mail = toMailOptions({ ...message, providerOptions: { priority: 'high' } }, { messageId: 'msg_1' });
    expect(mail.priority).toBe('high');
  });
});

describe('toRelayoError', () => {
  it.each([
    [{ code: 'EAUTH', responseCode: 535, response: '535 5.7.8 Bad credentials' }, AuthenticationError],
    [{ code: 'ENOAUTH' }, AuthenticationError],
    [{ code: 'ECONNECTION' }, ProviderUnavailableError],
    [{ code: 'ETIMEDOUT' }, ProviderUnavailableError],
    [{ code: 'EDNS' }, ProviderUnavailableError],
    [{ code: 'EENVELOPE', message: 'No recipients defined' }, ValidationError],
    [{ code: 'ECONFIG' }, ValidationError],
    [{ code: 'EMESSAGE', responseCode: 552, response: '552 5.3.4 Message too big' }, RejectedError],
    [{ code: 'EENVELOPE', responseCode: 421, response: '421 4.7.0 Try again later' }, ProviderUnavailableError],
    [{ code: 'EENVELOPE', responseCode: 451, response: '451 4.7.1 Greylisted, please try again later' }, ProviderUnavailableError],
    [{ code: 'EENVELOPE', responseCode: 421, response: '421 4.7.0 Too many connections, try again later' }, RateLimitError],
    [{ code: 'EMESSAGE', responseCode: 451, response: '451 4.3.0 Local error' }, ProviderUnavailableError],
  ] as Array<[{ code: string; responseCode?: number; response?: string; message?: string }, unknown]>)('maps %o', (err, expected) => {
    expect(toRelayoError(Object.assign(new Error(err.message ?? 'x'), err), 'smtp')).toBeInstanceOf(expected);
  });

  it('passes RelayoErrors through untouched', () => {
    const original = new ValidationError('bad');
    expect(toRelayoError(original, 'smtp')).toBe(original);
  });
});
