import {
  classifyBounce,
  type BounceClassification,
  type BounceEvent,
  type ClickEvent,
  type EventType,
  type RejectEvent,
  type RejectReason,
  type RelayoEvent,
} from '@relayo/core';

/** custom_args the driver sets on every message; SendGrid echoes them on each event. */
export const MESSAGE_ID_ARG = 'relayo_message_id';
export const METADATA_ARG = 'relayo_metadata';

/** One item of the SendGrid Event Webhook payload. Only the fields we read. */
export interface SendGridEvent {
  event: string;
  email: string;
  timestamp: number;
  sg_event_id?: string;
  sg_message_id?: string;
  'smtp-id'?: string;
  /** Bounce: "bounce" or "blocked". */
  type?: string;
  bounce_classification?: string;
  reason?: string;
  status?: string;
  response?: string;
  url?: string;
  [MESSAGE_ID_ARG]?: string;
  [METADATA_ARG]?: string;
  [key: string]: unknown;
}

const SMTP_CODE = /\b([245]\d\d)\b/;
const SENDER_SIDE_CLASSIFICATION: Record<string, BounceClassification['reason']> = {
  Content: 'content_rejected',
  Reputation: 'reputation_block',
  'Frequency or Volume': 'rate_limited',
};

/** Converts one SendGrid webhook event into a Relayo event, or nothing for events Relayo doesn't model. */
export function parseSendGridEvent(event: SendGridEvent, provider: string): RelayoEvent | undefined {
  const type = TYPES[event.event];
  if (!type) return undefined;

  const providerMessageId = event.sg_message_id?.split(/\.(?:filter|recvd)/)[0];
  const metadata = decodeMetadata(event[METADATA_ARG]);
  const base: RelayoEvent = {
    id: event.sg_event_id ?? `${event.sg_message_id ?? event.email}:${event.event}:${event.timestamp}`,
    type,
    channel: 'email',
    provider,
    messageId: event[MESSAGE_ID_ARG] ?? providerMessageId ?? '',
    recipient: event.email,
    timestamp: new Date(event.timestamp * 1000),
    raw: event,
  };
  if (providerMessageId) base.providerMessageId = providerMessageId;
  if (metadata) base.metadata = metadata;

  switch (type) {
    case 'bounced':
      return { ...base, ...bounceFields(event) } as BounceEvent;
    case 'rejected':
      return {
        ...base,
        reason: dropReason(event.reason),
        ...(event.reason && { diagnostic: event.reason }),
      } as RejectEvent;
    case 'clicked':
      return { ...base, ...(event.url && { url: event.url }) } as ClickEvent;
    default:
      return base;
  }
}

const TYPES: Record<string, EventType> = {
  processed: 'accepted',
  delivered: 'delivered',
  deferred: 'deferred',
  bounce: 'bounced',
  dropped: 'rejected',
  spamreport: 'complained',
  open: 'opened',
  click: 'clicked',
  unsubscribe: 'unsubscribed',
  group_unsubscribe: 'unsubscribed',
};

function bounceFields(event: SendGridEvent): Omit<BounceEvent, keyof RelayoEvent> {
  const diagnostic = event.reason;
  const smtpCode = diagnostic ? Number(SMTP_CODE.exec(diagnostic)?.[1] ?? 0) || undefined : undefined;
  let { bounceType, reason } = classifyBounce({
    ...(event.status && { enhancedCode: event.status }),
    ...(diagnostic && { diagnostic }),
    ...(smtpCode && { smtpCode }),
  });

  const classification = event.bounce_classification;
  const senderSide = classification ? SENDER_SIDE_CLASSIFICATION[classification] : undefined;
  if (senderSide && bounceType !== 'block') {
    // SendGrid looked at the whole response and blames the sender; trust it over a bare 5xx.
    bounceType = 'block';
    reason = senderSide;
  } else if (reason === 'unknown' || reason === 'temporary_failure') {
    if (classification === 'Invalid Address') [bounceType, reason] = ['hard', 'user_unknown'];
    else if (classification === 'Mailbox Unavailable') reason = 'mailbox_disabled';
    else if (classification === 'Technical') [bounceType, reason] = ['soft', 'temporary_failure'];
  }
  // "blocked" means the receiver refused the sender, not the address: never invalidate the contact.
  if (event.type === 'blocked' && bounceType === 'hard') {
    bounceType = 'block';
    reason = reason === 'unknown' || reason === 'user_unknown' ? 'policy_block' : reason;
  }

  return {
    bounceType,
    reason,
    ...(smtpCode && { smtpCode }),
    ...(event.status && { enhancedCode: event.status }),
    ...(diagnostic && { diagnostic }),
  };
}

function dropReason(reason: string | undefined): RejectReason {
  if (!reason) return 'unknown';
  if (/bounced|unsubscribed|spam report|suppress/i.test(reason)) return 'suppressed';
  if (/invalid/i.test(reason)) return 'invalid_recipient';
  return 'unknown';
}

function decodeMetadata(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}
