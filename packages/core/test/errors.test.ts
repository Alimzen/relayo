import { describe, expect, it } from 'vitest';
import {
  isRelayoError,
  ProviderUnavailableError,
  RateLimitError,
  RelayoError,
  ValidationError,
  WebhookVerificationError,
} from '../src/index.js';

/** What an error thrown by another copy of @relayo/core looks like from here: same brand and shape, other class. */
function foreignError(code: string, retryable: boolean) {
  const error = Object.assign(new Error('from another copy'), { code, retryable });
  Object.defineProperty(error, Symbol.for('@relayo/core:error'), { value: true });
  return error;
}

describe('errors', () => {
  it('works with instanceof inside the same copy', () => {
    const error = new RateLimitError('slow', { provider: 'ses', retryAfter: 3 });
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toBeInstanceOf(RelayoError);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ name: 'RateLimitError', code: 'rate_limited', retryable: true, retryAfter: 3 });
  });

  it('recognizes errors from another copy of the package by brand and code', () => {
    const error = foreignError('webhook_verification_failed', false);
    expect(error instanceof WebhookVerificationError).toBe(true);
    expect(error instanceof RelayoError).toBe(true);
    expect(error instanceof ValidationError).toBe(false);
    expect(isRelayoError(error)).toBe(true);
    expect(isRelayoError(foreignError('provider_unavailable', true))).toBe(true);
    expect(foreignError('provider_unavailable', true) instanceof ProviderUnavailableError).toBe(true);
  });

  it('does not mistake unbranded look-alikes for Relayo errors', () => {
    const lookAlike = Object.assign(new Error('x'), { code: 'validation_error', retryable: false });
    expect(lookAlike instanceof ValidationError).toBe(false);
    expect(isRelayoError(lookAlike)).toBe(false);
    expect(isRelayoError(null)).toBe(false);
  });

  it('keeps user subclasses strict', () => {
    class QuotaError extends ValidationError {}
    expect(new QuotaError('x')).toBeInstanceOf(ValidationError);
    expect(new ValidationError('x') instanceof QuotaError).toBe(false);
    expect(foreignError('validation_error', false) instanceof QuotaError).toBe(false);
  });
});
