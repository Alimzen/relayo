import type { BounceReason, BounceType } from './types/events.js';

export interface BounceInput {
  /** Basic SMTP reply code, e.g. 550. */
  smtpCode?: number;
  /** Enhanced status code (RFC 3463), e.g. "5.1.1". */
  enhancedCode?: string;
  /** Diagnostic text from the receiving server. */
  diagnostic?: string;
}

export interface BounceClassification {
  bounceType: BounceType;
  reason: BounceReason;
}

const ENHANCED_CODE = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;
const SMTP_CODE = /\b([245]\d\d)\b/;

// Checked in order; the first match wins. Sender-side causes go first so that a "550 user unknown"
// worded by a blocklist provider is not taken for a bad address.
const TEXT_RULES: Array<[RegExp, BounceReason]> = [
  [/spf|dkim|dmarc|not authenticated|authentication (failed|required)|unauthenticated/i, 'auth_failure'],
  [/spamhaus|blacklist|blocklist|block ?list|black ?list|reputation|listed (at|on|in)|rbl|dnsbl|barracuda/i, 'reputation_block'],
  [/rate limit|too many (messages|connections|emails)|throttl|unusual rate|try again later/i, 'rate_limited'],
  [/too (large|big)|size (limit|exceeded)|exceeds .*size/i, 'message_too_large'],
  [/spam|content (rejected|refused)|virus|malware|phish/i, 'content_rejected'],
  [/quota|mailbox (is )?full|over ?quota|insufficient (storage|space)/i, 'mailbox_full'],
  [/disabled|inactive|suspended|deactivated|account (has been )?closed/i, 'mailbox_disabled'],
  [/no mx|null mx|domain( name)? (not found|does not exist)|host (not found|unknown)|name service error|unrouteable|no such domain|nxdomain/i, 'domain_invalid'],
  [/user unknown|unknown user|no such (user|recipient|mailbox)|does ?n[o']t exist|invalid (recipient|mailbox|address)|recipient (address )?rejected|address rejected|mailbox unavailable|not found/i, 'user_unknown'],
  [/polic(y|ies)|blocked|denied|refused|prohibited/i, 'policy_block'],
];

const SENDER_SIDE: ReadonlySet<BounceReason> = new Set<BounceReason>([
  'auth_failure',
  'reputation_block',
  'rate_limited',
  'message_too_large',
  'content_rejected',
  'policy_block',
]);

function reasonFromEnhanced(subject: number, detail: number, permanent: boolean): BounceReason | undefined {
  switch (subject) {
    case 1:
      if (detail === 1 || detail === 3) return 'user_unknown';
      if (detail === 2 || detail === 10) return 'domain_invalid';
      if (detail === 6) return 'mailbox_disabled';
      return undefined;
    case 2:
      if (detail === 1) return 'mailbox_disabled';
      if (detail === 2) return 'mailbox_full';
      if (detail === 3) return 'message_too_large';
      return undefined;
    case 3:
      return detail === 4 ? 'message_too_large' : permanent ? undefined : 'temporary_failure';
    case 4:
      return detail === 4 && permanent ? 'domain_invalid' : permanent ? undefined : 'temporary_failure';
    case 6:
      return 'content_rejected';
    case 7:
      if (detail >= 20 && detail <= 27) return 'auth_failure';
      if (detail === 28) return 'rate_limited';
      return 'policy_block';
    default:
      return undefined;
  }
}

function typeFor(reason: BounceReason, permanent: boolean): BounceType {
  if (SENDER_SIDE.has(reason)) return 'block';
  if (reason === 'mailbox_full' || reason === 'temporary_failure') return 'soft';
  return permanent ? 'hard' : 'soft';
}

/**
 * Classifies a bounce from whatever the provider reports. Sender-side problems (policy, reputation,
 * authentication, content, size, rate) are `block` so the app does not invalidate good contacts.
 * Mailbox-full is always `soft`. Unknown permanent failures are `hard` with reason `unknown`.
 */
export function classifyBounce(input: BounceInput): BounceClassification {
  const diagnostic = input.diagnostic ?? '';
  const enhanced = ENHANCED_CODE.exec(input.enhancedCode ?? '') ?? ENHANCED_CODE.exec(diagnostic);
  const smtpCode = input.smtpCode ?? Number(SMTP_CODE.exec(diagnostic)?.[1] ?? 0);
  const permanent = enhanced ? enhanced[1] === '5' : smtpCode >= 500 || smtpCode === 0;

  // Text first for 5.7.x and unknown codes: "5.7.1" alone can mean a policy, a blocklist or SPF.
  const fromText = TEXT_RULES.find(([re]) => re.test(diagnostic))?.[1];
  const fromCode = enhanced
    ? reasonFromEnhanced(Number(enhanced[2]), Number(enhanced[3]), permanent)
    : undefined;

  let reason: BounceReason;
  if (fromCode === 'policy_block' && fromText && SENDER_SIDE.has(fromText)) reason = fromText;
  // RFC 7505 reserves X.1.10 for null MX, but Microsoft 365 also sends it for unknown users.
  else if (enhanced?.[2] === '1' && enhanced[3] === '10' && fromText === 'user_unknown') reason = fromText;
  else reason = fromCode ?? fromText ?? (permanent ? 'unknown' : 'temporary_failure');

  return { bounceType: typeFor(reason, permanent), reason };
}
