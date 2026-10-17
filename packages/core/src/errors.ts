export interface RelayoErrorOptions {
  provider?: string;
  raw?: unknown;
  cause?: unknown;
}

export abstract class RelayoError extends Error {
  abstract readonly code: string;
  /** Base for retries and failover: whether sending the same message again may succeed. */
  abstract readonly retryable: boolean;
  readonly provider?: string;
  readonly raw?: unknown;

  constructor(message: string, options: RelayoErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.raw !== undefined) this.raw = options.raw;
  }
}

/** The message is invalid or uses something the driver doesn't support. */
export class ValidationError extends RelayoError {
  readonly code = 'validation_error';
  readonly retryable = false;
}

/** Credentials are missing, invalid or lack permissions. */
export class AuthenticationError extends RelayoError {
  readonly code = 'authentication_error';
  readonly retryable = false;
}

/** The provider refused the message (suppression list, invalid recipient, ...). */
export class RejectedError extends RelayoError {
  readonly code = 'rejected';
  readonly retryable = false;
}

export class RateLimitError extends RelayoError {
  readonly code = 'rate_limited';
  readonly retryable = true;
  /** Seconds to wait before retrying, when the provider says so. */
  readonly retryAfter?: number;

  constructor(message: string, options: RelayoErrorOptions & { retryAfter?: number } = {}) {
    super(message, options);
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
  }
}

/** Network error, timeout or 5xx from the provider. */
export class ProviderUnavailableError extends RelayoError {
  readonly code = 'provider_unavailable';
  readonly retryable = true;
}

/** The driver could not verify the authenticity of a webhook. */
export class WebhookVerificationError extends RelayoError {
  readonly code = 'webhook_verification_failed';
  readonly retryable = false;
}

export function isRelayoError(error: unknown): error is RelayoError {
  return error instanceof RelayoError;
}
