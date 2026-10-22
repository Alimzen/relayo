import type { Driver, EmailMessage, SmsMessage } from '@alimzen/relayo';
import { simulator, simulatorSms, type SimulatorWebhookOptions } from '@alimzen/relayo-simulator';

export { scenarioAddress, scenarioNumber, SMS_SCENARIO_NUMBERS, verifySimulatorSignature as verifyRelayoSignature } from '@alimzen/relayo-simulator';

/** The hosted Relayo platform. */
export const DEFAULT_BASE_URL = 'https://relayo.alimzen.com';

export interface RelayoCloudOptions {
  /**
   * A project key from the Relayo panel. `rly_test_...` keys simulate (scenario addresses and numbers,
   * nothing is delivered); `rly_live_...` keys deliver through the providers connected to the project.
   */
  apiKey: string;
  /** Another Relayo installation. Defaults to `https://relayo.alimzen.com`. */
  baseUrl?: string;
  /** Verifies the signed webhook Relayo sends to your app (the project's webhook secret, `whsec_...`). */
  webhook?: SimulatorWebhookOptions;
  timeoutMs?: number;
  /** Provider name reported in results and errors. Defaults to `"relayo"`. */
  name?: string;
  fetch?: typeof fetch;
}

function driverOptions(options: RelayoCloudOptions) {
  return {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    name: options.name ?? 'relayo',
    ...(options.webhook && { webhook: options.webhook }),
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    ...(options.fetch && { fetch: options.fetch }),
  };
}

/**
 * Email through the Relayo platform: one key instead of each provider's credentials. The platform
 * delivers with the project's connections (failover included), keeps a suppression list, and sends every
 * event (deliveries, bounces, complaints...) to your app's webhook, already normalized.
 *
 * @example
 * const relayo = createRelayo({ email: relayoCloud({ apiKey: process.env.RELAYO_API_KEY!, webhook: { secret: process.env.RELAYO_WEBHOOK_SECRET! } }) });
 */
export function relayoCloud(options: RelayoCloudOptions): Driver<EmailMessage> {
  return simulator(driverOptions(options));
}

/** SMS through the Relayo platform, with the same key and webhook as email. */
export function relayoCloudSms(options: RelayoCloudOptions): Driver<SmsMessage> {
  return simulatorSms(driverOptions(options));
}
