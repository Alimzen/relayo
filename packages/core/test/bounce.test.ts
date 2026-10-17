import { describe, expect, it } from 'vitest';
import { classifyBounce } from '../src/index.js';

describe('classifyBounce', () => {
  it.each([
    // Recipient problems
    [{ smtpCode: 550, enhancedCode: '5.1.1', diagnostic: '550 5.1.1 User unknown' }, 'hard', 'user_unknown'],
    [{ diagnostic: 'smtp; 550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup' }, 'hard', 'user_unknown'],
    [{ diagnostic: '556 5.1.10 Recipient address has null MX' }, 'hard', 'domain_invalid'],
    [{ diagnostic: 'smtp; 550 5.1.2 Bad destination host' }, 'hard', 'domain_invalid'],
    [{ diagnostic: "550-5.2.1 The email account that you tried to reach is disabled" }, 'hard', 'mailbox_disabled'],
    [{ diagnostic: 'smtp; 552 5.2.2 Mailbox full' }, 'soft', 'mailbox_full'],
    [{ diagnostic: '452 4.2.2 The email account that you tried to reach is over quota' }, 'soft', 'mailbox_full'],
    [{ smtpCode: 550, diagnostic: 'No such user here' }, 'hard', 'user_unknown'],
    // Sender-side problems must be block, never hard
    [{ diagnostic: 'smtp; 550 5.7.1 Service unavailable; client host blocked using Spamhaus' }, 'block', 'reputation_block'],
    [{ diagnostic: '550 5.7.1 Message rejected due to local policy' }, 'block', 'policy_block'],
    [{ diagnostic: '550-5.7.26 Unauthenticated email from empresa.com is not accepted due to DMARC policy' }, 'block', 'auth_failure'],
    [{ diagnostic: '421-4.7.28 Our system has detected an unusual rate of unsolicited mail' }, 'block', 'rate_limited'],
    [{ diagnostic: '552 5.3.4 Message size exceeds fixed maximum message size' }, 'block', 'message_too_large'],
    [{ diagnostic: '554 5.6.0 Message content rejected' }, 'block', 'content_rejected'],
    [{ diagnostic: '550 5.7.1 Message rejected as spam by Content Filtering' }, 'block', 'content_rejected'],
    // Temporary and unknown
    [{ diagnostic: '451 4.3.0 Mail server temporarily rejected message' }, 'soft', 'temporary_failure'],
    [{ smtpCode: 450 }, 'soft', 'temporary_failure'],
    [{ diagnostic: '554 5.0.0 Error' }, 'hard', 'unknown'],
    [{}, 'hard', 'unknown'],
  ] as const)('%o → %s/%s', (input, bounceType, reason) => {
    expect(classifyBounce(input)).toEqual({ bounceType, reason });
  });
});
