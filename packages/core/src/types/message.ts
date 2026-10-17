export type Channel = 'email' | 'sms';

export interface Recipient {
  /** Email address, or phone number in E.164 format for SMS. */
  address: string;
  name?: string;
}

export interface Attachment {
  filename: string;
  content: string | Uint8Array;
  contentType?: string;
  /** Content-ID for inline images referenced from the HTML body. */
  cid?: string;
}

export interface BaseMessage {
  to: Recipient | Recipient[];
  /** Travels to every event emitted for this message. */
  metadata?: Record<string, string>;
  tags?: string[];
  idempotencyKey?: string;
  /** Escape hatch for provider-specific options; ignored by drivers that don't recognize them. */
  providerOptions?: Record<string, unknown>;
}

export interface EmailMessage extends BaseMessage {
  from: Recipient;
  replyTo?: Recipient;
  cc?: Recipient[];
  bcc?: Recipient[];
  subject: string;
  html?: string;
  text?: string;
  attachments?: Attachment[];
  headers?: Record<string, string>;
}

export interface SmsMessage extends BaseMessage {
  from?: string;
  body: string;
}

export type MessageFor<C extends Channel> = C extends 'email' ? EmailMessage : SmsMessage;
