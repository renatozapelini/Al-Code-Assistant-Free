import { useCallback, useEffect, useState } from 'react';
import { Download, ExternalLink, RefreshCw } from 'lucide-react';

export const APP_VERSION = '3.2.0';
interface UpdateInfo {
  ok: boolean; currentVersion: string; latestVersion?: string; available: boolean;
  downloadUrl?: string; releaseUrl?: string; checkedAt?: number; message?: string;
}
export function validateUpdateInfo(value: unknown): UpdateInfo {
  if (!value || typeof value !== 'object') throw new Error('Resposta de atualização inválida.');
  const data = value as UpdateInfo;
  if (typeof data.ok !== 'boolean' || typeof data.available !== 'boolean' || data.currentVersion !== APP_VERSION) throw new Error('Resposta de atualização incompatível.');
  if (data.available) {
    if (!data.ok || typeof data.latestVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(data.latestVersion)) throw new Error('Versão de atualização inválida.');
    const current = APP_VERSION.split('.').map(Number), latest = data.latestVersion.split('.').map(Number);
    const first = latest.findIndex((n, i) => n !== current[i]);
    if (latest.some(n => !Number.isSafeInteger(n)) || first < 0 || latest[first] < current[first]) throw new Error('A versão recebida não é mais nova.');
    const version = data.latestVersion;
    const expected = `https://github.com/renatozapelini/Ai/releases/download/v${version}/Code-Assistants-v${version}.apk`;
    const expectedBare = `https://github.com/renatozapelini/Ai/releases/download/${version}/Code-Assistants-v${version}.apk`;
    if (data.downloadUrl !== expected && data.downloadUrl !== expectedBare) throw new Error('Link de APK fora do repositório autorizado.');
  }
  return data;
}
// O motor nativo responde 503 com um diagnóstico honesto (lista vazia, sem APK compatível,
// timeout). O motivo exato precisa chegar ao usuário em vez de um erro HTTP genérico.
export async function readUpdateResponse(res: { ok: boolean; status: number; json: () => Promise<unknown> }): Promise<UpdateInfo> {
  const payload = await res.json().catch(() => null);
  let data: UpdateInfo | null = null;
  try { data = validateUpdateInfo(payload); } catch (error) { if (res.ok) throw error; }
  const transport = `Não foi possível consultar atualizações (HTTP ${res.status}).`;
  if (!data || (!res.ok && (data.ok || data.available))) throw new Error(transport);
  return data;
}
export function AppUpdatePanel({ apiFetch, expanded }: { apiFetch: (path: string, init?: RequestInit) => Promise<Response>; expanded: boolean }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const check = useCallback(async (signal?: AbortSignal, force = false) => {
    setBusy(true); setError('');
    try {
      const res = await apiFetch(force ? '/api/app/updates?force=1' : '/api/app/updates', { signal });
      const data = await readUpdateResponse(res);
      setInfo(data);
      if (!data.ok) setError(data.message || 'GitHub indisponível; tente novamente mais tarde.');
    } catch (e) {
      if (!signal?.aborted) { setInfo(null); setError(e instanceof Error ? e.message : 'Falha ao consultar atualizações.'); }
    } finally { if (!signal?.aborted) setBusy(false); }
  }, [apiFetch]);
  useEffect(() => {
    const controller = new AbortController();
    void check(controller.signal);
    const timer = setInterval(() => void check(controller.signal), 3600000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [check]);
  if (!expanded && !info?.available) return null;
  return <section aria-label="Atualizações do aplicativo" className="rounded-xl border border-zinc-800 bg-[#12151B] p-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-semibold text-sm">{info?.available ? `Nova versão ${info.latestVersion} disponível` : `Code Assistants ${APP_VERSION}`}</h2>
      {expanded && <button type="button" disabled={busy} onClick={() => void check(undefined, true)} className="min-h-[44px] flex items-center gap-2 text-xs text-emerald-300 disabled:opacity-50"><RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />{busy ? 'Verificando…' : 'Verificar atualização'}</button>}
    </div>
    {expanded && <p role="status" className="text-xs text-zinc-400">{error || info?.message || 'Consultando releases do GitHub…'}</p>}
    {info?.available && <a href={info.downloadUrl} target="_self" rel="noreferrer" className="min-h-[44px] inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 text-xs font-semibold text-zinc-950"><Download className="w-4 h-4" />Baixar novo APK</a>}
    {expanded && <div className="rounded-lg border border-zinc-800 bg-[#090B0E] p-3 space-y-1.5 text-[11px] text-zinc-400">
      <p className="text-xs font-semibold text-zinc-200">GitHub conectado · renatozapelini/Ai</p>
      <p>Repositório público de releases consultado pelo atualizador. Nenhuma chave, conta ou projeto é enviado ao GitHub.</p>
      {typeof info?.checkedAt === 'number' && <p>Última verificação: {new Date(info.checkedAt).toLocaleString('pt-BR')}</p>}
      <div className="flex flex-wrap gap-x-4">
        <a href="https://github.com/renatozapelini/Ai" target="_self" rel="noreferrer" className="min-h-[44px] inline-flex items-center gap-1.5 text-emerald-300"><ExternalLink className="w-3.5 h-3.5" />Abrir repositório</a>
        <a href="https://github.com/renatozapelini/Ai/releases" target="_self" rel="noreferrer" className="min-h-[44px] inline-flex items-center gap-1.5 text-emerald-300"><ExternalLink className="w-3.5 h-3.5" />Abrir releases</a>
      </div>
    </div>}
    {expanded && <p className="text-[11px] text-zinc-500">Consulta automática ao abrir e a cada hora. O APK precisa estar publicado em Releases de renatozapelini/Ai. Download e instalação são confirmados por você no Android; não há instalação silenciosa.</p>}
  </section>;
}
