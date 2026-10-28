/** What the CLI needs from the Relayo HTTP API (Relayo Sim, test or live keys). */

export type EventType =
  | 'accepted'
  | 'delivered'
  | 'deferred'
  | 'bounced'
  | 'complained'
  | 'rejected'
  | 'opened'
  | 'clicked'
  | 'unsubscribed'
  | 'failed';

export interface SimRecipient {
  address: string;
  scenario: { name: string; param?: string; source: string };
}

export interface SimMessage {
  id: string;
  via: 'smtp' | 'api';
  relayoMessageId?: string;
  from: string;
  recipients: SimRecipient[];
  subject: string;
  createdAt: string;
  latest?: { type: EventType; bounceType?: 'hard' | 'soft' | 'block' };
}

export interface SimEvent {
  id: string;
  type: EventType;
  recipient: string;
  timestamp: string;
  bounceType?: 'hard' | 'soft' | 'block';
  reason?: string;
  smtpCode?: number;
  enhancedCode?: string;
  diagnostic?: string;
}

export interface MessageDetail extends SimMessage {
  events: SimEvent[];
}

export interface Scenario {
  name: string;
  description: string;
  example: string;
}

export interface SendInput {
  from: string;
  to: string[];
  subject?: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  /** A saved template (alias or id) and its variables. */
  template?: string;
  variables?: Record<string, unknown>;
}

export interface Template {
  id: string;
  alias: string;
  name: string;
  channel: 'email' | 'sms';
  subject?: string;
  html?: string;
  text?: string;
  body?: string;
  variables: string[];
  updatedAt: string;
}

/** What can be sent to create or change a template; `design: null` drops the visual editor's blocks. */
export type TemplateInput = Partial<Pick<Template, 'alias' | 'name' | 'channel' | 'subject' | 'html' | 'text' | 'body'>> & { design?: null };

/** A request made with an API key, from the project's request log. */
export interface ApiRequest {
  id: string;
  keyName: string;
  mode: 'test' | 'live';
  method: string;
  path: string;
  status: number;
  durationMs: number;
  error?: string;
  createdAt: string;
}

export interface MessageQuery {
  limit?: number;
  before?: string;
  q?: string;
  status?: EventType;
}

export class SimApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SimApiError';
  }
}

export class SimClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  scenarios(): Promise<Scenario[]> {
    return this.request<{ data: Scenario[] }>('GET', '/v1/scenarios').then((r) => r.data);
  }

  send(input: SendInput): Promise<{ id: string }> {
    return this.request('POST', '/v1/messages', input);
  }

  messages(query: MessageQuery = {}): Promise<SimMessage[]> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
    return this.request<{ data: SimMessage[] }>('GET', `/v1/messages?${params}`).then((r) => r.data);
  }

  message(id: string): Promise<MessageDetail> {
    return this.request('GET', `/v1/messages/${encodeURIComponent(id)}`);
  }

  templates(): Promise<Template[]> {
    return this.request<{ data: Template[] }>('GET', '/v1/project/templates').then((r) => r.data);
  }

  /** The template, or undefined when the project has none with that alias or id. */
  async template(ref: string): Promise<Template | undefined> {
    try {
      return await this.request<Template>('GET', `/v1/project/templates/${encodeURIComponent(ref)}`);
    } catch (error) {
      if (error instanceof SimApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  createTemplate(input: TemplateInput): Promise<Template> {
    return this.request('POST', '/v1/project/templates', input);
  }

  updateTemplate(ref: string, input: TemplateInput): Promise<Template> {
    return this.request('PATCH', `/v1/project/templates/${encodeURIComponent(ref)}`, input);
  }

  /** Newest first. */
  requests(query: { limit?: number; status?: 'failed' } = {}): Promise<ApiRequest[]> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    return this.request<{ data: ApiRequest[] }>('GET', `/v1/project/requests?${params}`).then((r) => r.data);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new SimApiError(`Cannot reach Relayo Sim at ${this.baseUrl}: ${(error as Error).message}`, 0);
    }
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { message?: string | string[] };
      const detail = Array.isArray(data.message) ? data.message.join('; ') : (data.message ?? response.statusText);
      throw new SimApiError(`Relayo Sim ${response.status}: ${detail}`, response.status);
    }
    return (await response.json()) as T;
  }
}
