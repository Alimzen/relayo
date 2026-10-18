import { createPublicKey, verify, X509Certificate, type KeyObject } from 'node:crypto';
import type { WebhookRequest } from '@alimzen/core';

/** An Amazon SNS HTTP(S) message. */
export interface SnsMessage {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: '1' | '2';
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
  UnsubscribeURL?: string;
}

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

const NOTIFICATION_FIELDS = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] as const;
const CONFIRMATION_FIELDS = ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'] as const;

/** Reads the request body, whatever the framework did with it (SNS posts JSON as text/plain). */
export function readBody(req: WebhookRequest): unknown {
  const source = req.rawBody ?? req.body;
  if (typeof source === 'string') return JSON.parse(source);
  if (source instanceof Uint8Array) return JSON.parse(Buffer.from(source).toString('utf8'));
  return source;
}

export function isSnsMessage(value: unknown): value is SnsMessage {
  const v = value as Partial<SnsMessage> | null;
  return !!v && typeof v === 'object' && typeof v.Type === 'string' && typeof v.Signature === 'string';
}

/** True for URLs that really belong to Amazon SNS, so we never fetch an attacker-chosen URL. */
export function isSnsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && SNS_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

export function stringToSign(message: SnsMessage): string {
  const fields = message.Type === 'Notification' ? NOTIFICATION_FIELDS : CONFIRMATION_FIELDS;
  let result = '';
  for (const field of fields) {
    const value = message[field];
    if (value !== undefined) result += `${field}\n${value}\n`;
  }
  return result;
}

export type CertificateFetcher = (url: string) => Promise<string>;

export const fetchCertificate: CertificateFetcher = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch SNS signing certificate: HTTP ${response.status}`);
  return response.text();
};

function publicKeyFrom(pem: string): KeyObject {
  return pem.includes('BEGIN CERTIFICATE') ? new X509Certificate(pem).publicKey : createPublicKey(pem);
}

export interface SnsVerifierOptions {
  /** Only accept messages from these topics. Recommended in production. */
  topicArns?: string[];
  fetchCertificate?: CertificateFetcher;
}

/** Verifies SNS message signatures (versions 1 and 2), caching signing certificates by URL. */
export function createSnsVerifier(options: SnsVerifierOptions = {}) {
  const fetchCert = options.fetchCertificate ?? fetchCertificate;
  const keys = new Map<string, Promise<KeyObject>>();

  return async function verifySns(message: SnsMessage): Promise<boolean> {
    if (options.topicArns && !options.topicArns.includes(message.TopicArn)) return false;
    if (!isSnsUrl(message.SigningCertURL) || !new URL(message.SigningCertURL).pathname.endsWith('.pem')) {
      return false;
    }
    const algorithm = message.SignatureVersion === '1' ? 'RSA-SHA1' : message.SignatureVersion === '2' ? 'RSA-SHA256' : undefined;
    if (!algorithm) return false;

    let key = keys.get(message.SigningCertURL);
    if (!key) {
      key = fetchCert(message.SigningCertURL).then(publicKeyFrom);
      keys.set(message.SigningCertURL, key);
      key.catch(() => keys.delete(message.SigningCertURL));
    }
    try {
      return verify(algorithm, Buffer.from(stringToSign(message), 'utf8'), await key, Buffer.from(message.Signature, 'base64'));
    } catch {
      return false;
    }
  };
}
