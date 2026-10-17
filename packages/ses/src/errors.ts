import {
  AuthenticationError,
  isRelayoError,
  ProviderUnavailableError,
  RateLimitError,
  RejectedError,
  ValidationError,
  type RelayoError,
} from '@relayo/core';

/** Fields of an AWS SDK error kept in `RelayoError.raw`. */
export interface SesErrorDetails {
  name?: string;
  message?: string;
  httpStatusCode?: number;
  requestId?: string;
}

interface AwsError {
  name?: string;
  message?: string;
  code?: string;
  $fault?: 'client' | 'server';
  $metadata?: { httpStatusCode?: number; requestId?: string };
}

const REJECTED = new Set([
  'MessageRejected',
  'MailFromDomainNotVerifiedException',
  'AccountSuspendedException',
  'SendingPausedException',
]);
const RATE_LIMITED = new Set(['TooManyRequestsException', 'LimitExceededException', 'ThrottlingException', 'Throttling']);
const INVALID = new Set(['BadRequestException', 'NotFoundException', 'ValidationException']);
const AUTH = new Set([
  'UnrecognizedClientException',
  'InvalidClientTokenId',
  'InvalidSignatureException',
  'SignatureDoesNotMatch',
  'IncompleteSignatureException',
  'AccessDeniedException',
  'ExpiredToken',
  'ExpiredTokenException',
  'CredentialsProviderError',
]);

export function toRelayoError(error: unknown, provider: string): RelayoError {
  if (isRelayoError(error)) return error;

  const err = (error ?? {}) as AwsError;
  const name = err.name ?? err.code ?? '';
  const status = err.$metadata?.httpStatusCode;
  const raw: SesErrorDetails = {};
  if (name) raw.name = name;
  if (err.message) raw.message = err.message;
  if (status) raw.httpStatusCode = status;
  if (err.$metadata?.requestId) raw.requestId = err.$metadata.requestId;

  const options = { provider, raw, cause: error };
  const message = err.message ? `${name}: ${err.message}` : name || 'SES send failed';

  if (REJECTED.has(name)) return new RejectedError(message, options);
  if (RATE_LIMITED.has(name) || status === 429) return new RateLimitError(message, options);
  if (AUTH.has(name) || status === 401 || status === 403) return new AuthenticationError(message, options);
  if (INVALID.has(name)) return new ValidationError(message, options);
  if (err.$fault === 'client' && status && status < 500) return new ValidationError(message, options);
  // Server faults, timeouts, network errors and anything unknown.
  return new ProviderUnavailableError(message, options);
}
