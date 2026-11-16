import { useCallback, useEffect, useState } from 'react';
import { Download, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import { APP_VERSION } from '../version';
import { androidBridge } from '../utils/androidBridge';
import { isDesktopApp } from '../utils/platform';

export { APP_VERSION };
interface UpdateInfo {
  ok: boolean; currentVersion: string; latestVersion?: string; available: boolean;
  downloadUrl?: string; releaseUrl?: string; checkedAt?: number; message?: string;
}
type AssetExtension = 'apk' | 'exe';

function expectedDownload(version: string, ext: AssetExtension): string[] {
  const base = `https://github.com/renatozapelini/Al-Code-Assistant-Free/releases/download`;
  return [
    `${base}/v${version}/Code-Assistants-v${version}.${ext}`,
    `${base}/${version}/Code-Assistants-v${version}.${ext}`,
  ];
}

export function validateUpdateInfo(value: unknown, ext: AssetExtension = isDesktopApp() ? 'exe' : 'apk'): UpdateInfo {
  if (!value || typeof value !== 'object') throw new Error('Resposta de atualização inválida.');
  const data = value as UpdateInfo;
  if (typeof data.ok !== 'boolean' || typeof data.available !== 'boolean' || data.currentVersion !== APP_VERSION) throw new Error('Resposta de atualização incompatível.');
  if (data.available) {
    if (!data.ok || typeof data.latestVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(data.latestVersion)) throw new Error('Versão de atualização inválida.');
    const current = APP_VERSION.split('.').map(Number), latest = data.latestVersion.split('.').map(Number);
    const first = latest.findIndex((n, i) => n !== current[i]);
    if (latest.some(n => !Number.isSafeInteger(n)) || first < 0 || latest[first] < current[first]) throw new Error('A versão recebida não é mais nova.');
    const allowed = expectedDownload(data.latestVersion, ext);
    if (!allowed.includes(data.downloadUrl ?? '')) throw new Error(`Link de instalação (.${ext}) fora do repositório autorizado.`);
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
  const [installing, setInstalling] = useState(false);
  const [installNote, setInstallNote] = useState('');
  const desktop = isDesktopApp();
  const android = Boolean(androidBridge());
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
  const install = useCallback(async () => {
    if (!info?.latestVersion || installing) return;
    setInstalling(true); setInstallNote('');
    try {
      const res = await apiFetch('/api/app/updates/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: info.latestVersion }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; message?: string } | null;
      setInstallNote(data?.message || (res.ok ? 'Instalador baixado.' : 'Não foi possível instalar agora.'));
    } catch {
      setInstallNote('Não foi possível baixar o instalador; use o link direto.');
    } finally { setInstalling(false); }
  }, [apiFetch, info?.latestVersion, installing]);
  return <section aria-label="Atualizações do aplicativo" className="rounded-xl border border-zinc-800 bg-[#12151B] p-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-3 min-w-0">
        <img src="/pwa-192x192.png" alt="Code Assistants" width={40} height={40} className="h-10 w-10 shrink-0 rounded-xl border border-zinc-800 bg-[#090B0E]" />
        <div className="min-w-0 space-y-0.5">
          <h2 className="font-semibold text-sm">{info?.available ? `Nova versão ${info.latestVersion} disponível` : `Code Assistants ${APP_VERSION}`}{desktop && <span className="ml-1.5 font-normal text-zinc-500">· Windows</span>}</h2>
          <p role="status" className="flex items-center gap-1.5 text-xs text-zinc-400"><RefreshCw className={`h-3.5 w-3.5 shrink-0 ${busy ? 'animate-spin text-emerald-300' : 'text-zinc-500'}`} aria-hidden="true" /><span className="min-w-0">{error || info?.message || 'Consultando releases do GitHub…'}</span></p>
        </div>
      </div>
      {expanded && <button type="button" disabled={busy} onClick={() => void check(undefined, true)} className="min-h-[44px] flex items-center gap-2 text-xs text-emerald-300 disabled:opacity-50"><RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />{busy ? 'Verificando…' : 'Verificar atualização'}</button>}
    </div>
    {info?.available && <div className="flex flex-wrap items-center gap-2">
      {desktop ? <>
        <button type="button" disabled={installing} onClick={() => void install()} className="min-h-[44px] inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 text-xs font-semibold text-zinc-950 disabled:opacity-60"><Download className="w-4 h-4" />{installing ? 'Baixando instalador…' : 'Atualizar agora'}</button>
        <a href={info.downloadUrl} target="_self" rel="noreferrer" className="min-h-[44px] inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 text-xs font-semibold text-zinc-200">Baixar .exe direto</a>
      </> : <a href={info.downloadUrl} target="_self" rel="noreferrer" className="min-h-[44px] inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 text-xs font-semibold text-zinc-950"><Download className="w-4 h-4" />Baixar novo APK</a>}
    </div>}
    {installNote && <p className="text-xs text-emerald-300">{installNote}</p>}
    {expanded && <div className="rounded-lg border border-zinc-800 bg-[#090B0E] p-3 space-y-1.5 text-[11px] text-zinc-400">
      <p className="text-xs font-semibold text-zinc-200">GitHub conectado · renatozapelini/Al-Code-Assistant-Free</p>
      <p>Repositório público de releases consultado pelo atualizador. Nenhuma chave, conta ou projeto é enviado ao GitHub.</p>
      {typeof info?.checkedAt === 'number' && <p>Última verificação: {new Date(info.checkedAt).toLocaleString('pt-BR')}</p>}
      <div className="flex flex-wrap gap-x-4">
        <a href="https://github.com/renatozapelini/Al-Code-Assistant-Free" target="_self" rel="noreferrer" className="min-h-[44px] inline-flex items-center gap-1.5 text-emerald-300"><ExternalLink className="w-3.5 h-3.5" />Abrir repositório</a>
        <a href="https://github.com/renatozapelini/Al-Code-Assistant-Free/releases" target="_self" rel="noreferrer" className="min-h-[44px] inline-flex items-center gap-1.5 text-emerald-300"><ExternalLink className="w-3.5 h-3.5" />Abrir releases</a>
      </div>
    </div>}
    {expanded && <p className="text-[11px] text-zinc-500">{desktop
      ? 'Consulta automática ao abrir e a cada hora. Atualizar agora baixa o instalador assinado pelo GitHub e troca o .exe em uso assim que o aplicativo fechar.'
      : 'Consulta automática ao abrir e a cada hora. O APK precisa estar publicado em Releases de renatozapelini/Al-Code-Assistant-Free. Download e instalação são confirmados por você no Android; não há instalação silenciosa.'}</p>}
    {desktop && <p className="flex items-center gap-1.5 text-[11px] text-zinc-500"><ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />Windows pode pedir confirmação do SmartScreen porque o instalador não tem assinatura comercial.</p>}
  </section>;
}
