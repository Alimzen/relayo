import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import type { Relayo, RelayoEvent } from '@relayo/core';
import { RELAYO_CLIENT, RELAYO_EVENT_METADATA } from './constants.js';
import type { RelayoEventSelector } from './on-relayo-event.decorator.js';

/** Finds `@OnRelayoEvent()` methods on providers and subscribes them to the Relayo instance. */
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
    for (const wrapper of this.discovery.getProviders()) {
      const { instance } = wrapper;
      if (!instance || typeof instance !== 'object') continue;
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown> | null;
      if (!prototype) continue;

      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const method = prototype[methodName];
        if (typeof method !== 'function') continue;
        const types = Reflect.getMetadata(RELAYO_EVENT_METADATA, method) as RelayoEventSelector[] | undefined;
        if (!types?.length) continue;

        const owner = `${instance.constructor.name}.${methodName}`;
        if (!wrapper.isDependencyTreeStatic()) {
          this.logger.warn(`@OnRelayoEvent() on ${owner} is ignored: request-scoped providers can't receive events`);
          continue;
        }
        const handler = (event: RelayoEvent) => (method as (e: RelayoEvent) => unknown).call(instance, event) as void;
        for (const type of new Set(types)) {
          this.unsubscribers.push(this.relayo.on(type as '*', handler));
        }
      }
    }
  }

  onModuleDestroy(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }
}
