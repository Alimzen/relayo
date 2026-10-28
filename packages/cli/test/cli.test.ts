import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT, duration, run, type Io } from '../src/index.js';

interface FakeMessage {
  id: string;
  subject: string;
  createdAt: string;
  recipients: Array<{ address: string; scenario: { name: string; param?: string; source: string } }>;
  latest?: { type: string; bounceType?: string };
  events: Array<{ id: string; type: string; recipient: string; timestamp: string; bounceType?: string; reason?: string }>;
}

/** A tiny Relayo Sim: enough of the HTTP API for the CLI, with a clock the tests move. */
function fakeSim(messages: FakeMessage[] = []) {
  const requests: Array<{ method: string; url: URL; body?: unknown; auth: string | null }> = [];
  let clock = Date.parse('2026-10-18T12:00:00Z');
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method: init?.method ?? 'GET', url, body, auth: new Headers(init?.headers).get('authorization') });
    if (new Headers(init?.headers).get('authorization') !== 'Bearer sim_key') return Response.json({ message: 'Invalid API key' }, { status: 401 });
    if (url.pathname === '/v1/scenarios') {
      return Response.json({ data: [{ name: 'hard-bounce', description: 'The mailbox does not exist.', example: 'hard-bounce@sim.relayo.dev' }] });
    }
    if (url.pathname === '/v1/messages' && init?.method === 'POST') return Response.json({ id: 'sim_new', status: 'queued' }, { status: 202 });
    if (url.pathname === '/v1/messages') {
      const before = url.searchParams.get('before');
      const q = url.searchParams.get('q');
      const limit = Number(url.searchParams.get('limit'));
      const list = messages
        .filter((m) => !before || m.createdAt < before)
        .filter((m) => !q || m.subject.includes(q))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map(({ events: _e, ...m }) => ({ ...m, via: 'api', from: 'a@empresa.com' }));
      return Response.json({ data: list });
    }
    const found = messages.find((m) => url.pathname === `/v1/messages/${m.id}`);
    if (found) return Response.json({ ...found, via: 'api', from: 'a@empresa.com' });
    return Response.json({ message: 'Not found' }, { status: 404 });
  }) as typeof fetch;

  let out = '';
  let err = '';
  const io: Io = {
    env: { RELAYO_SIM_URL: 'http://sim.test', RELAYO_SIM_API_KEY: 'sim_key' },
    out: (t) => (out += t),
    err: (t) => (err += t),
    fetch: fetchFn,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return { io, requests, output: () => out, errors: () => err, messages };
}

const message = (id: string, minutesAgo: number, extra: Partial<FakeMessage> = {}): FakeMessage => ({
  id,
  subject: `Asunto ${id}`,
  createdAt: new Date(Date.parse('2026-10-18T12:00:00Z') - minutesAgo * 60_000).toISOString(),
  recipients: [{ address: `${id}@sim.relayo.dev`, scenario: { name: 'delivered', source: 'default' } }],
  latest: { type: 'delivered' },
  events: [],
  ...extra,
});

