import type { EventType } from '@alimzen/core';
import { RELAYO_EVENT_METADATA } from './constants.js';

export type RelayoEventSelector = EventType | '*';

/**
 * Runs the decorated method for every Relayo event of the given type(s), or `'*'` for all.
 * Works on singleton providers. The method receives the normalized event; throwing makes the webhook
 * answer with an error so the provider retries, so handlers should be idempotent (use `event.id`).
 *
 * @example
 * @OnRelayoEvent('bounced')
 * async onBounce(event: BounceEvent) { ... }
 */
export function OnRelayoEvent(...types: [RelayoEventSelector, ...RelayoEventSelector[]]): MethodDecorator {
  return (_target, _key, descriptor) => {
    const method = descriptor.value as object;
    const existing = (Reflect.getMetadata(RELAYO_EVENT_METADATA, method) as RelayoEventSelector[] | undefined) ?? [];
    Reflect.defineMetadata(RELAYO_EVENT_METADATA, [...existing, ...types], method);
    return descriptor;
  };
}
