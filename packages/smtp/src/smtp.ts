import type { Driver, EmailMessage, Recipient, SendContext, SendResult } from '@alimzen/core';
import nodemailer, {
  type Address,
  type Attachment,
  type SendMailOptions,
  type SMTPPoolOptions,
  type SMTPTransportOptions,
  type Transporter,
} from 'nodemailer';
import { toRelayoError } from './errors.js';

/** Header carrying Relayo's message id, so bounces and other replies can be mapped back. */
export const MESSAGE_ID_HEADER = 'X-Relayo-Message-ID';
/** Header carrying `metadata` (base64url JSON), so it comes back in bounce reports. */
export const METADATA_HEADER = 'X-Relayo-Metadata';

export type SmtpTransport =
  | string
  | SMTPTransportOptions
  | (SMTPPoolOptions & { pool: true })
  | Transporter<any, any>;

export interface SmtpDriverOptions {
  /** Provider name reported in results, events and errors. Defaults to `"smtp"`. */
  name?: string;
  /**
   * Send `metadata` in the `X-Relayo-Metadata` header, so bounce reports quoting the original headers
   * bring it back (see `@alimzen/bounces`). Recipients can see headers: turn it off for sensitive
   * metadata. Default true.
   */
  metadataHeader?: boolean;
  /**
   * Envelope sender (`MAIL FROM`, the Return-Path) for every message: where receiving servers send bounce
   * reports. Defaults to the `from` address. Point it at a mailbox you read with `@alimzen/bounces`.
   */
  bounceAddress?: string;
}

export interface SmtpDriver extends Driver<EmailMessage> {
  /** Checks the connection and credentials against the server. Throws a `RelayoError` on failure. */
  verify(): Promise<void>;
  /** Closes pooled connections. */
  close(): void;
}

/**
 * SMTP driver built on Nodemailer.
 *
 * @param transport Connection URL (`smtps://user:pass@smtp.example.com`), Nodemailer SMTP or pool
 *   options, or an existing Nodemailer transporter.
 *
 * `providerOptions` on a message are merged into Nodemailer's mail options (e.g. `priority`, `dsn`, `list`).
 * SMTP has no delivery webhooks: what the server refuses during the session surfaces as an error or as
 * `rejectedRecipients`; later bounces arrive as DSN emails to the envelope sender.
 */
export function smtp(transport: SmtpTransport, options: SmtpDriverOptions = {}): SmtpDriver {
  const name = options.name ?? 'smtp';
  const transporter = isTransporter(transport) ? transport : nodemailer.createTransport(transport);

  return {
    name,
    channel: 'email',
    capabilities: {
      batch: false,
      attachments: true,
      scheduling: false,
      tracking: false,
      webhooks: false,
    },

    async send(message, context) {
      let info: { messageId?: string; rejected?: string[] | undefined };
      try {
        info = await transporter.sendMail(toMailOptions(message, context, options));
      } catch (error) {
        throw toRelayoError(error, name);
      }
      const result: SendResult = { messageId: context.messageId, provider: name, status: 'sent' };
      if (info.messageId) result.providerMessageId = info.messageId;
      if (info.rejected?.length) result.rejectedRecipients = info.rejected;
      return result;
    },

    async verify() {
      try {
        await transporter.verify();
      } catch (error) {
        throw toRelayoError(error, name);
      }
    },

    close() {
      transporter.close();
    },
  };
}

export function toMailOptions(
  message: EmailMessage,
  context: SendContext,
  options: Pick<SmtpDriverOptions, 'metadataHeader' | 'bounceAddress'> = {},
): SendMailOptions {
  const headers: Record<string, string> = { ...message.headers, [MESSAGE_ID_HEADER]: context.messageId };
  if (message.metadata && options.metadataHeader !== false) {
    headers[METADATA_HEADER] = Buffer.from(JSON.stringify(message.metadata), 'utf8').toString('base64url');
  }
  const to = Array.isArray(message.to) ? message.to : [message.to];
  const mail: SendMailOptions = {
    messageId: `<${context.messageId}@${domainOf(message.from.address)}>`,
    from: toAddress(message.from),
    to: toAddresses(to),
    subject: message.subject,
    headers,
  };
  if (options.bounceAddress) {
    // Nodemailer replaces the whole envelope, so the recipients have to be listed again.
    const recipients = [...to, ...(message.cc ?? []), ...(message.bcc ?? [])].map((r) => r.address);
    mail.envelope = { from: options.bounceAddress, to: recipients };
  }
  if (message.cc) mail.cc = toAddresses(message.cc);
  if (message.bcc) mail.bcc = toAddresses(message.bcc);
  if (message.replyTo) mail.replyTo = toAddress(message.replyTo);
  if (message.html !== undefined) mail.html = message.html;
  if (message.text !== undefined) mail.text = message.text;
  if (message.attachments) {
    mail.attachments = message.attachments.map((a) => {
      const attachment: Attachment = {
        filename: a.filename,
        content: typeof a.content === 'string' ? a.content : Buffer.from(a.content),
      };
      if (a.contentType) attachment.contentType = a.contentType;
      if (a.cid) attachment.cid = a.cid;
      return attachment;
    });
  }
  return { ...mail, ...(message.providerOptions as SendMailOptions | undefined) };
}

function toAddress(recipient: Recipient): Address | string {
  return recipient.name ? { name: recipient.name, address: recipient.address } : recipient.address;
}

function toAddresses(recipients: Recipient[]): Array<Address | string> {
  return recipients.map(toAddress);
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1) || 'relayo.local';
}

function isTransporter(value: SmtpTransport): value is Transporter<any, any> {
  return typeof value === 'object' && typeof (value as Transporter).sendMail === 'function';
}