describe('relayo CLI', () => {
  it('needs the URL and API key, and says how to give them', async () => {
    const sim = fakeSim();
    sim.io.env = {};
    expect(await run(['scenarios'], sim.io)).toBe(EXIT.usage);
    expect(sim.errors()).toContain('RELAYO_URL');
  });

  it('reports API errors with their message and exit code 3', async () => {
    const sim = fakeSim();
    expect(await run(['scenarios', '--api-key', 'wrong'], sim.io)).toBe(EXIT.api);
    expect(sim.errors()).toContain('Relayo Sim 401: Invalid API key');
  });

  it('rejects unknown commands and options', async () => {
    const sim = fakeSim();
    expect(await run(['nope'], sim.io)).toBe(EXIT.usage);
    expect(await run(['scenarios', '--nope'], sim.io)).toBe(EXIT.usage);
  });

  it('lists scenarios', async () => {
    const sim = fakeSim();
    expect(await run(['scenarios'], sim.io)).toBe(EXIT.ok);
    expect(sim.output()).toContain('hard-bounce@sim.relayo.dev  The mailbox does not exist.');
  });

  it('sends a test message and prints its id', async () => {
    const sim = fakeSim();
    expect(await run(['send', '--to', 'hard-bounce@sim.relayo.dev', '--to', 'ana@sim.relayo.dev', '--scenario', 'greylist+3'], sim.io)).toBe(EXIT.ok);
    expect(sim.output()).toBe('sim_new\n');
    expect(sim.requests[0]!.body).toMatchObject({
      to: ['hard-bounce@sim.relayo.dev', 'ana@sim.relayo.dev'],
      headers: { 'X-Sim-Scenario': 'greylist+3' },
    });
  });

  it('waits for an event, polling until it appears', async () => {
    const sim = fakeSim([message('sim_1', 0)]);
    let polls = 0;
    const fetchFn = sim.io.fetch!;
    sim.io.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (++polls === 3) {
        sim.messages[0]!.events.push({ id: 'e1', type: 'bounced', bounceType: 'hard', recipient: 'sim_1@sim.relayo.dev', timestamp: '', reason: 'user_unknown' });
      }
      return fetchFn(input, init);
    }) as typeof fetch;

    expect(await run(['wait', 'sim_1', '--for', 'bounced:hard'], sim.io)).toBe(EXIT.ok);
    expect(sim.output()).toContain('✓ sim_1: bounced:hard · user_unknown');
    expect(polls).toBe(3);
  });

  it('fails after the timeout, showing what did happen', async () => {
    const sim = fakeSim([message('sim_1', 0, { events: [{ id: 'e', type: 'delivered', recipient: 'sim_1@sim.relayo.dev', timestamp: '' }] })]);
    expect(await run(['wait', 'sim_1', '--for', 'bounced', '--timeout', '5s'], sim.io)).toBe(EXIT.failed);
    expect(sim.errors()).toContain('No "bounced" event after 5s');
    expect(sim.errors()).toContain('sim_1: delivered');
  });

  it('a bounce type must match too', async () => {
    const soft = { id: 'e', type: 'bounced', bounceType: 'soft', recipient: 'sim_1@sim.relayo.dev', timestamp: '' };
    const sim = fakeSim([message('sim_1', 0, { events: [soft] })]);
    expect(await run(['wait', 'sim_1', '--for', 'bounced:hard', '--timeout', '2s'], sim.io)).toBe(EXIT.failed);
  });

  it('waits for any message matching a search', async () => {
    const delivered = { id: 'e', type: 'delivered', recipient: 'sim_2@sim.relayo.dev', timestamp: '' };
    const sim = fakeSim([message('sim_1', 1), message('sim_2', 0, { subject: 'Tu factura', events: [delivered] })]);
    expect(await run(['wait', '--search', 'factura', '--for', 'delivered'], sim.io)).toBe(EXIT.ok);
    expect(sim.output()).toContain('sim_2');
  });

  it('validates wait options', async () => {
    const sim = fakeSim();
    expect(await run(['wait', 'sim_1'], sim.io)).toBe(EXIT.usage);
    expect(await run(['wait', 'sim_1', '--for', 'exploded'], sim.io)).toBe(EXIT.usage);
    expect(await run(['wait', 'sim_1', '--for', 'delivered:hard'], sim.io)).toBe(EXIT.usage);
    expect(await run(['wait', 'sim_1', '--for', 'bounced', '--timeout', 'soon'], sim.io)).toBe(EXIT.usage);
  });

  it('lists messages since a moment, paging back as needed', async () => {
    const list = Array.from({ length: 130 }, (_, i) => message(`sim_${i}`, i));
    const sim = fakeSim(list);
    expect(await run(['messages', '--since', '2h', '--json'], sim.io)).toBe(EXIT.ok);
    expect(JSON.parse(sim.output())).toHaveLength(121); // 0 to 120 minutes ago, inclusive
    expect(sim.requests.filter((r) => r.url.pathname === '/v1/messages').length).toBe(2);
  });

  it('writes a markdown report for GitHub job summaries', async () => {
    const sim = fakeSim([
      message('sim_1', 5, { latest: { type: 'bounced', bounceType: 'hard' }, subject: 'Factura | octubre' }),
      message('sim_2', 3),
      message('sim_3', 90),
    ]);
    expect(await run(['report', '--since', '1h', '--format', 'markdown'], sim.io)).toBe(EXIT.ok);
    const md = sim.output();
    expect(md).toContain('2 messages since 2026-10-18T11:00:00.000Z: 1 bounced:hard · 1 delivered.');
    expect(md).toContain('| bounced:hard | sim_1@sim.relayo.dev | Factura \\| octubre | delivered | `sim_1` |');
    expect(md).not.toContain('sim_3');
  });

  it('shows a timeline', async () => {
    const sim = fakeSim([
      message('sim_1', 0, { events: [{ id: 'e', type: 'bounced', bounceType: 'hard', reason: 'user_unknown', recipient: 'sim_1@sim.relayo.dev', timestamp: 't1' }] }),
    ]);
    expect(await run(['show', 'sim_1'], sim.io)).toBe(EXIT.ok);
    expect(sim.output()).toContain('t1  bounced:hard · user_unknown');
  });

  it('follows events as they happen, each once, reading only the messages that changed', async () => {
    const at = (seconds: number) => new Date(Date.parse('2026-10-18T12:00:00Z') + seconds * 1000).toISOString();
    const old = { id: 'e0', type: 'delivered', recipient: 'sim_1@sim.relayo.dev', timestamp: at(-600) };
    const sim = fakeSim([message('sim_1', 10, { events: [old] }), message('sim_2', 0, { latest: { type: 'accepted' } })]);
    let polls = 0;
    const base = sim.io.fetch!;
    sim.io.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes('/v1/messages?') && ++polls === 2) {
        sim.messages[1]!.events.push({ id: 'e1', type: 'bounced', bounceType: 'hard', reason: 'user_unknown', recipient: 'sim_2@sim.relayo.dev', timestamp: at(1) });
        sim.messages[1]!.latest = { type: 'bounced', bounceType: 'hard' };
      }
      return base(input, init);
    }) as typeof fetch;
    expect(await run(['tail', '--interval', '1s', '--timeout', '3s'], sim.io)).toBe(EXIT.ok);
    expect(sim.output()).toContain('bounced:hard · user_unknown');
    expect(sim.output()).toContain('sim_2@sim.relayo.dev  sim_2');
    expect(sim.output()).not.toContain('sim_1@');
    // sim_1 did not change after the first read: its detail is fetched once.
    expect(sim.requests.filter((r) => r.url.pathname === '/v1/messages/sim_1')).toHaveLength(1);
  });

  it('parses durations', () => {
    expect(duration('30s', 'x')).toBe(30_000);
    expect(duration('2m', 'x')).toBe(120_000);
    expect(duration('1.5h', 'x')).toBe(5_400_000);
    expect(duration('10', 'x')).toBe(10_000);
    expect(duration('250ms', 'x')).toBe(250);
  });
});

