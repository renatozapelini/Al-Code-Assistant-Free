import { afterEach, describe, expect, test } from 'bun:test';
import { appFetch, readReminder, setReminder, saveProjectZip } from './androidBridge';

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as Record<string, unknown>).window;
});
function installBridge(overrides: Record<string, unknown> = {}) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { AndroidApp: {
    getSessionToken: () => 'PRIVATE-LOCAL-SESSION',
    getReminderSettings: () => JSON.stringify({ enabled: false, notificationPermission: false, scheduled: false }),
    setReminderEnabled: (enabled: boolean) => JSON.stringify({ enabled, notificationPermission: true, scheduled: enabled }),
    exportProjectZip: () => JSON.stringify({ ok: true }), ...overrides,
  } } });
}
describe('ponte nativa do APK', () => {
  test('injeta segredo somente na API interna e preserva os headers', async () => {
    installBridge();
    const calls: Array<{ path: string; headers: Headers }> = [];
    globalThis.fetch = (async (path: string, init: RequestInit) => {
      calls.push({ path, headers: new Headers(init.headers) }); return Response.json({ ok: true });
    }) as typeof fetch;
    await appFetch('/api/app/overview', { headers: { 'Content-Type': 'application/json' } });
    expect(calls[0].headers.get('X-App-Session')).toBe('PRIVATE-LOCAL-SESSION');
    expect(calls[0].headers.get('Content-Type')).toBe('application/json');
    for (const path of ['https://provider.example/api/app/chat', '//provider.example/api/app/chat', '/health', '/api/app/\\\\provider.example']) {
      await appFetch(path);
      expect(calls.at(-1)?.headers.has('X-App-Session')).toBe(false);
    }
  });
  test('sessão Android vazia falha antes de enviar requisição', async () => {
    installBridge({ getSessionToken: () => '' });
    let requests = 0;
    globalThis.fetch = (async () => { requests++; return Response.json({}); }) as typeof fetch;
    await expect(appFetch('/api/app/overview')).rejects.toThrow('Sessão local indisponível');
    expect(requests).toBe(0);
  });
  test('lembrete não simula crédito nem saldo', () => {
    installBridge();
    expect(readReminder()?.enabled).toBe(false);
    expect(setReminder(true)).toEqual({ enabled: true, notificationPermission: true, scheduled: true });
    expect(readReminder()).not.toHaveProperty('claimedToday');
    expect(readReminder()).not.toHaveProperty('credits');
  });
  test('rejeita resposta nativa inválida', () => {
    installBridge({ getReminderSettings: () => JSON.stringify({ ok: true }) });
    expect(readReminder).toThrow('agendamento Android');
  });
  test('exportação recebe bytes ZIP e abre salvamento humano', async () => {
    let saved: { data: string; name: string } | undefined;
    installBridge({ exportProjectZip: (data: string, name: string) => {
      saved = { data, name }; return JSON.stringify({ ok: true, message: 'Aguardando local de salvamento' });
    } });
    await saveProjectZip(new Blob([new Uint8Array([80, 75, 3, 4])]), 'projeto.zip');
    expect(saved?.name).toBe('projeto.zip');
    expect(atob(saved!.data)).toBe('PK\x03\x04');
  });
  test('limite e erro de exportação são visíveis', async () => {
    installBridge({ exportProjectZip: () => JSON.stringify({ ok: false, error: 'Escolha de arquivo já aberta' }) });
    await expect(saveProjectZip(new Blob(['small']), 'x.zip')).rejects.toThrow('já aberta');
    await expect(saveProjectZip(new Blob([new Uint8Array(4 * 1024 * 1024 + 1)]), 'x.zip')).rejects.toThrow('4 MB');
  });
});
