// A small MIME reader: enough for delivery and feedback reports, not a general-purpose mail parser.

export interface MimePart {
  headers: Headers;
  /** Lowercased media type, e.g. "multipart/report". */
  contentType: string;
  params: Record<string, string>;
  /** Decoded body (transfer encoding removed). Empty for multipart containers. */
  body: string;
  parts: MimePart[];
}

/** Header lookup by lowercase name; repeated headers keep every value. */
export class Headers {
  private readonly map = new Map<string, string[]>();

  add(name: string, value: string): void {
    const key = name.toLowerCase();
    const list = this.map.get(key);
    if (list) list.push(value);
    else this.map.set(key, [value]);
  }

  get(name: string): string | undefined {
    return this.map.get(name.toLowerCase())?.[0];
  }

  getAll(name: string): string[] {
    return this.map.get(name.toLowerCase()) ?? [];
  }
}

const MAX_DEPTH = 8;

export function parseMessage(raw: string | Uint8Array): MimePart {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('latin1');
  return parsePart(text.replace(/\r\n?/g, '\n'), 0);
}

/** Header block → Headers, unfolding continuation lines. */
export function parseHeaderBlock(block: string): Headers {
  const headers = new Headers();
  let current: [string, string] | undefined;
  for (const line of block.split('\n')) {
    if (/^[ \t]/.test(line) && current) {
      current[1] += ` ${line.trim()}`;
      continue;
    }
    if (current) headers.add(current[0], current[1].trim());
    const colon = line.indexOf(':');
    current = colon > 0 ? [line.slice(0, colon).trim(), line.slice(colon + 1)] : undefined;
  }
  if (current) headers.add(current[0], current[1].trim());
  return headers;
}

function parsePart(text: string, depth: number): MimePart {
  const split = text.search(/\n\n/);
  const headerBlock = split === -1 ? text : text.slice(0, split);
  const rawBody = split === -1 ? '' : text.slice(split + 2);
  const headers = parseHeaderBlock(headerBlock);
  const { type, params } = parseContentType(headers.get('content-type'));

  if (type.startsWith('multipart/') && params.boundary && depth < MAX_DEPTH) {
    return { headers, contentType: type, params, body: '', parts: splitMultipart(rawBody, params.boundary, depth) };
  }
  // Attached messages are parsed so their headers (Message-ID, X-Relayo-*) can be read.
  const body = decodeBody(rawBody, headers.get('content-transfer-encoding'));
  const parts = type === 'message/rfc822' && depth < MAX_DEPTH ? [parsePart(body.replace(/\r\n?/g, '\n'), depth + 1)] : [];
  return { headers, contentType: type, params, body, parts };
}

function splitMultipart(body: string, boundary: string, depth: number): MimePart[] {
  const delimiter = `--${boundary}`;
  const parts: MimePart[] = [];
  const chunks = body.split(new RegExp(`^${escapeRegExp(delimiter)}(?:--)?[ \\t]*$`, 'm'));
  // chunks[0] is the preamble; the last chunk after the closing delimiter is the epilogue.
  const closed = new RegExp(`^${escapeRegExp(delimiter)}--[ \\t]*$`, 'm').test(body);
  const inner = chunks.slice(1, closed ? -1 : undefined);
  for (const chunk of inner) {
    parts.push(parsePart(chunk.replace(/^\n/, '').replace(/\n$/, ''), depth + 1));
  }
  return parts;
}

export function parseContentType(value: string | undefined): { type: string; params: Record<string, string> } {
  if (!value) return { type: 'text/plain', params: {} };
  const [type = 'text/plain', ...rest] = value.split(';');
  const params: Record<string, string> = {};
  for (const param of rest) {
    const eq = param.indexOf('=');
    if (eq === -1) continue;
    const key = param.slice(0, eq).trim().toLowerCase();
    params[key] = param.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return { type: type.trim().toLowerCase(), params };
}

function decodeBody(body: string, encoding: string | undefined): string {
  switch (encoding?.trim().toLowerCase()) {
    case 'base64':
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    case 'quoted-printable':
      return Buffer.from(
        body
          .replace(/=\n/g, '')
          .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
        'latin1',
      ).toString('utf8');
    default:
      return body;
  }
}

/** Depth-first search over the MIME tree. */
export function findPart(part: MimePart, predicate: (p: MimePart) => boolean): MimePart | undefined {
  if (predicate(part)) return part;
  for (const child of part.parts) {
    const found = findPart(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
