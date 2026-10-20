import { createHash } from 'node:crypto';
import {
  classifyBounce,
  type BounceEvent,
  type EventType,
  type RelayoEvent,
} from '@alimzen/relayo';
import { findPart, parseHeaderBlock, parseMessage, type Headers, type MimePart } from './mime.js';

/** What kind of email was parsed. Only `dsn`, `arf` and `non-standard` produce events. */
export type BounceEmailKind = 'dsn' | 'arf' | 'non-standard' | 'auto-reply' | 'unrecognized';

export interface BounceEmailResult {
  kind: BounceEmailKind;
  events: RelayoEvent[];
}

export interface ParseBounceOptions {
  /** Provider name put on the events. Use the name of the driver that sent the message. Default `"smtp"`. */
  provider?: string;
}

const MESSAGE_ID_HEADER = 'x-relayo-message-id';
const METADATA_HEADER = 'x-relayo-metadata';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SMTP_CODE = /\b([245]\d\d)\b/;
const STATUS_CODE = /\b([245]\.\d{1,3}\.\d{1,3})\b/;
const COMPLAINT_TYPES = new Set(['abuse', 'fraud', 'virus', 'other']);
const BOUNCE_SENDER = /mailer-daemon|postmaster|mail delivery (subsystem|system)/i;
const BOUNCE_SUBJECT = /undeliver|delivery (status notification|failure|has failed)|returned mail|failure notice|mail delivery failed|non.?delivery/i;

/**
 * Turns an email received at your bounce address into Relayo events: delivery status notifications
 * (RFC 3464, including delays and success reports), spam complaints from feedback loops (ARF, RFC 5965)
 * and the most common non-standard bounces (those with `X-Failed-Recipients`). Out-of-office and other
 * auto-replies are recognized and ignored.
 *
 * Events are matched to the original send through the headers the report quotes back: Relayo's
 * `X-Relayo-Message-ID` (and `X-Relayo-Metadata`), or the `Message-ID` the SMTP driver sets.
 * Pass each event to `relayo.emit()` to run your handlers.
 */
export function parseBounceEmail(raw: string | Uint8Array, options: ParseBounceOptions = {}): BounceEmailResult {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('latin1');
  const root = parseMessage(text);
  const ctx: Context = {
    provider: options.provider ?? 'smtp',
    reportId: root.headers.get('message-id') ?? sha256(text),
    reportDate: parseDate(root.headers.get('date')),
    original: originalMessage(root),
    raw: text,
  };

  const report = findPart(root, (p) => p.contentType === 'multipart/report');
  const reportType = report?.params['report-type']?.toLowerCase();

  if (reportType === 'feedback-report') {
    const feedback = findPart(root, (p) => p.contentType === 'message/feedback-report');
    if (feedback) return { kind: 'arf', events: parseArf(feedback, ctx) };
  }
  const status = findPart(
    root,
    (p) => p.contentType === 'message/delivery-status' || p.contentType === 'message/global-delivery-status',
  );
  if (status) return { kind: 'dsn', events: parseDsn(status, ctx) };

  if (isAutoReply(root.headers)) return { kind: 'auto-reply', events: [] };

  const nonStandard = parseNonStandard(root, ctx);
  if (nonStandard.length) return { kind: 'non-standard', events: nonStandard };
  return { kind: 'unrecognized', events: [] };
}

interface Context {
  provider: string;
  reportId: string;
  reportDate: Date | undefined;
  original: OriginalMessage;
  raw: string;
}

interface OriginalMessage {
  messageId?: string;
  relayoId?: string;
  metadata?: Record<string, string>;
  to?: string;
}

