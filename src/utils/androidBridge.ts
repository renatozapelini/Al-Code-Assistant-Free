export interface ReminderSettings {
  enabled: boolean;
  notificationPermission: boolean;
  scheduled: boolean;
  nextWindowAt?: number;
  lastNotifiedAt?: number;
  message?: string;
}

interface AndroidBridge {
  getSessionToken(): string;
  getReminderSettings(): string;
  setReminderEnabled(enabled: boolean): string;
  exportProjectZip(base64: string, filename: string): string;
}

declare global {
  interface Window { AndroidApp?: AndroidBridge }
}

export function androidBridge(): AndroidBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const bridge = window.AndroidApp;
  return bridge && typeof bridge.getSessionToken === 'function' ? bridge : undefined;
}

export function appFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  // Never send the app session secret to a provider URL or another origin.
  if (path.startsWith('/api/app/') && !path.includes('\\')) {
    const bridge = androidBridge();
    if (bridge) {
      const token = bridge.getSessionToken();
      if (!token) return Promise.reject(new Error('Sessão local indisponível. Reabra o aplicativo.'));
      headers.set('X-App-Session', token);
    }
  }
  return fetch(path, { ...init, headers });
}

export function readReminder(): ReminderSettings | undefined {
  const bridge = androidBridge();
  if (!bridge) return undefined;
  return parseReminder(bridge.getReminderSettings());
}

function parseReminder(raw: string): ReminderSettings {
  const result: unknown = JSON.parse(raw);
  if (!result || typeof result !== 'object' || typeof (result as ReminderSettings).enabled !== 'boolean') {
    throw new Error('Não foi possível ler o agendamento Android.');
  }
  return result as ReminderSettings;
}

export function setReminder(enabled: boolean): ReminderSettings {
  const bridge = androidBridge();
  if (!bridge) throw new Error('O lembrete em segundo plano está disponível somente no APK.');
  return parseReminder(bridge.setReminderEnabled(enabled));
}

export async function saveProjectZip(blob: Blob, filename: string): Promise<void> {
  const bridge = androidBridge();
  if (!bridge) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return;
  }
  if (blob.size > 4 * 1024 * 1024) throw new Error('ZIP maior que o limite de exportação do Android (4 MB).');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  const result = JSON.parse(bridge.exportProjectZip(btoa(parts.join('')), filename)) as { ok?: boolean; error?: string; message?: string };
  if (!result.ok) throw new Error(result.error || result.message || 'Não foi possível abrir a exportação do Android.');
  // The native file picker confirms saving, not this request to open it.
}
