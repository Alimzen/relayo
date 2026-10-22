import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  type Type,
} from '@nestjs/common';
import { ValidationError, WebhookVerificationError, type Channel, type Relayo, type WebhookRequest } from '@alimzen/relayo';
import { RELAYO_CLIENT } from './constants.js';

const CHANNELS: ReadonlySet<string> = new Set<Channel>(['email', 'sms']);
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** The parts of an Express or Fastify request we use. */
interface IncomingRequest extends AsyncIterable<Uint8Array> {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: Buffer;
  /** Express keeps the full path here; Fastify in `url`. */
  originalUrl?: string;
  url?: string;
  readable?: boolean;
  readableEnded?: boolean;
}

export interface WebhookResponse {
  received: number;
}

/**
 * Builds the controller that receives provider webhooks:
 * `POST <path>/:channel` and `POST <path>/:channel/:provider` (the second one is needed with `failover()`).
 * Add `?account=<name>` for webhooks of a named account (`accounts` in the module options).
 */
export function createWebhookController(path: string): Type<unknown> {
  @Controller(path)
  class RelayoWebhookController {
    private readonly logger = new Logger('RelayoWebhook');
    private warnedAboutRawBody = false;

    constructor(@Inject(RELAYO_CLIENT) private readonly relayo: Relayo) {}

    @Post(':channel')
    @HttpCode(200)
    receive(
      @Param('channel') channel: string,
      @Query('account') account: string | undefined,
      @Req() req: IncomingRequest,
    ): Promise<WebhookResponse> {
      return this.handle(channel, undefined, account, req);
    }

    @Post(':channel/:provider')
    @HttpCode(200)
    receiveFrom(
      @Param('channel') channel: string,
      @Param('provider') provider: string,
      @Query('account') account: string | undefined,
      @Req() req: IncomingRequest,
    ): Promise<WebhookResponse> {
      return this.handle(channel, provider, account, req);
    }

    private async handle(
      channel: string,
      provider: string | undefined,
      account: string | undefined,
      req: IncomingRequest,
    ): Promise<WebhookResponse> {
      if (!CHANNELS.has(channel)) throw new BadRequestException(`Unknown channel "${channel}"`);
      if (account !== undefined && !this.relayo.accounts.includes(account)) {
        throw new BadRequestException(`Unknown account "${account}"`);
      }
      const webhook = await toWebhookRequest(req, provider);
      if (account !== undefined) webhook.account = account;
      try {
        const events = await this.relayo.handleWebhook(channel as Channel, webhook);
        return { received: events.length };
      } catch (error) {
        if (error instanceof WebhookVerificationError) {
          if (webhook.rawBody === undefined && !this.warnedAboutRawBody) {
            this.warnedAboutRawBody = true;
            this.logger.warn(
              'Webhook signature failed and the raw body was not available. Create the app with ' +
                '`NestFactory.create(AppModule, { rawBody: true })` so signatures can be checked.',
            );
          }
          throw new UnauthorizedException(error.message);
        }
        if (error instanceof ValidationError) throw new BadRequestException(error.message);
        // Anything else (including errors thrown by @OnRelayoEvent handlers) becomes a 500,
        // so the provider retries the delivery later.
        throw error;
      }
    }
  }

  return RelayoWebhookController;
}

async function toWebhookRequest(req: IncomingRequest, provider: string | undefined): Promise<WebhookRequest> {
  let rawBody: string | Uint8Array | undefined = req.rawBody ?? (typeof req.body === 'string' ? req.body : undefined);
  // Express leaves bodies it has no parser for (SNS posts JSON as text/plain) unread on the stream.
  if (rawBody === undefined && isEmptyBody(req.body) && req.readable && !req.readableEnded) {
    rawBody = await readStream(req);
  }
  const request: WebhookRequest = {
    headers: req.headers,
    body: isEmptyBody(req.body) && rawBody !== undefined ? rawBody : req.body,
  };
  if (rawBody !== undefined) request.rawBody = rawBody;
  // Path and query as called: Twilio signs the URL and carries the message id in it.
  const url = req.originalUrl ?? req.url;
  if (url) request.url = url;
  if (provider !== undefined) request.provider = provider;
  return request;
}

function isEmptyBody(body: unknown): boolean {
  return body === undefined || body === null || (typeof body === 'object' && Object.keys(body).length === 0);
}

async function readStream(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BadRequestException('Webhook body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