function parseDsn(part: MimePart, ctx: Context): RelayoEvent[] {
  const [perMessage, ...perRecipient] = part.body
    .split(/\n[ \t]*\n/)
    .map((block) => parseHeaderBlock(block.trim()))
    .filter((h) => h.get('reporting-mta') || h.get('final-recipient') || h.get('original-recipient') || h.get('action'));
  const groups = perMessage && !perMessage.get('action') ? perRecipient : [perMessage, ...perRecipient];

  const events: RelayoEvent[] = [];
  for (const fields of groups) {
    if (!fields) continue;
    const recipient = address(fields.get('final-recipient') ?? fields.get('original-recipient'));
    const action = fields.get('action')?.toLowerCase();
    if (!recipient || !action) continue;

    const timestamp = parseDate(fields.get('last-attempt-date')) ?? parseDate(perMessage?.get('arrival-date')) ?? ctx.reportDate;
    const raw = { fields: toRecord(fields), message: ctx.raw };

    if (action === 'failed') {
      const enhancedCode = STATUS_CODE.exec(fields.get('status') ?? '')?.[1];
      const diagnostic = stripType(fields.get('diagnostic-code'));
      const smtpCode = Number(SMTP_CODE.exec(diagnostic ?? '')?.[1] ?? 0) || undefined;
      const { bounceType, reason } = classifyBounce({
        ...(enhancedCode && { enhancedCode }),
        ...(diagnostic && { diagnostic }),
        ...(smtpCode && { smtpCode }),
      });
      const event: BounceEvent = {
        ...base('bounced', recipient, action, timestamp, raw, ctx),
        type: 'bounced',
        bounceType,
        reason,
      };
      if (smtpCode) event.smtpCode = smtpCode;
      if (enhancedCode) event.enhancedCode = enhancedCode;
      if (diagnostic) event.diagnostic = diagnostic;
      events.push(event);
    } else if (action === 'delayed') {
      events.push(base('deferred', recipient, action, timestamp, raw, ctx));
    } else if (action === 'delivered' || action === 'relayed' || action === 'expanded') {
      events.push(base('delivered', recipient, action, timestamp, raw, ctx));
    }
  }
  return events;
}

function parseArf(part: MimePart, ctx: Context): RelayoEvent[] {
  const fields = parseHeaderBlock(part.body.trim());
  const feedbackType = fields.get('feedback-type')?.toLowerCase();
  // not-spam and auth-failure reports are not complaints about the recipient's mail.
  if (!feedbackType || !COMPLAINT_TYPES.has(feedbackType)) return [];

  // Many feedback loops redact the recipient; the message id and metadata still identify the send.
  const recipients = fields.getAll('original-rcpt-to').map((r) => address(r) ?? r);
  if (!recipients.length) recipients.push(ctx.original.to ?? '');
  const timestamp = parseDate(fields.get('arrival-date') ?? fields.get('received-date')) ?? ctx.reportDate;
  const raw = { fields: toRecord(fields), message: ctx.raw };
  return recipients.map((recipient) => base('complained', recipient, feedbackType, timestamp, raw, ctx));
}

function parseNonStandard(root: MimePart, ctx: Context): RelayoEvent[] {
  const from = root.headers.get('from') ?? '';
  const subject = root.headers.get('subject') ?? '';
  const failed = root.headers.getAll('x-failed-recipients').flatMap((v) => v.split(',')).map((r) => r.trim()).filter(Boolean);
  if (!failed.length || !(BOUNCE_SENDER.test(from) || BOUNCE_SUBJECT.test(subject))) return [];

  const text = findPart(root, (p) => p.contentType === 'text/plain')?.body ?? '';
  const diagnostic = text.split('\n').map((l) => l.trim()).find((l) => STATUS_CODE.test(l) || /^[45]\d\d[ -]/.test(l));
  const enhancedCode = STATUS_CODE.exec(diagnostic ?? '')?.[1];
  const smtpCode = Number(SMTP_CODE.exec(diagnostic ?? '')?.[1] ?? 0) || undefined;
  const { bounceType, reason } = classifyBounce({
    ...(diagnostic && { diagnostic }),
    ...(enhancedCode && { enhancedCode }),
    ...(smtpCode && { smtpCode }),
  });
  const raw = { fields: { 'x-failed-recipients': failed.join(', ') }, message: ctx.raw };

  return failed.map((recipient) => {
    const event: BounceEvent = {
      ...base('bounced', recipient, 'failed', ctx.reportDate, raw, ctx),
      type: 'bounced',
      bounceType,
      reason,
    };
    if (smtpCode) event.smtpCode = smtpCode;
    if (enhancedCode) event.enhancedCode = enhancedCode;
    if (diagnostic) event.diagnostic = diagnostic;
    return event;
  });
}

