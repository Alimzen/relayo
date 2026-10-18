export { createRelayo } from './relayo.js';
export type { ChannelClient, EventHandler, Relayo, RelayoConfig } from './relayo.js';

export {
  AuthenticationError,
  isRelayoError,
  ProviderUnavailableError,
  RateLimitError,
  RejectedError,
  RelayoError,
  ValidationError,
  WebhookVerificationError,
} from './errors.js';
export type { RelayoErrorOptions } from './errors.js';

export type { RetryAttempt, RetryOptions } from './retry.js';

export { listUnsubscribeHeaders } from './unsubscribe.js';

export { failover } from './failover.js';
export type { FailoverAttempt, FailoverDriver, FailoverOptions } from './failover.js';

export { classifyBounce } from './bounce.js';
export type { BounceClassification, BounceInput } from './bounce.js';

export { memory } from './drivers/memory.js';
export type { MemoryDriver, MemoryDriverOptions, SentMessage } from './drivers/memory.js';

export type * from './types/message.js';
export type * from './types/events.js';
export type * from './types/driver.js';
