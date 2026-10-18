import { readFile } from 'node:fs/promises';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { SimApiError, SimClient, type EventType, type MessageDetail, type SimEvent, type SimMessage } from './client.js';

export interface Io {
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Exit codes: 0 ok, 1 an expectation was not met, 2 wrong usage or configuration, 3 the API failed. */
export const EXIT = { ok: 0, failed: 1, usage: 2, api: 3 } as const;

const EVENT_TYPES = new Set<string>([
  'accepted', 'delivered', 'deferred', 'bounced', 'complained', 'rejected', 'opened', 'clicked', 'unsubscribed', 'failed',
]);

export const HELP = `relayo: command line for Relayo Sim, the email delivery simulator.

Usage: relayo <command> [options]

Commands
  scenarios                     List the simulator's scenarios
  send --to <address>...        Send a test message (see "relayo send --help")
  messages                      Latest messages with their status
  show <message-id>             A message and its event timeline
  wait [<message-id>] --for <event>[:<bounce-type>]
                                Wait until an event happens; exit 1 on timeout
  report                        Summary of the messages since a moment (text or markdown)

Configuration (flags win over environment)
  --url <url>        RELAYO_SIM_URL       Base URL of Relayo Sim
  --api-key <key>    RELAYO_SIM_API_KEY   A project's API key
  --json                                 Machine-readable output

Exit codes: 0 ok · 1 expectation not met · 2 usage or configuration · 3 API error
`;

const COMMON = {
  url: { type: 'string' },
  'api-key': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsConfig['options'];

class UsageError extends Error {}

export async function run(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.out(HELP);
    return command ? EXIT.ok : EXIT.usage;
  }
  if (command === '--version' || command === '-v') {
    io.out(`${VERSION}\n`);
    return EXIT.ok;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    io.err(`Unknown command "${command}". Run "relayo --help".\n`);
    return EXIT.usage;
  }
  try {
    return await handler(rest, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n`);
      return EXIT.usage;
    }
    if (error instanceof SimApiError) {
      io.err(`${error.message}\n`);
      return EXIT.api;
    }
    // node:util parseArgs throws TypeErrors with codes for unknown or malformed options.
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      io.err(`${error.message}\n`);
      return EXIT.usage;
    }
    throw error;
  }
}

declare const __VERSION__: string | undefined;
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';

type Command = (args: string[], io: Io) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  async scenarios(args, io) {
    const { values } = parse(args, {});
    if (values.help) return help(io, 'relayo scenarios [--json]\n\nLists the scenarios and an example address for each.\n');
    const scenarios = await client(values, io).scenarios();
    if (values.json) return json(io, scenarios);
    const width = Math.max(...scenarios.map((s) => s.example.length));
    for (const s of scenarios) io.out(`${s.example.padEnd(width)}  ${s.description}\n`);
    return EXIT.ok;
  },

  async send(args, io) {
    const { values } = parse(args, {
      to: { type: 'string', multiple: true },
      from: { type: 'string' },
      subject: { type: 'string' },
      text: { type: 'string' },
      'html-file': { type: 'string' },
      scenario: { type: 'string' },
    });
    if (values.help) {
      return help(
        io,
        `relayo send --to <address>... [options]

  --to <address>       Recipient; repeat for several (e.g. hard-bounce@sim.relayo.dev)
  --from <address>     Sender (default: test@relayo.dev)
  --subject <text>     Subject (default: "Relayo CLI test")
  --text <text>        Plain text body
  --html-file <path>   HTML body from a file
  --scenario <name>    Scenario for every recipient (X-Sim-Scenario), e.g. greylist+3

Prints the simulator's message id, to use with "show" and "wait".
`,
      );
    }
    if (!values.to?.length) throw new UsageError('send needs at least one --to address.');
    const html = values['html-file'] ? await readFile(values['html-file'], 'utf8') : undefined;
    const { id } = await client(values, io).send({
      from: values.from ?? 'test@relayo.dev',
      to: values.to,
      subject: values.subject ?? 'Relayo CLI test',
      text: values.text ?? 'Sent with the relayo CLI.',
      ...(html !== undefined && { html }),
      ...(values.scenario && { headers: { 'X-Sim-Scenario': values.scenario } }),
    });
    if (values.json) return json(io, { id });
    io.out(`${id}\n`);
    return EXIT.ok;
  },

  async messages(args, io) {
    const { values } = parse(args, {
      limit: { type: 'string' },
      status: { type: 'string' },
      search: { type: 'string' },
      since: { type: 'string' },
    });
    if (values.help) {
      return help(
        io,
        `relayo messages [--limit 20] [--status <event>] [--search <text>] [--since <time>] [--json]

  --status   Only messages with an event of this type (bounced, delivered, complained...)
  --search   Text in the subject, sender or recipients
  --since    ISO date or a duration back from now: 30s, 15m, 2h, 1d
`,
      );
    }
    const status = eventType(values.status);
    const limit = values.limit ? positive(values.limit, '--limit') : values.since ? 500 : 20;
    const since = values.since ? sinceDate(values.since, io) : undefined;
    const messages = await collect(client(values, io), { limit, status, search: values.search, since });
    if (values.json) return json(io, messages);
    if (!messages.length) {
      io.out('No messages.\n');
      return EXIT.ok;
    }
    io.out(table(['STATUS', 'TO', 'SUBJECT', 'SCENARIO', 'ID'], messages.map((m) => [statusOf(m), recipients(m), m.subject, scenarioOf(m), m.id])));
    return EXIT.ok;
  },

  async show(args, io) {
    const { values, positionals } = parse(args, {}, true);
    if (values.help) return help(io, 'relayo show <message-id> [--json]\n\nThe message and its timeline, per recipient.\n');
    const id = positionals[0];
    if (!id) throw new UsageError('show needs a message id.');
    const message = await client(values, io).message(id);
    if (values.json) return json(io, message);
    io.out(describe(message));
    return EXIT.ok;
  },

  async wait(args, io) {
    const { values, positionals } = parse(
      args,
      {
        for: { type: 'string' },
        recipient: { type: 'string' },
        search: { type: 'string' },
        since: { type: 'string' },
        timeout: { type: 'string' },
        interval: { type: 'string' },
      },
      true,
    );
    if (values.help) {
      return help(
        io,
        `relayo wait [<message-id>] --for <event>[:<bounce-type>] [options]

Waits until a message gets an event, then exits 0; exits 1 if it does not happen in time.

  <message-id>         The simulator's id (from "send"), or
  --search <text>      any message matching the text (subject, sender, recipients)
  --since <time>       with --search: only messages since then (default: 1h)
  --for <event>        accepted, delivered, deferred, bounced, complained, rejected, opened, clicked,
                       unsubscribed; add :hard, :soft or :block for bounces (bounced:hard)
  --recipient <addr>   Only events for this recipient
  --timeout <time>     How long to wait (default 60s)
  --interval <time>    Time between checks (default 1s)

Examples
  relayo wait sim_123 --for bounced:hard
  relayo wait --search "Your invoice" --for delivered --timeout 2m
`,
      );
    }
    const id = positionals[0];
    if (!id && !values.search) throw new UsageError('wait needs a message id or --search.');
    if (!values.for) throw new UsageError('wait needs --for <event>, e.g. --for bounced:hard.');
    const [type, bounceType] = values.for.split(':') as [string, string | undefined];
    const wanted = eventType(type)!;
    if (bounceType && !['hard', 'soft', 'block'].includes(bounceType)) throw new UsageError('The bounce type must be hard, soft or block.');
    if (bounceType && wanted !== 'bounced') throw new UsageError('A bounce type only applies to --for bounced.');

    const now = io.now ?? Date.now;
    const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const timeout = duration(values.timeout ?? '60s', '--timeout');
    const interval = duration(values.interval ?? '1s', '--interval');
    const since = sinceDate(values.since ?? '1h', io);
    const sim = client(values, io);
    const matches = (e: SimEvent) =>
      e.type === wanted && (!bounceType || e.bounceType === bounceType) && (!values.recipient || e.recipient.toLowerCase() === values.recipient.toLowerCase());

    const deadline = now() + timeout;
    let last: MessageDetail[] = [];
    for (;;) {
      last = id ? [await sim.message(id)] : await candidates(sim, values.search!, since);
      for (const message of last) {
        const event = message.events.find(matches);
        if (event) {
          if (values.json) return json(io, { ok: true, messageId: message.id, event });
          io.out(`✓ ${message.id}: ${eventLabel(event)} for ${event.recipient}\n`);
          return EXIT.ok;
        }
      }
      if (now() >= deadline) break;
      await sleep(Math.min(interval, Math.max(0, deadline - now())));
    }

    const seen = last.flatMap((m) => m.events.map((e) => `${m.id}: ${eventLabel(e)} (${e.recipient})`));
    if (values.json) return json(io, { ok: false, expected: values.for, seen }, EXIT.failed);
    io.err(`✗ No "${values.for}" event after ${formatDuration(timeout)}.\n`);
    io.err(last.length ? `  Seen:\n${seen.map((s) => `    ${s}\n`).join('') || '    (no events)\n'}` : '  No matching message.\n');
    return EXIT.failed;
  },

  async report(args, io) {
    const { values } = parse(args, { since: { type: 'string' }, format: { type: 'string' }, limit: { type: 'string' } });
    if (values.help) {
      return help(
        io,
        `relayo report [--since 1h] [--format text|markdown] [--json]

Counts the messages since a moment by status and lists them. In GitHub Actions:
  relayo report --since "$RELAYO_SIM_SINCE" --format markdown >> "$GITHUB_STEP_SUMMARY"
`,
      );
    }
    const format = values.format ?? 'text';
    if (format !== 'text' && format !== 'markdown') throw new UsageError('--format must be text or markdown.');
    const since = sinceDate(values.since ?? '1h', io);
    const limit = values.limit ? positive(values.limit, '--limit') : 500;
    const messages = await collect(client(values, io), { limit, since });
    const counts = new Map<string, number>();
    for (const m of messages) counts.set(statusOf(m), (counts.get(statusOf(m)) ?? 0) + 1);
    if (values.json) return json(io, { since: since.toISOString(), total: messages.length, byStatus: Object.fromEntries(counts), messages });

    const rows = messages.map((m) => [statusOf(m), recipients(m), m.subject, scenarioOf(m), m.id]);
    const totals = [...counts]
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .map(([status, n]) => `${n} ${status}`).join(' · ');
    if (format === 'markdown') {
      io.out(`### Relayo Sim\n\n`);
      io.out(`${messages.length} message${messages.length === 1 ? '' : 's'} since ${since.toISOString()}${totals ? `: ${totals}` : ''}.\n\n`);
      if (rows.length) {
        io.out('| Status | To | Subject | Scenario | Id |\n| --- | --- | --- | --- | --- |\n');
        for (const row of rows) io.out(`| ${row.map((cell, i) => (i === 4 ? `\`${cell}\`` : escapeCell(cell))).join(' | ')} |\n`);
      }
      return EXIT.ok;
    }
    io.out(`${messages.length} message${messages.length === 1 ? '' : 's'} since ${since.toISOString()}${totals ? `: ${totals}` : ''}\n`);
    if (rows.length) io.out(`\n${table(['STATUS', 'TO', 'SUBJECT', 'SCENARIO', 'ID'], rows)}`);
    return EXIT.ok;
  },
};

// --- Helpers ---------------------------------------------------------------------------------------

type Options = NonNullable<ParseArgsConfig['options']>;

function parse<O extends Options>(args: string[], options: O, allowPositionals = false) {
  const result = parseArgs({ args, options: { ...COMMON, ...options }, allowPositionals, strict: true });
  return result as unknown as {
    values: { [K in keyof (typeof COMMON & O)]?: (typeof COMMON & O)[K] extends { type: 'boolean' } ? boolean
      : (typeof COMMON & O)[K] extends { multiple: true } ? string[] : string };
    positionals: string[];
  };
}

function client(values: { url?: string | undefined; 'api-key'?: string | undefined }, io: Io): SimClient {
  const url = values.url ?? io.env.RELAYO_SIM_URL;
  const apiKey = values['api-key'] ?? io.env.RELAYO_SIM_API_KEY;
  if (!url) throw new UsageError('Missing the simulator URL: set RELAYO_SIM_URL or pass --url.');
  if (!/^https?:\/\//.test(url)) throw new UsageError(`The simulator URL must start with http:// or https:// (got "${url}").`);
  if (!apiKey) throw new UsageError('Missing the API key: set RELAYO_SIM_API_KEY or pass --api-key.');
  return new SimClient(url, apiKey, io.fetch);
}

function help(io: Io, text: string): number {
  io.out(text);
  return EXIT.ok;
}

function json(io: Io, value: unknown, code: number = EXIT.ok): number {
  io.out(`${JSON.stringify(value, null, 2)}\n`);
  return code;
}

function eventType(value: string | undefined): EventType | undefined {
  if (value === undefined) return undefined;
  if (!EVENT_TYPES.has(value)) throw new UsageError(`Unknown event "${value}". Use one of: ${[...EVENT_TYPES].join(', ')}.`);
  return value as EventType;
}

function positive(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} must be a positive whole number.`);
  return n;
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `500ms`, `30s`, `5m`, `2h`, `1d`, or a number of seconds. */
export function duration(value: string, flag: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(value.trim());
  if (!match) throw new UsageError(`${flag} must be a duration like 30s, 5m or 2h (got "${value}").`);
  return Math.round(Number(match[1]) * UNITS[match[2] ?? 's']!);
}

function sinceDate(value: string, io: Io): Date {
  const now = (io.now ?? Date.now)();
  if (/^\d+(\.\d+)?(ms|s|m|h|d)$/.test(value.trim())) return new Date(now - duration(value, '--since'));
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new UsageError(`--since must be an ISO date or a duration like 15m (got "${value}").`);
  return date;
}

function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/** Pages back through the newest messages until `limit`, or until they are older than `since`. */
async function collect(
  sim: SimClient,
  query: { limit: number; status?: EventType | undefined; search?: string | undefined; since?: Date | undefined },
): Promise<SimMessage[]> {
  const found: SimMessage[] = [];
  let before: string | undefined;
  while (found.length < query.limit) {
    const page = await sim.messages({
      limit: Math.min(100, query.limit - found.length),
      ...(before && { before }),
      ...(query.search && { q: query.search }),
      ...(query.status && { status: query.status }),
    });
    for (const m of page) {
      if (query.since && new Date(m.createdAt) < query.since) return found;
      found.push(m);
    }
    if (page.length === 0 || page.length < Math.min(100, query.limit)) break;
    before = page.at(-1)!.createdAt;
  }
  return found;
}

async function candidates(sim: SimClient, search: string, since: Date): Promise<MessageDetail[]> {
  const list = await collect(sim, { limit: 20, search, since });
  return Promise.all(list.map((m) => sim.message(m.id)));
}

function statusOf(m: SimMessage): string {
  if (!m.latest) return 'queued';
  return m.latest.type === 'bounced' && m.latest.bounceType ? `bounced:${m.latest.bounceType}` : m.latest.type;
}

function recipients(m: SimMessage): string {
  const [first, ...others] = m.recipients;
  return `${first?.address ?? '-'}${others.length ? ` +${others.length}` : ''}`;
}

function scenarioOf(m: SimMessage): string {
  const s = m.recipients[0]?.scenario;
  return s ? (s.param ? `${s.name}+${s.param}` : s.name) : '-';
}

function eventLabel(e: SimEvent): string {
  const code = [e.smtpCode, e.enhancedCode].filter(Boolean).join(' ');
  return [e.type === 'bounced' && e.bounceType ? `bounced:${e.bounceType}` : e.type, e.reason, code].filter(Boolean).join(' · ');
}

function describe(m: MessageDetail): string {
  const lines = [`${m.subject || '(no subject)'}`, `  id ${m.id}${m.relayoMessageId ? ` · messageId ${m.relayoMessageId}` : ''}`, `  from ${m.from} · ${m.via} · ${m.createdAt}`, ''];
  for (const r of m.recipients) {
    lines.push(`${r.address}  [${r.scenario.param ? `${r.scenario.name}+${r.scenario.param}` : r.scenario.name}]`);
    const events = m.events.filter((e) => e.recipient === r.address);
    if (!events.length) lines.push('  (no events yet)');
    for (const e of events) {
      lines.push(`  ${e.timestamp}  ${eventLabel(e)}`);
      if (e.diagnostic) lines.push(`      ${e.diagnostic}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}`;
}

function table(head: string[], rows: string[][]): string {
  const max = [12, 40, 40, 20, 50];
  const clip = (s: string, i: number) => (s.length > max[i]! ? `${s.slice(0, max[i]! - 1)}…` : s);
  const all = [head, ...rows.map((r) => r.map(clip))];
  const widths = head.map((_, i) => Math.max(...all.map((r) => r[i]!.length)));
  return all.map((r) => `${r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join('  ')}\n`).join('');
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
