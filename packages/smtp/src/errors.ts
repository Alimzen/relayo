import {
  AuthenticationError,
  isRelayoError,
  ProviderUnavailableError,
  RateLimitError,
  RejectedError,
  ValidationError,
  type RelayoError,
} from '@alimzen/relayo';
import type { NodemailerError } from 'nodemailer';

/** Fields of a Nodemailer error kept in `RelayoError.raw`. */
export interface SmtpErrorDetails {
  code?: string;
  originalCode?: string;
  command?: string;
  responseCode?: number;
  response?: string;
  enhancedCode?: string;
  rejected?: string[];
}

const AUTH_CODES = new Set(['EAUTH', 'ENOAUTH', 'EOAUTH2']);
const AUTH_RESPONSE_CODES = new Set([530, 534, 535, 538]);
// Problems with the message or the setup; sending the same thing again won't help.
const CONFIG_CODES = new Set([
  'ECONFIG',
  'EMAXRECIPIENTS',
  'EREQUIRETLS',
  'EFILEACCESS',
  'EURLACCESS',
  'ERR_ACCESS_DENIED',
]);
// Only explicit throttling: "try again later" alone also comes with greylisting and busy servers.
const RATE_LIMIT_TEXT = /rate|too many|throttl|limit exceeded/i;
const ENHANCED_CODE = /\b([245]\.\d{1,3}\.\d{1,3})\b/;

export function smtpErrorDetails(err: NodemailerError): SmtpErrorDetails {
  const details: SmtpErrorDetails = {};
  if (err.code) details.code = err.code;
  if (err.originalCode) details.originalCode = err.originalCode;
  if (err.command) details.command = err.command;
  if (err.responseCode) details.responseCode = err.responseCode;
  if (err.response) {
    details.response = err.response;
    const enhanced = ENHANCED_CODE.exec(err.response)?.[1];
    if (enhanced) details.enhancedCode = enhanced;
  }
  if (err.rejected?.length) details.rejected = err.rejected;
  return details;
}

/**
 * Maps a Nodemailer error to a `RelayoError`. SMTP reply classes decide first (5xx is permanent,
 * 4xx is temporary); Nodemailer's own codes cover failures that never got a reply.
 */
export function toRelayoError(error: unknown, provider: string): RelayoError {
  if (isRelayoError(error)) return error;

  const err = (error ?? {}) as NodemailerError;
  const raw = smtpErrorDetails(err);
  const options = { provider, raw, cause: error };
  const message = err.response ?? err.message ?? 'SMTP send failed';
  const code = err.code ?? '';
  const responseCode = err.responseCode ?? 0;

  if (responseCode >= 400 && responseCode < 500) {
    const isRateLimit =
      RATE_LIMIT_TEXT.test(err.response ?? '') || raw.enhancedCode === '4.7.28' || raw.enhancedCode === '4.2.1';
    return isRateLimit ? new RateLimitError(message, options) : new ProviderUnavailableError(message, options);
  }
  if (AUTH_CODES.has(code) || AUTH_RESPONSE_CODES.has(responseCode)) {
    return new AuthenticationError(message, options);
  }
  if (responseCode >= 500) return new RejectedError(message, options);
  if (CONFIG_CODES.has(code) || code === 'EENVELOPE') return new ValidationError(message, options);

  // Connection, socket, DNS, TLS, timeout, protocol and anything unknown: worth another attempt.
  return new ProviderUnavailableError(message, options);
}
