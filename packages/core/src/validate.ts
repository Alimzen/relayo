// Hand-written checks until ADR 4 (Zod vs Valibot) is decided.
import { ValidationError } from './errors.js';
import type { Driver } from './types/driver.js';
import type { BaseMessage, EmailMessage, Recipient, SmsMessage } from './types/message.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const E164_RE = /^\+[1-9]\d{1,14}$/;

export function toRecipients(to: Recipient | Recipient[]): Recipient[] {
  return Array.isArray(to) ? to : [to];
}

function fail(message: string, provider?: string): never {
  throw new ValidationError(message, provider === undefined ? {} : { provider });
}

function checkEmailAddress(recipient: Recipient | undefined, field: string): void {
  if (!recipient || typeof recipient.address !== 'string' || !EMAIL_RE.test(recipient.address)) {
    fail(`Invalid email address in "${field}": ${JSON.stringify(recipient?.address)}`);
  }
}

export function validateEmail(message: EmailMessage, driver: Driver<EmailMessage>): void {
  const to = toRecipients(message.to);
  if (to.length === 0) fail('Email message needs at least one recipient in "to"');
  to.forEach((r) => checkEmailAddress(r, 'to'));
  message.cc?.forEach((r) => checkEmailAddress(r, 'cc'));
  message.bcc?.forEach((r) => checkEmailAddress(r, 'bcc'));
  checkEmailAddress(message.from, 'from');
  if (message.replyTo) checkEmailAddress(message.replyTo, 'replyTo');
  if (typeof message.subject !== 'string') fail('Email message needs a "subject"');
  if (!message.html && !message.text) fail('Email message needs "html" or "text"');
  if (message.attachments?.length && !driver.capabilities.attachments) {
    fail(`Driver "${driver.name}" does not support attachments`, driver.name);
  }
}

export function validateSms(message: SmsMessage): void {
  const to = toRecipients(message.to);
  if (to.length === 0) fail('SMS message needs at least one recipient in "to"');
  for (const r of to) {
    if (!r || typeof r.address !== 'string' || !E164_RE.test(r.address)) {
      fail(`Invalid phone number in "to" (expected E.164, e.g. +34600000000): ${JSON.stringify(r?.address)}`);
    }
  }
  if (typeof message.body !== 'string' || message.body.length === 0) {
    fail('SMS message needs a non-empty "body"');
  }
}

export function validate<M extends BaseMessage>(message: M, driver: Driver<M>): void {
  if (driver.channel === 'email') {
    validateEmail(message as unknown as EmailMessage, driver as unknown as Driver<EmailMessage>);
  } else {
    validateSms(message as unknown as SmsMessage);
  }
}
