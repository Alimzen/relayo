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

export type SmtpTransport =
  | string
  | SMTPTransportOptions
  | (SMTPPoolOptions & { pool: true })
  | Transporter<any, any>;

export interface SmtpDriverOptions {
  /** Provider name reported in results, events and errors. Defaults to `"smtp"`. */
  name?: string;
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
        info = await transporter.sendMail(toMailOptions(message, context));
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

export function toMailOptions(message: EmailMessage, context: SendContext): SendMailOptions {
  const mail: SendMailOptions = {
    messageId: `<${context.messageId}@${domainOf(message.from.address)}>`,
    from: toAddress(message.from),
    to: toAddresses(Array.isArray(message.to) ? message.to : [message.to]),
    subject: message.subject,
    headers: { ...message.headers, [MESSAGE_ID_HEADER]: context.messageId },
  };
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