/** The platform's template and request-log endpoints, for live keys and templates as files. */
function fakePlatform() {
  const templates = new Map<string, Record<string, unknown>>();
  const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const log: Array<Record<string, unknown>> = [];
  let clock = Date.parse('2026-10-18T12:00:00Z');
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    requests.push({ method, path: url.pathname, ...(body && { body }) });
    const withVariables = (t: Record<string, unknown>) => ({ ...t, variables: [...String(t.html ?? '').matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]), updatedAt: 'x' });
    if (url.pathname === '/v1/messages' && method === 'POST') return Response.json({ id: 'sim_live', status: 'queued' }, { status: 202 });
    if (url.pathname === '/v1/project/requests') return Response.json({ data: [...log].reverse() });
    if (url.pathname === '/v1/project/templates' && method === 'GET') return Response.json({ data: [...templates.values()].map(withVariables) });
    if (url.pathname === '/v1/project/templates' && method === 'POST') {
      templates.set(String(body!.alias), { id: 'tpl_1', ...body });
      return Response.json(withVariables(templates.get(String(body!.alias))!), { status: 201 });
    }
    const ref = decodeURIComponent(url.pathname.split('/').pop()!);
    const found = templates.get(ref);
    if (!found) return Response.json({ message: 'No hay ninguna plantilla' }, { status: 404 });
    if (method === 'PATCH') templates.set(ref, { ...found, ...body });
    return Response.json(withVariables(templates.get(ref)!));
  }) as typeof fetch;
  let out = '';
  let err = '';
  const io: Io = {
    env: { RELAYO_URL: 'https://relayo.test', RELAYO_API_KEY: 'rly_live_abc' },
    out: (t) => (out += t),
    err: (t) => (err += t),
    fetch: fetchFn,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return { io, templates, requests, log, output: () => out, errors: () => err, tick: () => clock };
}