function base(
  type: EventType,
  recipient: string,
  action: string,
  timestamp: Date | undefined,
  raw: unknown,
  ctx: Context,
): RelayoEvent {
  const { original } = ctx;
  const event: RelayoEvent = {
    // Stable for the same report, so processing a mailbox twice yields the same ids.
    id: sha256(`${ctx.reportId}|${recipient.toLowerCase()}|${action}`).slice(0, 32),
    type,
    channel: 'email',
    provider: ctx.provider,
    messageId: original.relayoId ?? original.messageId ?? '',
    recipient,
    timestamp: timestamp ?? new Date(),
    raw,
  };
  if (original.messageId) event.providerMessageId = original.messageId;
  if (original.metadata) event.metadata = original.metadata;
  return event;
}

/** Headers of the message the report is about, from `message/rfc822` or `text/rfc822-headers`. */
function originalMessage(root: MimePart): OriginalMessage {
  const attached = findPart(root, (p) => p.contentType === 'message/rfc822' || p.contentType === 'message/global');
  const headersOnly = findPart(root, (p) => p.contentType === 'text/rfc822-headers' || p.contentType === 'message/global-headers');
  const headers: Headers | undefined = attached?.parts[0]?.headers ?? (headersOnly ? parseHeaderBlock(headersOnly.body.trim()) : undefined);
  if (!headers) return {};

  const original: OriginalMessage = {};
  const messageId = headers.get('message-id');
  if (messageId) original.messageId = messageId;
  const relayoId = headers.get(MESSAGE_ID_HEADER) ?? relayoIdFromMessageId(messageId);
  if (relayoId) original.relayoId = relayoId;
  const metadata = decodeMetadata(headers.get(METADATA_HEADER));
  if (metadata) original.metadata = metadata;
  const to = address(headers.get('to'));
  if (to) original.to = to;
  return original;
}

/** The SMTP driver sends `Message-ID: <relayo-id@domain>`. */
function relayoIdFromMessageId(messageId: string | undefined): string | undefined {
  const local = /^<?([^@>]+)@/.exec(messageId ?? '')?.[1];
  return local && UUID.test(local) ? local : undefined;
}

function isAutoReply(headers: Headers): boolean {
  if (BOUNCE_SENDER.test(headers.get('from') ?? '')) return false;
  const autoSubmitted = headers.get('auto-submitted')?.toLowerCase();
  return (
    (autoSubmitted !== undefined && autoSubmitted !== 'no') ||
    headers.get('x-autoreply') !== undefined ||
    headers.get('x-autorespond') !== undefined ||
    /auto[_-]?reply/i.test(headers.get('precedence') ?? '')
  );
}

/** `rfc822; user@example.com` or `Name <user@example.com>` → `user@example.com`. */
function address(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const typed = value.includes(';') ? value.slice(value.indexOf(';') + 1) : value;
  const angle = /<([^>]+)>/.exec(typed)?.[1];
  const result = (angle ?? typed).trim();
  return result.includes('@') ? result : undefined;
}

/** `smtp; 550 5.1.1 ...` → `550 5.1.1 ...`. */
function stripType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^[a-z-]+;\s*/i.test(value) ? value.replace(/^[a-z-]+;\s*/i, '') : value;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value.replace(/\s*\([^)]*\)\s*$/, ''));
  return Number.isNaN(date.getTime()) ? undefined : date;
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

function toRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  for (const name of DSN_FIELDS) {
    const value = headers.get(name);
    if (value !== undefined) record[name] = value;
  }
  return record;
}

const DSN_FIELDS = [
  'final-recipient', 'original-recipient', 'action', 'status', 'diagnostic-code', 'remote-mta',
  'last-attempt-date', 'will-retry-until', 'feedback-type', 'user-agent', 'version', 'original-mail-from',
  'original-rcpt-to', 'arrival-date', 'reported-domain', 'source-ip',
];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
