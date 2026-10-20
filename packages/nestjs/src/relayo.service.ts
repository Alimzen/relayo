import { Inject, Injectable } from '@nestjs/common';
import type {
  ChannelClient,
  EmailMessage,
  EventHandler,
  EventOf,
  EventType,
  Channel,
  Relayo,
  RelayoEvent,
  SmsMessage,
  WebhookRequest,
} from '@alimzen/relayo';
import { RELAYO_CLIENT } from './constants.js';

/** Injectable facade over the `Relayo` instance configured in `RelayoModule`. */
@Injectable()
export class RelayoService implements Relayo {
  constructor(@Inject(RELAYO_CLIENT) private readonly relayo: Relayo) {}

  get email(): ChannelClient<EmailMessage> {
    return this.relayo.email;
  }

  get sms(): ChannelClient<SmsMessage> {
    return this.relayo.sms;
  }

  on<T extends EventType>(type: T, handler: EventHandler<EventOf<T>>): () => void;
  on(type: '*', handler: EventHandler): () => void;
  on(type: EventType | '*', handler: EventHandler<never>): () => void {
    return this.relayo.on(type as '*', handler as EventHandler);
  }

  off<T extends EventType>(type: T, handler: EventHandler<EventOf<T>>): void;
  off(type: '*', handler: EventHandler): void;
  off(type: EventType | '*', handler: EventHandler<never>): void {
    this.relayo.off(type as '*', handler as EventHandler);
  }

  emit(event: RelayoEvent): Promise<void> {
    return this.relayo.emit(event);
  }

  handleWebhook(channel: Channel, req: WebhookRequest): Promise<RelayoEvent[]> {
    return this.relayo.handleWebhook(channel, req);
  }
}
