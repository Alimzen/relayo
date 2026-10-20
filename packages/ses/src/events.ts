import {
  classifyBounce,
  type BounceEvent,
  type ClickEvent,
  type EventType,
  type RejectEvent,
  type RelayoEvent,
} from '@alimzen/relayo';

/** Header and tag the driver sets on every message so events can be mapped back. */
export const MESSAGE_ID_HEADER = 'X-Relayo-Message-ID';
export const METADATA_HEADER = 'X-Relayo-Metadata';
export const MESSAGE_ID_TAG = 'relayo_message_id';

interface SesRecipient {
  emailAddress: string;
  action?: string;
  status?: string;
  diagnosticCode?: string;
}

/** SES event (event publishing) or notification (identity feedback). Only the fields we read. */
export interface SesEvent {
  eventType?: string;
  notificationType?: string;
  mail: {
    messageId: string;
    timestamp: string;
    destination: string[];
    headers?: Array<{ name: string; value: string }>;
    tags?: Record<string, string[]>;
  };
  bounce?: {
    bounceType: 'Permanent' | 'Transient' | 'Undetermined';
    bounceSubType: string;
    bouncedRecipients: SesRecipient[];
    timestamp: string;
    feedbackId: string;
  };
  complaint?: {
    complainedRecipients: SesRecipient[];
    timestamp: string;
    feedbackId: string;
    complaintSubType?: string | null;
    complaintFeedbackType?: string;
  };
  delivery?: { timestamp: string; recipients: string[]; smtpResponse?: string };
  deliveryDelay?: { timestamp: string; delayType?: string; delayedRecipients: SesRecipient[] };
  reject?: { reason?: string };
  open?: { timestamp: string };
  click?: { timestamp: string; link?: string };
  failure?: { errorMessage?: string };
  subscription?: { timestamp: string; newTopicPreferences?: { unsubscribeAll?: boolean } };
}

export interface ParseContext {
  provider: string;
  /** Stable id of the delivery (SNS MessageId), used to build idempotent event ids. */
  deliveryId?: string;
}

const SMTP_CODE = /\b([245]\d\d)\b/;
const SUPPRESSED = new Set(['Suppressed', 'OnAccountSuppressionList']);

/** Converts one SES event into Relayo events (one per affected recipient). */
export function parseSesEvent(event: SesEvent, ctx: ParseContext): RelayoEvent[] {
  const type = event.eventType ?? event.notificationType;
  const { mail } = event;
  const base = baseFields(event, ctx.provider);
  let index = 0;
  const make = <E extends RelayoEvent>(
    eventType: EventType,
    recipient: string,
    timestamp: string | undefined,
    extra?: Omit<E, keyof RelayoEvent>,
  ): E => {
    const id = ctx.deliveryId
      ? `${ctx.deliveryId}:${index++}`
      : `${mail.messageId}:${type}:${recipient}:${timestamp ?? mail.timestamp}`;
    return {
      ...base,
      id,
      type: eventType,
      recipient,
      timestamp: new Date(timestamp ?? mail.timestamp),
      ...extra,
    } as E;
  };
  const destinations = mail.destination ?? [];

  switch (type) {
    case 'Send':
      return destinations.map((r) => make('accepted', r, mail.timestamp));

    case 'Delivery':
      return (event.delivery?.recipients ?? destinations).map((r) => make('delivered', r, event.delivery?.timestamp));

    case 'DeliveryDelay':
      return (event.deliveryDelay?.delayedRecipients ?? []).map((r) =>
        make('deferred', r.emailAddress, event.deliveryDelay?.timestamp),
      );

    case 'Reject':
      return destinations.map((r) =>
        make<RejectEvent>('rejected', r, mail.timestamp, {
          reason: 'content_rejected',
          ...(event.reject?.reason && { diagnostic: event.reject.reason }),
        }),
      );

    case 'Bounce': {
      const bounce = event.bounce!;
      return bounce.bouncedRecipients.map((r) => {
        if (SUPPRESSED.has(bounce.bounceSubType)) {
          return make<RejectEvent>('rejected', r.emailAddress, bounce.timestamp, {
            reason: 'suppressed',
            ...(r.diagnosticCode && { diagnostic: r.diagnosticCode }),
          });
        }
        return make<BounceEvent>('bounced', r.emailAddress, bounce.timestamp, bounceFields(bounce, r));
      });
    }

    case 'Complaint': {
      const complaint = event.complaint!;
      // SES reports sends to addresses suppressed for past complaints as complaints too.
      if (complaint.complaintSubType && SUPPRESSED.has(complaint.complaintSubType)) {
        return complaint.complainedRecipients.map((r) =>
          make<RejectEvent>('rejected', r.emailAddress, complaint.timestamp, { reason: 'suppressed' }),
        );
      }
      return complaint.complainedRecipients.map((r) => make('complained', r.emailAddress, complaint.timestamp));
    }

    case 'Open':
      return destinations.slice(0, 1).map((r) => make('opened', r, event.open?.timestamp));

    case 'Click':
      return destinations.slice(0, 1).map((r) =>
        make<ClickEvent>('clicked', r, event.click?.timestamp, {
          ...(event.click?.link && { url: event.click.link }),
        }),
      );

    case 'Rendering Failure':
      return destinations.map((r) => make('failed', r, mail.timestamp));

    case 'Subscription':
      if (!event.subscription?.newTopicPreferences?.unsubscribeAll) return [];
      return destinations.slice(0, 1).map((r) => make('unsubscribed', r, event.subscription?.timestamp));

    default:
      return [];
  }
}

