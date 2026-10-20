export interface RelayoErrorOptions {
  provider?: string;
  raw?: unknown;
  cause?: unknown;
}

/**
 * Marks Relayo errors across copies of this package. When an app ends up with two copies of
 * `@alimzen/relayo` (ESM and CJS builds side by side, or two versions), `instanceof` on the class alone
 * would fail and a driver's error would no longer be recognized as retryable, as a bad signature, etc.
 */
// Keeps the package's former name on purpose: errors from copies published as @alimzen/core are recognized too.
const BRAND = Symbol.for('@alimzen/core:error');

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
    Object.defineProperty(this, BRAND, { value: true });
  }

  /** Recognizes errors from other copies of this package: by brand, and by `code` for the subclasses. */
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    if (typeof value !== 'object' || value === null || !(value as Record<symbol, unknown>)[BRAND]) return false;
    if (this === RelayoError) return true;
    return Object.hasOwn(this, 'code') && (value as RelayoError).code === (this as unknown as { code: string }).code;
  }
}

/** The message is invalid or uses something the driver doesn't support. */
export class ValidationError extends RelayoError {
  static readonly code = 'validation_error';
  readonly code = ValidationError.code;
  readonly retryable = false;
}

/** Credentials are missing, invalid or lack permissions. */
export class AuthenticationError extends RelayoError {
  static readonly code = 'authentication_error';
  readonly code = AuthenticationError.code;
  readonly retryable = false;
}

/** The provider refused the message (suppression list, invalid recipient, ...). */
export class RejectedError extends RelayoError {
  static readonly code = 'rejected';
  readonly code = RejectedError.code;
  readonly retryable = false;
}

export class RateLimitError extends RelayoError {
  static readonly code = 'rate_limited';
  readonly code = RateLimitError.code;
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
  static readonly code = 'provider_unavailable';
  readonly code = ProviderUnavailableError.code;
  readonly retryable = true;
}

/** The driver could not verify the authenticity of a webhook. */
export class WebhookVerificationError extends RelayoError {
  static readonly code = 'webhook_verification_failed';
  readonly code = WebhookVerificationError.code;
  readonly retryable = false;
}

export function isRelayoError(error: unknown): error is RelayoError {
  return error instanceof RelayoError;
}
