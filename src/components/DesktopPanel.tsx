import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  FolderOpen,
  Github,
  Loader2,
  LogOut,
  RefreshCw,
  Save,
  Upload,
} from 'lucide-react';
import { isDesktopApp } from '../utils/platform';

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
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
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

  const loadStatus = useCallback(async () => {
    try {
      const data = await readJson<{ connected: boolean; viewer?: Viewer; error?: { message?: string } }>(
        await apiFetch('/api/app/desktop/github/status')
      );
      setViewer(data.connected && data.viewer ? data.viewer : null);
      if (data.error?.message) setPushError(data.error.message);
      return data.connected;
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Não foi possível falar com o GitHub.');
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

  if (!desktop) {
    return <section className={box}>
      <h2 className="text-base font-semibold text-zinc-100">Este computador</h2>
      <p className="mt-2 text-xs text-zinc-400">Pastas locais e login no GitHub estão disponíveis no aplicativo do Windows. No APK, use Exportar ZIP na área de arquivos do projeto.</p>
    </section>;
  }

  const connected = Boolean(viewer);
  const stored = info?.projects ?? [];
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

      <div className={box}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100"><Github className="h-4 w-4" />GitHub</h2>
          {connected && <span className="flex items-center gap-2 text-xs text-emerald-300">
            {viewer?.avatarUrl && <img src={viewer.avatarUrl} alt="" className="h-5 w-5 rounded-full" />}
            {viewer?.login}
            <button type="button" className="text-zinc-400 underline hover:text-zinc-200" onClick={() => void disconnect()}><LogOut className="mr-1 inline h-3 w-3" />Desconectar</button>
          </span>}
        </div>
        <p className="mt-1 text-xs text-zinc-500">Cole um token pessoal com permissão de repositórios. O token fica só neste computador; nada é enviado sem você confirmar.</p>

        {!connected && <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            type="password" value={token} onChange={(event) => setToken(event.target.value)}
            placeholder="ghp_… ou github_pat_…" autoComplete="off" spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-[#0B0E12] px-3 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-emerald-600"
          />
          <button type="button" className={primary} onClick={() => void connect()} disabled={connecting || token.trim().length < 20}>
            {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Github className="h-4 w-4" />}Conectar
          </button>
        </div>}
        {!connected && <p className="mt-2 text-[11px] text-zinc-500">Como criar: github.com → Settings → Developer settings → Personal access tokens → Fine-grained token, com acesso ao repositório e permissão “Contents: Read and write”.</p>}

        {connected && <div className="mt-4 space-y-3">
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
    </section>
  );
}
