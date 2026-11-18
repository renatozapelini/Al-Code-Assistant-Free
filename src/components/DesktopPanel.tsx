import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Circle,
  FolderOpen,
  Github,
  Loader2,
  LogOut,
  Monitor,
  RefreshCw,
  Save,
  Upload,
} from 'lucide-react';
import { isDesktopApp } from '../utils/platform';
import { isAuthenticated, isServerOnline, logout } from '../utils/authService';

// Tela do computador: pastas locais, diagnóstico e login no GitHub para enviar
// um projeto direto do disco. O token nunca é exibido de volta e fica só nesta
// máquina (a interface só recebe o login e o avatar da conta).

interface StoredProject {
  id: string;
  name: string;
  folder: string;
  updatedAt: number;
  files: number;
}

interface DesktopInfo {
  paths: { projectsDir: string; dataDir: string; logFile: string };
  projects: StoredProject[];
  github: { connected: boolean };
}

interface Viewer {
  login: string;
  name?: string;
  avatarUrl?: string;
}

interface Repo {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  canPush: boolean;
}

interface PushResult {
  repoUrl: string;
  commitUrl: string;
  files: number;
  branch: string;
  created: boolean;
}

interface DesktopPanelProps {
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  projects: { id: string; name: string; files?: number }[];
  onSaveAll: () => Promise<number>;
  onRestoreFromDisk: () => Promise<number>;
}

async function readJson<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(data?.error?.message || `Falha na operação (HTTP ${response.status}).`);
  }
  return data as T;
}

const box = 'rounded-xl border border-zinc-800 bg-[#12151B] p-4 sm:p-5';
const button = 'inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-700/60 disabled:opacity-50 disabled:cursor-not-allowed';
const primary = 'inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed';

