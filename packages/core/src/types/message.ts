export type Channel = 'email' | 'sms';

export interface Recipient {
  /** Email address, or phone number in E.164 format for SMS (`whatsapp:+34…` for WhatsApp, with drivers that support it). */
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

/**
 * One-click unsubscribe. Relayo turns it into `List-Unsubscribe` / `List-Unsubscribe-Post` headers.
 * The url receives a POST with body `List-Unsubscribe=One-Click` when the recipient unsubscribes.
 */
export interface Unsubscribe {
  /** https url for one-click unsubscribe. Put a token in it that identifies the recipient. */
  url?: string;
  /** Address that receives unsubscribe requests by email. */
  mailto?: string;
  /** Advertise one-click (RFC 8058). Default true when `url` is set. */
  oneClick?: boolean;
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
  unsubscribe?: Unsubscribe;
}

export interface SmsMessage extends BaseMessage {
  from?: string;
  body: string;
}

export type MessageFor<C extends Channel> = C extends 'email' ? EmailMessage : SmsMessage;
