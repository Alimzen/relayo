import { Module, type DynamicModule, type InjectionToken, type ModuleMetadata, type Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { createRelayo, type RelayoConfig } from '@relayo/core';
import { RELAYO_CLIENT, RELAYO_OPTIONS } from './constants.js';
import { RelayoEventsExplorer } from './relayo-events.explorer.js';
import { RelayoService } from './relayo.service.js';
import { createWebhookController } from './webhook.controller.js';

export type RelayoModuleOptions = RelayoConfig;

export interface RelayoWebhookOptions {
  /** Route prefix for the webhook controller. Default `"webhooks/relayo"`. */
  path?: string;
}

/** Options that shape the module itself, so they can't come from an async factory. */
export interface RelayoModuleExtras {
  /** Register the module globally so `RelayoService` is injectable everywhere. Default true. */
  isGlobal?: boolean;
  /**
   * Expose `POST <path>/:channel[/:provider]` to receive provider webhooks. Off by default.
   * Signed webhooks (SendGrid, SNS) need the raw body: create the app with `{ rawBody: true }`.
   */
  webhooks?: boolean | RelayoWebhookOptions;
}

export interface RelayoModuleAsyncOptions extends RelayoModuleExtras, Pick<ModuleMetadata, 'imports'> {
  useFactory: (...args: never[]) => RelayoModuleOptions | Promise<RelayoModuleOptions>;
  inject?: InjectionToken[];
}

const DEFAULT_WEBHOOK_PATH = 'webhooks/relayo';

@Module({})
export class RelayoModule {
  /**
   * @example
   * RelayoModule.forRoot({ email: ses({ region: 'eu-west-1' }), webhooks: true })
   */
  static forRoot(options: RelayoModuleOptions & RelayoModuleExtras): DynamicModule {
    const { isGlobal, webhooks, ...config } = options;
    return RelayoModule.build({ provide: RELAYO_OPTIONS, useValue: config }, { isGlobal, webhooks });
  }

  /**
   * @example
   * RelayoModule.forRootAsync({
   *   inject: [ConfigService],
   *   useFactory: (config: ConfigService) => ({ email: sendgrid({ apiKey: config.getOrThrow('SENDGRID_KEY') }) }),
   * })
   */
  static forRootAsync(options: RelayoModuleAsyncOptions): DynamicModule {
    const module = RelayoModule.build(
      { provide: RELAYO_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
      { isGlobal: options.isGlobal, webhooks: options.webhooks },
    );
    return { ...module, imports: [...(module.imports ?? []), ...(options.imports ?? [])] };
  }

  private static build(
    optionsProvider: Provider,
    extras: { isGlobal: boolean | undefined; webhooks: RelayoModuleExtras['webhooks'] },
  ): DynamicModule {
    const clientProvider: Provider = {
      provide: RELAYO_CLIENT,
      useFactory: (config: RelayoConfig) => createRelayo(config),
      inject: [RELAYO_OPTIONS],
    };
    const webhookPath =
      extras.webhooks === true
        ? DEFAULT_WEBHOOK_PATH
        : extras.webhooks
          ? (extras.webhooks.path ?? DEFAULT_WEBHOOK_PATH)
          : undefined;

    return {
      module: RelayoModule,
      global: extras.isGlobal ?? true,
      imports: [DiscoveryModule],
      providers: [optionsProvider, clientProvider, RelayoService, RelayoEventsExplorer],
      controllers: webhookPath ? [createWebhookController(webhookPath)] : [],
      exports: [RelayoService, RELAYO_CLIENT],
    };
  }
}
