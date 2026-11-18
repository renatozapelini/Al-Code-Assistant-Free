import express from 'express';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { APP_VERSION } from '../version.ts';
import { appendLog, readLogTail } from './appLog.ts';
import { desktopPaths, ensureDesktopDirs } from './desktopPaths.ts';
import {
  ProjectStorageError,
  deleteProjectFromDisk,
  listProjectsOnDisk,
  readProjectFromDisk,
  saveProjectToDisk,
} from './desktopProjects.ts';
import {
  clearStoredToken,
  friendlyGithubError,
  getViewer,
  hasStoredToken,
  listRepositories,
  pushProjectToGithub,
  readStoredToken,
  storeToken,
  validateToken,
} from './githubPush.ts';
import { addProviderAccount, sanitizeProvider, state, saveState } from './qoderStore.ts';
import type { ProviderPresetId, ExternalProviderAccount, SafeProviderSummary } from '../types/hub.ts';

// Rotas exclusivas do aplicativo do computador: pasta de projetos local,
// diagnóstico e login no GitHub para enviar um projeto. Nada aqui existe no APK.

type FolderTarget = 'projects' | 'data' | 'logs';

function folderFor(target: FolderTarget): string {
  const paths = ensureDesktopDirs();
  if (target === 'data') return paths.dataDir;
  if (target === 'logs') return paths.logsDir;
  return paths.projectsDir;
}

function openFolder(target: FolderTarget): { path: string; opened: boolean } {
  const dir = folderFor(target);
  const command = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(command, [dir], { detached: true, stdio: 'ignore' });
    child.unref();
    appendLog('info', `pasta aberta no sistema: ${target}`);
    return { path: dir, opened: true };
  } catch {
    return { path: dir, opened: false };
  }
}

function statusFor(err: unknown): number {
  if (err instanceof ProjectStorageError) return 400;
  if (err instanceof Error && 'status' in err && typeof (err as { status?: unknown }).status === 'number') {
    const status = (err as { status: number }).status;
    if (status === 401) return 401;
    if (status === 403) return 403;
    if (status === 404) return 404;
  }
  return 400;
}

function fail(res: express.Response, err: unknown, fallback = 'Não foi possível concluir a operação.'): void {
  const message = err instanceof ProjectStorageError ? err.message : friendlyGithubError(err) || fallback;
  res.status(statusFor(err)).json({ ok: false, error: { message } });
}

