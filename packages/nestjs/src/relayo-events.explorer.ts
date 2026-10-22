import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import type { Relayo, RelayoEvent } from '@alimzen/relayo';
import { RELAYO_CLIENT, RELAYO_EVENT_METADATA } from './constants.js';
import type { RelayoEventSelector } from './on-relayo-event.decorator.js';

/** The part of Nest's InstanceWrapper we use (its module path is internal). */
interface DiscoveredClass {
  isDependencyTreeStatic(): boolean;
}

/**
 * Finds `@OnRelayoEvent()` methods on providers and controllers and subscribes them to the Relayo
 * instance of this module, then logs what it subscribed so a missing handler is easy to spot.
 */
@Injectable()
export class RelayoEventsExplorer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('RelayoModule');
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
    @Inject(RELAYO_CLIENT) private readonly relayo: Relayo,
  ) {}

  onApplicationBootstrap(): void {
    const subscribed: string[] = [];
    // A class can be both (a provider listed again as a controller): subscribe each instance once.
    const visited = new Set<object>();
    for (const wrapper of [...this.discovery.getProviders(), ...this.discovery.getControllers()]) {
      const { instance } = wrapper;
      if (!instance || typeof instance !== 'object' || visited.has(instance)) continue;
      visited.add(instance);
      subscribed.push(...this.subscribe(wrapper, instance));
    }
    if (subscribed.length) this.logger.log(`@OnRelayoEvent handlers: ${subscribed.join(', ')}`);
    else this.logger.log('No @OnRelayoEvent handlers found');
  }

  onModuleDestroy(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }

  private subscribe(wrapper: DiscoveredClass, instance: object): string[] {
    const prototype = Object.getPrototypeOf(instance) as Record<string, unknown> | null;
    if (!prototype) return [];
    const subscribed: string[] = [];

    for (const methodName of this.scanner.getAllMethodNames(prototype)) {
      const method = prototype[methodName];
      if (typeof method !== 'function') continue;
      const types = Reflect.getMetadata(RELAYO_EVENT_METADATA, method) as RelayoEventSelector[] | undefined;
      if (!types?.length) continue;

      const owner = `${instance.constructor.name}.${methodName}`;
      if (!wrapper.isDependencyTreeStatic()) {
        this.logger.warn(`@OnRelayoEvent() on ${owner} is ignored: request-scoped classes can't receive events`);
        continue;
      }
      const handler = (event: RelayoEvent) => (method as (e: RelayoEvent) => unknown).call(instance, event) as void;
      const unique = [...new Set(types)];
      for (const type of unique) this.unsubscribers.push(this.relayo.on(type as '*', handler));
      subscribed.push(`${owner} (${unique.join(', ')})`);
    }
    return subscribed;
  }
}
