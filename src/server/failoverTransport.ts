import type { ExternalProviderAccount } from '../types/hub.ts';

export class UpstreamFailure extends Error {
  constructor(message: string, public status = 502, public retryAfterSeconds?: number) {
    super(message);
  }
}

export function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const result = Number.isFinite(seconds) ? seconds : (Date.parse(value) - now) / 1000;
  return Number.isFinite(result) && result >= 0 ? Math.min(86400, Math.ceil(result)) : undefined;
}

export function cooldownSeconds(error: unknown): number {
  const e = error as UpstreamFailure;
  if (e.status === 401 || e.status === 403 || e.status === 402) return 300;
  if (e.retryAfterSeconds !== undefined) return Math.max(10, e.retryAfterSeconds);
  return e.status === 429 ? 60 : 30;
}

// Per-request limits: failing endpoints must not freeze the entire queue.
export function timeoutMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 20 ? Math.min(n, 600000) : fallback;
}

export async function withDeadline<T>(promise: Promise<T>, ms: number, cancel: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          cancel();
          reject(new UpstreamFailure(`Timeout após ${ms} ms`, 504));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function safeError(error: unknown, provider?: ExternalProviderAccount): string {
  let text = error instanceof Error ? error.message : String(error);
  if (provider?.apiKey) text = text.split(provider.apiKey).join('[chave ocultada]');
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [oculto]').slice(0, 700);
}

/** SSE framing (including fragmented network packets and multi-line data). */
export async function* readSse(
  stream: ReadableStream<Uint8Array>,
  cancel: () => void,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let lines: string[] = [];
  const event = () => {
    const value = lines.join('\n');
    lines = [];
    return value;
  };
  try {
    while (true) {
      const { value, done } = await withDeadline(reader.read(), timeoutMs('QD_STREAM_IDLE_TIMEOUT_MS', 30000), cancel);
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // CRLF must remain intact when a network packet ends at CR.
      while (pending.includes('\n')) {
        const nl = pending.indexOf('\n');
        const line = pending.slice(0, nl).replace(/\r$/, '');
        pending = pending.slice(nl + 1);
        if (!line) { const data = event(); if (data) yield data; }
        else if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
      }
      if (pending.length > 8 * 1024 * 1024) throw new UpstreamFailure('Evento SSE excede 8 MB');
      if (done) break;
    }
    if (pending.startsWith('data:')) lines.push(pending.slice(5).replace(/^ /, ''));
    const data = event();
    if (data) yield data;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    cancel();
  }
}
