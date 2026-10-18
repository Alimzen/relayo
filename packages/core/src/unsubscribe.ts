import { ValidationError } from './errors.js';
import type { EmailMessage, Unsubscribe } from './types/message.js';

const HEADER = 'List-Unsubscribe';
const POST_HEADER = 'List-Unsubscribe-Post';

/**
 * Builds the `List-Unsubscribe` headers (RFC 2369) and, for one-click unsubscribe, `List-Unsubscribe-Post`
 * (RFC 8058). Gmail and Yahoo require one-click unsubscribe from bulk senders.
 */
export function listUnsubscribeHeaders(unsubscribe: Unsubscribe): Record<string, string> {
  const { url, mailto } = unsubscribe;
  if (!url && !mailto) throw new ValidationError('"unsubscribe" needs a url, a mailto address, or both');

  const entries: string[] = [];
  if (mailto) {
    if (!/^[^\s@<>]+@[^\s@<>]+$/.test(mailto)) throw new ValidationError(`Invalid unsubscribe mailto address: ${mailto}`);
    entries.push(`<mailto:${mailto}>`);
  }
  const oneClick = unsubscribe.oneClick ?? url !== undefined;
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ValidationError(`Invalid unsubscribe url: ${url}`);
    }
    if (oneClick && parsed.protocol !== 'https:') {
      throw new ValidationError('One-click unsubscribe needs an https url (RFC 8058)');
    }
    entries.push(`<${parsed.href}>`);
  } else if (unsubscribe.oneClick) {
    throw new ValidationError('One-click unsubscribe needs a url');
  }

  const headers: Record<string, string> = { [HEADER]: entries.join(', ') };
  if (oneClick && url) headers[POST_HEADER] = 'List-Unsubscribe=One-Click';
  return headers;
}

/** Returns the message with `unsubscribe` expanded into headers; the input is not modified. */
export function withUnsubscribeHeaders(message: EmailMessage): EmailMessage {
  if (!message.unsubscribe) return message;
  const existing = Object.keys(message.headers ?? {}).map((h) => h.toLowerCase());
  if (existing.includes('list-unsubscribe') || existing.includes('list-unsubscribe-post')) {
    throw new ValidationError('Set either "unsubscribe" or List-Unsubscribe headers, not both');
  }
  return { ...message, headers: { ...message.headers, ...listUnsubscribeHeaders(message.unsubscribe) } };
}
