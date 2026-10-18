import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { WebhookRequest } from '@relayo/core';

export const SIGNATURE_HEADER = 'x-twilio-email-event-webhook-signature';
export const TIMESTAMP_HEADER = 'x-twilio-email-event-webhook-timestamp';

/** Accepts the base64 key shown in SendGrid's settings (DER/SPKI) or a PEM. */
export function parsePublicKey(key: string): KeyObject {
  if (key.includes('BEGIN PUBLIC KEY')) return createPublicKey(key);
  return createPublicKey({ key: Buffer.from(key.trim(), 'base64'), format: 'der', type: 'spki' });
}

export function header(req: WebhookRequest, name: string): string | undefined {
  const entry = Object.entries(req.headers).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  return Array.isArray(value) ? value[0] : value;
}

export interface VerifyOptions {
  /** Reject signatures older than this many seconds (replay protection). Off by default. */
  toleranceSeconds?: number;
  now?: () => number;
}

/**
 * Verifies SendGrid's Signed Event Webhook: an ECDSA (P-256, SHA-256) signature over
 * `timestamp + raw body`. Needs the exact raw body; a re-serialized JSON body will not verify.
 */
export function verifySignature(req: WebhookRequest, key: KeyObject, options: VerifyOptions = {}): boolean {
  const signature = header(req, SIGNATURE_HEADER);
  const timestamp = header(req, TIMESTAMP_HEADER);
  if (!signature || !timestamp || req.rawBody === undefined) return false;

  if (options.toleranceSeconds !== undefined) {
    const now = (options.now ?? Date.now)() / 1000;
    if (Math.abs(now - Number(timestamp)) > options.toleranceSeconds) return false;
  }

  const body = typeof req.rawBody === 'string' ? Buffer.from(req.rawBody, 'utf8') : Buffer.from(req.rawBody);
  try {
    return verify(
      'sha256',
      Buffer.concat([Buffer.from(timestamp, 'utf8'), body]),
      { key, dsaEncoding: 'der' },
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}