function bounceFields(
  bounce: NonNullable<SesEvent['bounce']>,
  recipient: SesRecipient,
): Omit<BounceEvent, keyof RelayoEvent> {
  const diagnostic = recipient.diagnosticCode;
  const smtpCode = diagnostic ? Number(SMTP_CODE.exec(diagnostic)?.[1] ?? 0) || undefined : undefined;
  let { bounceType, reason } = classifyBounce({
    ...(recipient.status && { enhancedCode: recipient.status }),
    ...(diagnostic && { diagnostic }),
    ...(smtpCode && { smtpCode }),
  });

  // SES's subtype is more specific than a missing or generic SMTP status.
  if (reason === 'unknown' || reason === 'temporary_failure') {
    switch (bounce.bounceSubType) {
      case 'NoEmail':
        reason = 'user_unknown';
        bounceType = 'hard';
        break;
      case 'MailboxFull':
        reason = 'mailbox_full';
        bounceType = 'soft';
        break;
      case 'MessageTooLarge':
        reason = 'message_too_large';
        bounceType = 'block';
        break;
      case 'ContentRejected':
      case 'AttachmentRejected':
        reason = 'content_rejected';
        bounceType = 'block';
        break;
    }
  }
  // SES gave up on a temporary failure: never invalidate the contact for it.
  if (bounce.bounceType === 'Transient' && bounceType === 'hard') bounceType = 'soft';

  return {
    bounceType,
    reason,
    ...(smtpCode && { smtpCode }),
    ...(recipient.status && { enhancedCode: recipient.status }),
    ...(diagnostic && { diagnostic }),
  };
}

function baseFields(event: SesEvent, provider: string) {
  const { mail } = event;
  const header = (name: string) =>
    mail.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
  const messageId = mail.tags?.[MESSAGE_ID_TAG]?.[0] ?? header(MESSAGE_ID_HEADER) ?? mail.messageId;
  const metadata = decodeMetadata(header(METADATA_HEADER));

  return {
    channel: 'email' as const,
    provider,
    messageId,
    providerMessageId: mail.messageId,
    ...(metadata && { metadata }),
    raw: event,
  };
}

export function encodeMetadata(metadata: Record<string, string>): string {
  return Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url');
}

function decodeMetadata(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}