describe('relayo CLI with live keys', () => {
  it('needs a real sender, and sends templates with their variables', async () => {
    const p = fakePlatform();
    expect(await run(['send', '--to', 'ana@cliente.com'], p.io)).toBe(EXIT.usage);
    expect(p.errors()).toContain('--from');
    expect(await run(['send', '--to', 'ana@cliente.com', '--from', 'hola@empresa.com', '--var', 'x=1'], p.io)).toBe(EXIT.usage);
    expect(
      await run(['send', '--to', 'ana@cliente.com', '--from', 'hola@empresa.com', '--template', 'bienvenida', '--var', 'nombre=Ana', '--var', 'pedido=42', '--var', 'vip=true'], p.io),
    ).toBe(EXIT.ok);
    expect(p.requests.at(-1)!.body).toEqual({
      from: 'hola@empresa.com',
      to: ['ana@cliente.com'],
      template: 'bienvenida',
      variables: { nombre: 'Ana', pedido: 42, vip: true },
    });
  });

  it('pulls a template to files and pushes it back, creating or updating it', async () => {
    const p = fakePlatform();
    const dir = await mkdtemp(join(tmpdir(), 'relayo-cli-'));
    await writeFile(join(dir, 'bienvenida.json'), JSON.stringify({ alias: 'bienvenida', name: 'Bienvenida', channel: 'email', subject: 'Hola' }));
    await writeFile(join(dir, 'bienvenida.html'), '<p>Hola {{nombre}}</p>');
    expect(await run(['templates', 'push', join(dir, 'bienvenida.json')], p.io)).toBe(EXIT.ok);
    expect(p.output()).toContain('Created bienvenida (variables: nombre)');
    expect(p.requests.at(-1)!.body).toMatchObject({ alias: 'bienvenida', html: '<p>Hola {{nombre}}</p>', design: null });

    await writeFile(join(dir, 'bienvenida.html'), '<p>Hola de nuevo {{nombre}}</p>');
    expect(await run(['templates', 'push', join(dir, 'bienvenida.json')], p.io)).toBe(EXIT.ok);
    expect(p.requests.at(-1)).toMatchObject({ method: 'PATCH', path: '/v1/project/templates/bienvenida' });

    const out = await mkdtemp(join(tmpdir(), 'relayo-cli-'));
    expect(await run(['templates', 'pull', 'bienvenida', '--dir', out], p.io)).toBe(EXIT.ok);
    expect(JSON.parse(await readFile(join(out, 'bienvenida.json'), 'utf8'))).toEqual({ alias: 'bienvenida', name: 'Bienvenida', channel: 'email', subject: 'Hola' });
    expect(await readFile(join(out, 'bienvenida.html'), 'utf8')).toBe('<p>Hola de nuevo {{nombre}}</p>');

    expect(await run(['templates', 'list'], p.io)).toBe(EXIT.ok);
    expect(p.output()).toContain('bienvenida  email');
    expect(await run(['templates', 'show', 'nada'], p.io)).toBe(EXIT.usage);
    expect(await run(['templates', 'borrar'], p.io)).toBe(EXIT.usage);
  });

  it('follows the request log as it grows', async () => {
    const p = fakePlatform();
    const at = (seconds: number) => new Date(p.tick() + seconds * 1000).toISOString();
    p.log.push({ id: 'r0', keyName: 'CI', method: 'GET', path: '/v1/messages', status: 200, durationMs: 9, createdAt: new Date(p.tick() - 60_000).toISOString() });
    let polls = 0;
    const base = p.io.fetch!;
    p.io.fetch = (async (input: string | URL, init?: RequestInit) => {
      polls++;
      if (polls === 2) p.log.push({ id: 'r1', keyName: 'Servidor', method: 'POST', path: '/v1/messages', status: 202, durationMs: 31, createdAt: at(1) });
      if (polls === 3) p.log.push({ id: 'r2', keyName: 'Servidor', method: 'POST', path: '/v1/messages', status: 400, durationMs: 4, error: 'Missing from', createdAt: at(2) });
      return base(input, init);
    }) as typeof fetch;
    expect(await run(['tail', '--requests', '--interval', '1s', '--timeout', '5s', '--json'], p.io)).toBe(EXIT.ok);
    const lines = p.output().trim().split('\n').map((l) => JSON.parse(l) as { id: string });
    // What came before the start is not printed; each request once.
    expect(lines.map((l) => l.id)).toEqual(['r1', 'r2']);
  });
});
