import type { Channel } from './message.js';

export type EventType =
  | 'accepted'
  | 'delivered'
  | 'deferred'
  | 'bounced'
  | 'complained'
  | 'rejected'
  | 'opened'
  | 'clicked'
  | 'unsubscribed'
  | 'failed';

export interface RelayoEvent {
  id: string;
  type: EventType;
  channel: Channel;
  provider: string;
  /** Relayo's message id, as returned in `SendResult.messageId`. */
  messageId: string;
  providerMessageId?: string;
  recipient: string;
  timestamp: Date;
  metadata?: Record<string, string>;
  /** Original provider payload, always present. */
  raw: unknown;
}

/**
 * `hard`: permanent recipient failure → mark the contact invalid.
 * `soft`: retries exhausted on a temporary failure → retry later or alert.
 * `block`: rejected by policy or reputation → check your own sending setup, not the contact.
 */
export type BounceType = 'hard' | 'soft' | 'block';

export type BounceReason =
  | 'user_unknown'
  | 'domain_invalid'
  | 'mailbox_full'
  | 'mailbox_disabled'
  | 'message_too_large'
  | 'content_rejected'
  | 'policy_block'
  | 'auth_failure'
  | 'reputation_block'
  | 'rate_limited'
  | 'temporary_failure'
  | 'unknown';

export interface BounceEvent extends RelayoEvent {
  type: 'bounced';
  bounceType: BounceType;
  reason: BounceReason;
  smtpCode?: number;
  enhancedCode?: string;
  diagnostic?: string;
}

export type RejectReason = 'suppressed' | 'invalid_recipient' | 'content_rejected' | 'unknown';

/** The provider did not even attempt delivery. Don't retry. */
export interface RejectEvent extends RelayoEvent {
  type: 'rejected';
  reason: RejectReason;
  diagnostic?: string;
}

export interface ClickEvent extends RelayoEvent {
  type: 'clicked';
  url?: string;
}

export type EventOf<T extends EventType> = T extends 'bounced'
  ? BounceEvent
  : T extends 'rejected'
    ? RejectEvent
    : T extends 'clicked'
      ? ClickEvent
      : RelayoEvent & { type: T };
