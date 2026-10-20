import {
  AuthenticationError,
  ProviderUnavailableError,
  RateLimitError,
  ValidationError,
  type RelayoError,
} from '@alimzen/relayo';

/** What SendGrid answered, kept in `RelayoError.raw`. */
export interface SendGridErrorDetails {
  status?: number;
  errors?: Array<{ message?: string; field?: string | null; help?: unknown }>;
  body?: string;
}

/** Maps a non-2xx SendGrid response to a `RelayoError`. */
export async function errorFromResponse(response: Response, provider: string): Promise<RelayoError> {
  const text = await response.text().catch(() => '');
  const raw: SendGridErrorDetails = { status: response.status };
  try {
    const parsed = JSON.parse(text) as { errors?: SendGridErrorDetails['errors'] };
    if (parsed.errors) raw.errors = parsed.errors;
  } catch {
    if (text) raw.body = text;
  }
  const detail = raw.errors?.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).join('; ') || text;
  const message = `SendGrid ${response.status}${detail ? `: ${detail}` : ''}`;
  const options = { provider, raw };
  const status = response.status;

  if (status === 401 || status === 403) return new AuthenticationError(message, options);
  if (status === 429) {
    const retryAfter = retryAfterSeconds(response.headers);
    return new RateLimitError(message, retryAfter === undefined ? options : { ...options, retryAfter });
  }
  if (status >= 500) return new ProviderUnavailableError(message, options);
  // 400 (invalid request), 413 (payload too large) and other client errors.
  return new ValidationError(message, options);
}

export function networkError(error: unknown, provider: string): RelayoError {
  const message = error instanceof Error ? `SendGrid request failed: ${error.message}` : 'SendGrid request failed';
  return new ProviderUnavailableError(message, { provider, cause: error });
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const retryAfter = Number(headers.get('retry-after'));
  if (retryAfter > 0) return retryAfter;
  // SendGrid sends the epoch second at which the rate limit window resets.
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (reset > 0) return Math.max(0, Math.ceil(reset - Date.now() / 1000));
  return undefined;
}