export function DesktopPanel({ apiFetch, projects, onSaveAll, onRestoreFromDisk }: DesktopPanelProps) {
  const desktop = isDesktopApp();
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);

  const [projectId, setProjectId] = useState('');
  const [repoMode, setRepoMode] = useState<'existing' | 'new'>('new');
  const [repoFullName, setRepoFullName] = useState('');
  const [newRepo, setNewRepo] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [pushing, setPushing] = useState(false);
  const [result, setResult] = useState<PushResult | null>(null);
  const [pushError, setPushError] = useState('');

  // Modelos locais (Ollama / LM Studio)
  const [localProviders, setLocalProviders] = useState<{ id: string; provider: string; name: string; baseUrl: string; defaultModel: string; enabled: boolean }[]>([]);
  const [localEnabled, setLocalEnabled] = useState(true);
  const [localBusy, setLocalBusy] = useState(false);

  const loadLocalProviders = useCallback(async () => {
    try {
      const [statusRes, listRes] = await Promise.all([
        readJson<{ enabled: boolean }>(await apiFetch('/api/app/desktop/local-providers-enabled')),
        readJson<{ providers: { id: string; provider: string; name: string; baseUrl: string; defaultModel: string; enabled: boolean }[] }>(await apiFetch('/api/app/desktop/local-providers')),
      ]);
      setLocalEnabled(statusRes.enabled);
      setLocalProviders(Array.isArray(listRes.providers) ? listRes.providers : []);
    } catch {
      // silencioso: modelos locais são opcionais
    }
  }, [apiFetch]);

  const toggleLocal = async (id: string) => {
    setLocalBusy(true);
    try {
      await readJson(await apiFetch(`/api/app/desktop/local-providers/${encodeURIComponent(id)}/toggle`, { method: 'POST' }));
      await loadLocalProviders();
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Não foi possível alternar o modelo local.');
    } finally {
      setLocalBusy(false);
    }
  };

  const toggleLocalGlobal = async () => {
    setLocalBusy(true);
    try {
      const data = await readJson<{ enabled: boolean }>(await apiFetch('/api/app/desktop/local-providers-enabled/toggle', { method: 'POST' }));
      setLocalEnabled(data.enabled);
      await loadLocalProviders();
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Não foi possível alternar modelos locais.');
    } finally {
      setLocalBusy(false);
    }
  };

  useEffect(() => {
    if (!desktop) return;
    void loadLocalProviders();
  }, [apiFetch, desktop, loadLocalProviders]);

  const loadStatus = useCallback(async () => {
    try {
      const data = await readJson<{ connected: boolean }>(await apiFetch('/api/app/desktop/github/status'));
      return data.connected;
    } catch {
      return false;
    }
  }, [apiFetch]);

  const loadRepos = useCallback(async () => {
    setLoadingRepos(true);
    try {
      const data = await readJson<{ repos: Repo[] }>(await apiFetch('/api/app/desktop/github/repos'));
      setRepos(Array.isArray(data.repos) ? data.repos.filter((repo) => repo.canPush) : []);
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Não foi possível listar os repositórios.');
    } finally {
      setLoadingRepos(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    if (!desktop) return;
    const controller = new AbortController();
    (async () => {
      try {
        const data = await readJson<DesktopInfo & { ok: boolean }>(await apiFetch('/api/app/desktop', { signal: controller.signal }));
        setInfo(data);
        const first = data.projects[0]?.id ?? '';
        setProjectId((current) => current || first);
        setStored(data.projects.map((p) => ({ id: p.id, name: p.name, files: p.files })));
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Não foi possível abrir a pasta de projetos.');
      }
    })();
    void (async () => {
      if (await loadStatus()) await loadRepos();
    })();
    return () => controller.abort();
  }, [apiFetch, desktop, loadStatus, loadRepos]);

  const openFolder = async (target: 'projects' | 'data' | 'logs') => {
    setError('');
    try {
      await readJson(await apiFetch('/api/app/desktop/open-folder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível abrir a pasta.');
    }
  };

  const saveAll = async () => {
    setBusy(true); setError(''); setNote('');
    try {
      const count = await onSaveAll();
      const data = await readJson<DesktopInfo & { ok: boolean }>(await apiFetch('/api/app/desktop'));
      setInfo(data);
      setNote(count ? `${count} projeto(s) gravado(s) na pasta do computador.` : 'Nenhum projeto para gravar ainda.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar os projetos na pasta.');
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true); setError(''); setNote('');
    try {
      const count = await onRestoreFromDisk();
      setNote(count ? `${count} projeto(s) restaurado(s) da pasta.` : 'Nenhum projeto novo na pasta.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível ler os projetos da pasta.');
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    setConnecting(true); setPushError(''); setResult(null);
    try {
      const data = await readJson<{ viewer: Viewer }>(await apiFetch('/api/app/desktop/github/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      }));
      setViewer(data.viewer); setToken('');
      await loadRepos();
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Não foi possível conectar ao GitHub.');
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    try {
      await readJson(await apiFetch('/api/app/desktop/github/disconnect', { method: 'POST' }));
    } finally {
      setViewer(null); setRepos([]); setResult(null); setPushError('');
    }
  };

  const push = async () => {
    const project = info?.projects.find((item) => item.id === projectId) ?? projects.find((item) => item.id === projectId);
    if (!project) { setPushError('Escolha um projeto salvo na pasta do computador.'); return; }
    const chosen = repoMode === 'existing'
      ? repos.find((repo) => repo.fullName === repoFullName)
      : null;
    const owner = chosen ? chosen.owner : viewer?.login ?? '';
    const name = chosen ? chosen.name : newRepo.trim();
    if (!owner || !name) { setPushError('Escolha um repositório ou informe o nome do novo repositório.'); return; }
    const target = `${owner}/${name}`;
    if (!window.confirm(`Enviar "${project.name}" (${project.files} arquivo(s)) para github.com/${target}?\n\nIsso publica o código no GitHub.`)) return;
    setPushing(true); setPushError(''); setResult(null);
    try {
      const report = await readJson<PushResult>(await apiFetch('/api/app/desktop/github/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, owner, repo: name, isPrivate, branch: 'main',
          description: `Projeto ${project.name} criado com Code Assistants.` }),
      }));
      setResult(report);
      await loadRepos();
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'O envio ao GitHub falhou.');
    } finally {
      setPushing(false);
    }
  };

  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);

  const [stored, setStored] = useState<{ id: string; name: string; files: number }[]>(projects);

  const projectOption = (id: string, label: string) => <option key={id} value={id}>{label}</option>;

  return (
    <section className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold text-zinc-100">Este computador</h1>
        <p className="text-xs text-zinc-400">Seus projetos ficam em uma pasta normal do Windows e o envio ao GitHub sai exatamente do que está no disco.</p>
      </header>

      {error && <p className="flex items-start gap-2 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>}
      {note && <p className="flex items-start gap-2 rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200"><Check className="mt-0.5 h-4 w-4 shrink-0" />{note}</p>}

      <div className={box}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-100">Pasta dos projetos</h2>
          <button type="button" className={button} onClick={() => void openFolder('projects')}>
            <FolderOpen className="h-4 w-4" />Abrir no Explorer
          </button>
        </div>
        <p className="mt-2 break-all font-mono text-[11px] text-zinc-400">{info?.paths.projectsDir ?? '…'}</p>
        <p className="mt-1 text-xs text-zinc-500">Cada projeto tem uma subpasta com os arquivos reais e um project.json com o checkpoint da IA (esse arquivo não vai para o GitHub).</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={primary} onClick={() => void saveAll()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Salvar projetos na pasta
          </button>
          <button type="button" className={button} onClick={() => void restore()} disabled={busy}>
            <RefreshCw className="h-4 w-4" />Restaurar da pasta
          </button>
          <span className="text-xs text-zinc-500">{stored.length} projeto(s) na pasta</span>
        </div>
        <div className="mt-4 grid gap-2 text-[11px] text-zinc-500 sm:grid-cols-2">
          <div>
            <p className="text-zinc-400">Dados e chaves</p>
            <p className="break-all font-mono">{info?.paths.dataDir ?? '…'}</p>
            <button type="button" className="mt-1 underline hover:text-zinc-300" onClick={() => void openFolder('data')}>Abrir pasta de dados</button>
          </div>
          <div>
            <p className="text-zinc-400">Log do aplicativo</p>
            <p className="break-all font-mono">{info?.paths.logFile ?? '…'}</p>
            <button type="button" className="mt-1 underline hover:text-zinc-300" onClick={() => void openFolder('logs')}>Abrir pasta do log</button>
          </div>
        </div>
      </div>

      {/* GitHub */}
      <div className={box}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100"><Github className="h-4 w-4" />GitHub</h2>
          {viewer ? (
            <span className="flex items-center gap-2 text-xs text-emerald-300">
              {viewer.avatarUrl && <img src={viewer.avatarUrl} alt="" className="h-5 w-5 rounded-full" />}
              {viewer.login}
              <button type="button" className="text-zinc-400 underline hover:text-zinc-200" onClick={() => void disconnect()}><LogOut className="mr-1 inline h-3 w-3" />Desconectar</button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void connect()}
              className={primary} disabled={connecting}
            >
              {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Github className="h-4 w-4" />}Conectar GitHub
            </button>
          )}
        </div>
        {viewer && <div className="mt-4 space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs text-zinc-400">Projeto na pasta
              <select value={projectId} onChange={(event) => setProjectId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-[#0B0E12] px-3 py-2 text-xs text-zinc-200">
                <option value="">Escolha um projeto</option>
                {stored.map((item) => projectOption(item.id, `${item.name} (${item.files} arquivo${item.files === 1 ? '' : 's'})`))}
              </select>
            </label>
            <label className="text-xs text-zinc-400">Destino
              <select value={repoMode} onChange={(event) => setRepoMode(event.target.value === 'existing' ? 'existing' : 'new')}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-[#0B0E12] px-3 py-2 text-xs text-zinc-200">
                <option value="new">Criar um repositório novo</option>
                <option value="existing">Usar um repositório existente</option>
              </select>
            </label>
          </div>

          {repoMode === 'new' ? <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <label className="text-xs text-zinc-400">Nome do repositório
              <input value={newRepo} onChange={(event) => setNewRepo(event.target.value)} placeholder="meu-projeto"
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-[#0B0E12] px-3 py-2 font-mono text-xs text-zinc-200" />
            </label>
            <label className="flex items-end gap-2 pb-2 text-xs text-zinc-300">
              <input type="checkbox" checked={isPrivate} onChange={(event) => setIsPrivate(event.target.checked)} />Privado
            </label>
          </div> : <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1 text-xs text-zinc-400">Repositório
              <select value={repoFullName} onChange={(event) => setRepoFullName(event.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-[#0B0E12] px-3 py-2 text-xs text-zinc-200">
                <option value="">{loadingRepos ? 'Carregando…' : 'Escolha um repositório'}</option>
                {repos.map((repo) => <option key={repo.fullName} value={repo.fullName}>{repo.fullName}{repo.private ? ' (privado)' : ''}</option>)}
              </select>
            </label>
            <button type="button" className={button} onClick={() => void loadRepos()} disabled={loadingRepos}>
              {loadingRepos ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </button>
          </div>}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={primary} onClick={() => void push()} disabled={pushing || !projectId}>
              {pushing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}Enviar projeto ao GitHub
            </button>
            {pushError && <span className="text-xs text-red-300">{pushError}</span>}
          </div>

          {result && <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">
            <p className="font-medium">{result.created ? 'Repositório criado' : 'Projeto atualizado'} • {result.files} arquivo(s) no branch {result.branch}.</p>
            <p className="mt-1 flex flex-wrap gap-3">
              <a className="underline" href={result.repoUrl} target="_blank" rel="noreferrer">Ver repositório</a>
              <a className="underline" href={result.commitUrl} target="_blank" rel="noreferrer">Ver commit</a>
            </p>
          </div>}
        </div>}
      </div>

      {/* Modelos locais (Ollama / LM Studio) */}
      <div className={box}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Monitor className="h-4 w-4" />Modelos locais (offline)
          </h2>
          <button
            type="button"
            className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium ${localEnabled ? 'bg-emerald-600 text-white' : 'bg-zinc-800/60 text-zinc-400 border border-zinc-700'} hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed`}
            onClick={() => void toggleLocalGlobal()}
            disabled={localBusy}
          >
            {localBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ToggleRight className="h-4 w-4" />}
            {localEnabled ? 'Ativado' : 'Desativado'}
          </button>
        </div>
        <p className="mt-1 text-xs text-zinc-500">Ollama e LM Studio rodam no seu computador, sem chave de API nem internet.</p>

        {!localEnabled && <p className="mt-2 text-xs text-zinc-500">Modelos locais estão desativados. Ative para usar provedores locais.</p>}

        {localEnabled && <div className="mt-3 space-y-2">
          {localProviders.length === 0 && <p className="text-xs text-zinc-500">Nenhum modelo local configurado ainda.</p>}
          {localProviders.map((provider) => (
            <div key={provider.id} className="flex items-center justify-between px-3 py-2 rounded-lg border border-zinc-800/50 bg-[#090B0E]/50 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <Circle className={`h-2 w-2 ${provider.enabled ? 'fill-emerald-400 text-emerald-400' : 'fill-zinc-500 text-zinc-500'}`} aria-hidden="true" />
                <span className="min-w-0 truncate text-zinc-200">{provider.name}</span>
                <span className="text-[10px] text-zinc-500 ml-1">({provider.defaultModel})</span>
              </div>
              <button
                type="button"
                onClick={() => void toggleLocal(provider.id)}
                disabled={localBusy}
                className={`rounded-lg px-2 py-1 text-[10px] ${provider.enabled ? 'bg-emerald-950/30 text-emerald-300 border border-emerald-800/60 hover:bg-emerald-900/40' : 'bg-zinc-900/50 text-zinc-400 border border-zinc-800/60 hover:bg-zinc-800/40'}`}
              >
                {provider.enabled ? 'Ativo' : 'Desativo'}
              </button>
            </div>
          ))}
        </div>}
        {localBusy && <p className="mt-2 text-xs text-zinc-500 flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />Atualizando…</p>}
      </div>
    </section>
  );
}