export function createDesktopRouter(): express.Router {
  const router = express.Router();

  // Os modelos locais (Ollama / LM Studio) não são adicionados automaticamente
  // na inicialização. Eles só são adicionados quando o usuário escolhe adicionar
  // manualmente, evitando erros de "Falhou" quando não estão rodando.
  // ensureLocalProviders(); // desabilitado - usuário adiciona manualmente se quiser

  router.get('/api/app/desktop', (_req, res) => {
    const paths = ensureDesktopDirs();
    res.json({
      ok: true,
      version: APP_VERSION,
      platform: process.platform,
      paths,
      projects: listProjectsOnDisk(),
      github: { connected: hasStoredToken() },
    });
  });

  router.get('/api/app/desktop/diagnostics', (req, res) => {
    const paths = desktopPaths();
    res.json({
      ok: true,
      version: APP_VERSION,
      platform: process.platform,
      arch: process.arch,
      runtime: `bun ${typeof Bun !== 'undefined' ? Bun.version : process.version}`,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      port: req.socket.localPort ?? null,
      paths,
      logTail: readLogTail(120),
    });
  });

  router.post('/api/app/desktop/open-folder', (req, res) => {
    const target = req.body?.target;
    if (target !== 'projects' && target !== 'data' && target !== 'logs') {
      res.status(400).json({ ok: false, error: { message: 'Pasta desconhecida. Use projects, data ou logs.' } });
      return;
    }
    const result = openFolder(target);
    res.status(result.opened ? 200 : 501).json({ ok: result.opened, path: result.path,
      error: result.opened ? undefined : { message: 'Não foi possível abrir o Explorer nesta instalação.' } });
  });

  router.get('/api/app/desktop/projects', (_req, res) => {
    res.json({ ok: true, projects: listProjectsOnDisk() });
  });

  router.get('/api/app/desktop/projects/:id', (req, res) => {
    try {
      const found = readProjectFromDisk(req.params.id);
      if (!found) {
        res.status(404).json({ ok: false, error: { message: 'Projeto não encontrado na pasta do computador.' } });
        return;
      }
      res.json({ ok: true, project: found.project, path: found.path });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/api/app/desktop/projects', (req, res) => {
    try {
      const project = req.body?.project;
      const summary = saveProjectToDisk(project);
      res.json({ ok: true, project: summary });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/api/app/desktop/projects/:id', (req, res) => {
    try {
      const deleted = deleteProjectFromDisk(req.params.id);
      appendLog('info', `projeto removido da pasta local: ${req.params.id} (${deleted ? 'sim' : 'já não existia'})`);
      res.json({ ok: true, deleted });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/api/app/desktop/github/status', async (_req, res) => {
    const token = readStoredToken();
    if (!token) {
      res.json({ ok: true, connected: false });
      return;
    }
    try {
      const viewer = await getViewer(token);
      res.json({ ok: true, connected: true, viewer });
    } catch (err) {
      if (err instanceof Error && 'status' in err && (err as { status?: unknown }).status === 401) {
        clearStoredToken();
        res.json({ ok: true, connected: false, error: { message: 'O token salvo expirou. Conecte novamente.' } });
        return;
      }
      res.json({ ok: true, connected: hasStoredToken(), error: { message: friendlyGithubError(err) } });
    }
  });

  router.post('/api/app/desktop/github/connect', async (req, res) => {
    try {
      const token = validateToken(req.body?.token);
      const viewer = await getViewer(token);
      storeToken(token);
      appendLog('info', `GitHub conectado como ${viewer.login}`);
      res.json({ ok: true, connected: true, viewer });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/api/app/desktop/github/disconnect', (_req, res) => {
    clearStoredToken();
    appendLog('info', 'GitHub desconectado neste computador');
    res.json({ ok: true, connected: false });
  });

  router.get('/api/app/desktop/github/repos', async (_req, res) => {
    const token = readStoredToken();
    if (!token) {
      res.status(401).json({ ok: false, error: { message: 'Conecte sua conta do GitHub primeiro.' } });
      return;
    }
    try {
      res.json({ ok: true, repos: await listRepositories(token) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/api/app/desktop/github/push', async (req, res) => {
    const token = readStoredToken();
    if (!token) {
      res.status(401).json({ ok: false, error: { message: 'Conecte sua conta do GitHub primeiro.' } });
      return;
    }
    try {
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
      const found = readProjectFromDisk(projectId);
      if (!found) {
        res.status(404).json({ ok: false, error: { message: 'Salve o projeto na pasta do computador antes de enviar.' } });
        return;
      }
      const report = await pushProjectToGithub({
        token,
        owner: req.body?.owner,
        repo: req.body?.repo,
        isPrivate: req.body?.isPrivate === true,
        branch: req.body?.branch,
        description: req.body?.description,
        project: found.project,
      });
      appendLog('info', `projeto ${projectId} enviado ao GitHub (${report.repoUrl}, ${report.files} arquivos)`);
      res.json(report);
    } catch (err) {
      appendLog('warn', `envio ao GitHub recusado: ${friendlyGithubError(err)}`);
      fail(res, err);
    }
  });

  // ----- Modelos locais pré-instalados (Ollama / LM Studio) -----
  // Garante que os provedores locais existam no estado. São adicionados apenas
  // se ainda não houver um provedor com o mesmo provider+baseUrl.
  function ensureLocalProviders(): SafeProviderSummary[] {
    const locals: { provider: ProviderPresetId; name: string; baseUrl: string; defaultModel: string }[] = [
      { provider: 'ollama', name: 'Ollama (Local)', baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'qwen2.5-coder:7b' },
      { provider: 'lmstudio', name: 'LM Studio (Local)', baseUrl: 'http://127.0.0.1:1234/v1', defaultModel: 'qwen2.5-coder-14b-instruct' },
    ];
    const result: SafeProviderSummary[] = [];
    for (const item of locals) {
      const already = state.providers.find(
        (p: ExternalProviderAccount) => p.provider === item.provider && p.baseUrl === item.baseUrl
      );
      if (!already) {
        const created = addProviderAccount({
          provider: item.provider,
          name: item.name,
          baseUrl: item.baseUrl,
          defaultModel: item.defaultModel,
        });
        result.push(created);
      } else {
        result.push(sanitizeProvider(already));
      }
    }
    return result;
  }

  router.get('/api/app/desktop/local-providers', (_req, res) => {
    if (!state.localProvidersLinuxEnabled) {
      res.json({ ok: true, providers: [] });
      return;
    }
    const ensured = ensureLocalProviders();
    const locals = state.providers.filter(
      (p: ExternalProviderAccount) => p.provider === 'ollama' || p.provider === 'lmstudio'
    );
    res.json({
      ok: true,
      providers: locals.map((p: ExternalProviderAccount) => ({ id: p.id, provider: p.provider, name: p.name, baseUrl: p.baseUrl, defaultModel: p.defaultModel, enabled: p.enabled })),
    });
  });

  router.post('/api/app/desktop/local-providers/:id/toggle', (req, res) => {
    const id = req.params.id;
    const provider = state.providers.find((p: ExternalProviderAccount) => p.id === id && (p.provider === 'ollama' || p.provider === 'lmstudio'));
    if (!provider) {
      res.status(404).json({ ok: false, error: { message: 'Provedor local não encontrado.' } });
      return;
    }
    provider.enabled = !provider.enabled;
    saveState();
    appendLog('info', `provedor local ${provider.provider} ${provider.enabled ? 'ativado' : 'desativado'}`);
    res.json({ ok: true, id, enabled: provider.enabled });
  });

  // ----- Toggle global de modelos locais Linux -----
  router.get('/api/app/desktop/local-providers-enabled', (_req, res) => {
    res.json({ ok: true, enabled: state.localProvidersLinuxEnabled });
  });

  router.post('/api/app/desktop/local-providers-enabled/toggle', (_req, res) => {
    state.localProvidersLinuxEnabled = !state.localProvidersLinuxEnabled;
    saveState();

    // Quando desativado, desliga todos os provedores locais. Quando ativado,
    // garante que eles existam no estado.
    if (!state.localProvidersLinuxEnabled) {
      for (const p of state.providers) {
        if (p.provider === 'ollama' || p.provider === 'lmstudio') {
          p.enabled = false;
        }
      }
    } else {
      ensureLocalProviders();
    }
    saveState();

    appendLog('info', `modelos locais Linux ${state.localProvidersLinuxEnabled ? 'ativados' : 'desativados'}`);
    res.json({ ok: true, enabled: state.localProvidersLinuxEnabled });
  });

  return router;
}

/** Só para o diagnóstico: informa se a pasta de projetos existe sem criá-la. */
export function projectsFolderExists(): boolean {
  try {
    return fs.existsSync(desktopPaths().projectsDir);
  } catch {
    return false;
  }
}
