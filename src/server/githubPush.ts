import fs from 'node:fs';
import path from 'node:path';
import { errorMessage, logError } from './appLog.ts';
import { dataDir } from './desktopPaths.ts';
import { ProjectStorageError, validateProjectFilePaths } from './desktopProjects.ts';

// Login no github.com pelo próprio aplicativo. O usuário cola um token pessoal
// (fine-grained ou clássico) na tela do computador; o token fica só nesta
// máquina, com permissão restrita, e nunca volta para a interface nem para o log.
// O envio usa a API de Git Data, então não precisa de git instalado.

const API = 'https://api.github.com';
const TOKEN_MIN = 20;
const TOKEN_MAX = 255;
const REQUEST_TIMEOUT_MS = 20000;
const CONCURRENCY = 6;

export class GithubRequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'GithubRequestError';
  }
}

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type GithubFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<HttpResponseLike>;

export interface GithubViewer {
  login: string;
  name?: string;
  avatarUrl?: string;
}

export interface GithubRepository {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  canPush: boolean;
}

export interface PushReport {
  ok: true;
  created: boolean;
  branch: string;
  files: number;
  repoUrl: string;
  commitUrl: string;
}

function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}

function headers(token?: string, body = false): Record<string, string> {
  const result: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Code-Assistants-Desktop',
  };
  if (token) result.Authorization = `Bearer ${token}`;
  if (body) result['Content-Type'] = 'application/json';
  return result;
}

async function send(
  fetchImpl: GithubFetch,
  token: string,
  method: string,
  route: string,
  body?: unknown
): Promise<unknown> {
  let response: HttpResponseLike;
  try {
    response = await fetchImpl(`${API}${route}`, {
      method,
      headers: headers(token, body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GithubRequestError(0, `Não foi possível falar com o GitHub (${errorMessage(err)}). Verifique a conexão.`);
  }
  const raw = await response.text();
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  if (!response.ok) {
    const message = typeof data.message === 'string' && data.message ? data.message.slice(0, 300) : `HTTP ${response.status}`;
    throw new GithubRequestError(response.status, message);
  }
  return parsed;
}

async function request(
  fetchImpl: GithubFetch,
  token: string,
  method: string,
  route: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  const parsed = await send(fetchImpl, token, method, route, body);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

async function requestList(
  fetchImpl: GithubFetch,
  token: string,
  method: string,
  route: string
): Promise<unknown[]> {
  const parsed = await send(fetchImpl, token, method, route);
  return Array.isArray(parsed) ? parsed : [];
}

export function validateToken(value: unknown): string {
  const token = typeof value === 'string' ? value.trim() : '';
  if (token.length < TOKEN_MIN || token.length > TOKEN_MAX || !/^[A-Za-z0-9_]+$/.test(token)) {
    throw new Error('Token do GitHub inválido. Cole o token completo (ghp_… ou github_pat_…).');
  }
  return token;
}

function tokenFile(): string {
  return path.join(dataDir(), 'github-token.json');
}

export function hasStoredToken(): boolean {
  if (process.env.CODE_ASSISTANTS_GITHUB_TOKEN) return true;
  try {
    return fs.existsSync(tokenFile());
  } catch {
    return false;
  }
}

export function readStoredToken(): string {
  const fromEnv = process.env.CODE_ASSISTANTS_GITHUB_TOKEN;
  if (fromEnv) {
    try {
      return validateToken(fromEnv);
    } catch {
      return '';
    }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(tokenFile(), 'utf8')) as { token?: unknown };
    return typeof raw.token === 'string' ? validateToken(raw.token) : '';
  } catch {
    return '';
  }
}

export function storeToken(token: unknown): void {
  const valid = validateToken(token);
  const file = tokenFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ token: valid, savedAt: Date.now() }), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows não usa permissões POSIX; a pasta do usuário já é restrita.
  }
}

export function clearStoredToken(): void {
  try {
    fs.rmSync(tokenFile(), { force: true });
  } catch (err) {
    logError('remover token do GitHub', err);
  }
}

export async function getViewer(token: string, fetchImpl: GithubFetch = defaultFetch as GithubFetch): Promise<GithubViewer> {
  const data = await request(fetchImpl, token, 'GET', '/user');
  if (typeof data.login !== 'string' || !data.login) throw new GithubRequestError(401, 'O GitHub não identificou esta conta.');
  return {
    login: data.login,
    name: typeof data.name === 'string' ? data.name : undefined,
    avatarUrl: typeof data.avatar_url === 'string' ? data.avatar_url : undefined,
  };
}

export async function listRepositories(token: string, fetchImpl: GithubFetch = defaultFetch as GithubFetch): Promise<GithubRepository[]> {
  const raw = await requestList(fetchImpl, token, 'GET', '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator');
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      owner: String((item.owner as Record<string, unknown> | undefined)?.login ?? ''),
      name: String(item.name ?? ''),
      fullName: String(item.full_name ?? ''),
      private: item.private === true,
      defaultBranch: typeof item.default_branch === 'string' ? item.default_branch : 'main',
      htmlUrl: typeof item.html_url === 'string' ? item.html_url : '',
      canPush: (item.permissions as Record<string, unknown> | undefined)?.push !== false,
    }))
    .filter((repo) => repo.owner && repo.name && repo.fullName);
}

export function validateOwner(value: unknown): string {
  const owner = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) throw new Error('Conta do GitHub inválida.');
  return owner;
}

export function validateRepoName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name.startsWith('.') || name === '.' || name === '..') {
    throw new Error('Nome do repositório inválido.');
  }
  return name;
}

/** Converte o nome do projeto em um nome de repositório aceito pelo GitHub. */
export function repoNameFromProject(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return slug || 'code-assistants-projeto';
}

function validateBranch(value: unknown): string {
  const branch = typeof value === 'string' && value.trim() ? value.trim() : 'main';
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.includes('..') || branch.startsWith('/')
    || branch.endsWith('/') || branch.endsWith('.')) {
    throw new Error('Branch inválida. Use main ou um nome simples.');
  }
  return branch;
}

function repoRoute(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export interface PushInput {
  owner: string;
  repo: string;
  isPrivate: boolean;
  description?: string;
  branch?: string;
  project: Record<string, unknown>;
  fetchImpl?: GithubFetch;
  token: string;
}

/**
 * Cria o repositório (se ainda não existir) e envia todos os arquivos do
 * projeto como um único commit, direto pela API do GitHub.
 */
export async function pushProjectToGithub(input: PushInput): Promise<PushReport> {
  const fetchImpl = (input.fetchImpl ?? defaultFetch) as GithubFetch;
  const token = validateToken(input.token);
  const owner = validateOwner(input.owner);
  const name = validateRepoName(input.repo);
  const description = typeof input.description === 'string' ? input.description.slice(0, 350) : undefined;
  const branch = validateBranch(input.branch);
  const files = (input.project?.files ?? {}) as Record<string, string>;
  validateProjectFilePaths(files);
  const paths = Object.keys(files);
  if (paths.length === 0) throw new Error('O projeto ainda não tem arquivos para enviar. Gere ou adicione arquivos primeiro.');

  const viewer = await getViewer(token, fetchImpl);
  let created = false;
  let defaultBranch = branch;
  try {
    const existing = await request(fetchImpl, token, 'GET', repoRoute(owner, name));
    defaultBranch = typeof existing.default_branch === 'string' ? existing.default_branch : branch;
  } catch (err) {
    if (!(err instanceof GithubRequestError) || err.status !== 404) throw err;
    const body = {
      name,
      private: input.isPrivate === true,
      description: description || `Projeto criado com Code Assistants: ${String(input.project.name ?? name)}`,
      auto_init: false,
    };
    try {
      const createdRepo = owner.toLowerCase() === viewer.login.toLowerCase()
        ? await request(fetchImpl, token, 'POST', '/user/repos', body)
        : await request(fetchImpl, token, 'POST', `/orgs/${encodeURIComponent(owner)}/repos`, body);
      created = true;
      defaultBranch = typeof createdRepo.default_branch === 'string' ? createdRepo.default_branch : branch;
    } catch (createErr) {
      if (!(createErr instanceof GithubRequestError) || createErr.status !== 422) throw createErr;
      // Já existia (404 pode ser atraso de permissão); segue tentando o envio.
      const retry = await request(fetchImpl, token, 'GET', repoRoute(owner, name));
      defaultBranch = typeof retry.default_branch === 'string' ? retry.default_branch : branch;
    }
  }

  const targetBranch = input.branch ? branch : defaultBranch;
  let headSha: string | null = null;
  let baseTree: string | undefined;
  try {
    const ref = await request(fetchImpl, token, 'GET', `${repoRoute(owner, name)}/git/ref/heads/${targetBranch.split('/').map(encodeURIComponent).join('/')}`);
    const object = ref.object as Record<string, unknown> | undefined;
    if (object && typeof object.sha === 'string') {
      headSha = object.sha;
      const commit = await request(fetchImpl, token, 'GET', `${repoRoute(owner, name)}/git/commits/${headSha}`);
      const tree = commit.tree as Record<string, unknown> | undefined;
      if (tree && typeof tree.sha === 'string') baseTree = tree.sha;
    }
  } catch (err) {
    // Repositório novo/ainda vazio: o primeiro commit não tem pai.
    if (!(err instanceof GithubRequestError) || (err.status !== 404 && err.status !== 409)) throw err;
  }

  const blobShas = new Array<string>(paths.length);
  for (let start = 0; start < paths.length; start += CONCURRENCY) {
    const slice = paths.slice(start, start + CONCURRENCY);
    await Promise.all(slice.map(async (filePath, index) => {
      const blob = await request(fetchImpl, token, 'POST', `${repoRoute(owner, name)}/git/blobs`, {
        content: Buffer.from(files[filePath], 'utf8').toString('base64'),
        encoding: 'base64',
      });
      if (typeof blob.sha !== 'string') throw new Error(`O GitHub não confirmou o arquivo ${filePath}.`);
      blobShas[start + index] = blob.sha;
    }));
  }

  const treeBody: Record<string, unknown> = {
    tree: paths.map((filePath, index) => ({ path: filePath, mode: '100644', type: 'blob', sha: blobShas[index] })),
  };
  if (baseTree) treeBody.base_tree = baseTree;
  const tree = await request(fetchImpl, token, 'POST', `${repoRoute(owner, name)}/git/trees`, treeBody);
  if (typeof tree.sha !== 'string') throw new Error('O GitHub não confirmou a árvore de arquivos.');
  const commit = await request(fetchImpl, token, 'POST', `${repoRoute(owner, name)}/git/commits`, {
    message: `Code Assistants: ${String(input.project.name ?? name)} (${paths.length} arquivo${paths.length === 1 ? '' : 's'})`,
    tree: tree.sha,
    parents: headSha ? [headSha] : [],
  });
  if (typeof commit.sha !== 'string') throw new Error('O GitHub não confirmou o commit.');
  const refPath = `${repoRoute(owner, name)}/git/refs/heads/${targetBranch.split('/').map(encodeURIComponent).join('/')}`;
  try {
    await request(fetchImpl, token, headSha ? 'PATCH' : 'POST', refPath, { sha: commit.sha, force: false });
  } catch (err) {
    if (err instanceof GithubRequestError && err.status === 422 && headSha) {
      await request(fetchImpl, token, 'PATCH', refPath, { sha: commit.sha, force: true });
    } else {
      throw err;
    }
  }

  return {
    ok: true,
    created,
    branch: targetBranch,
    files: paths.length,
    repoUrl: `https://github.com/${owner}/${name}`,
    commitUrl: `https://github.com/${owner}/${name}/commit/${commit.sha}`,
  };
}

export function friendlyGithubError(err: unknown): string {
  if (err instanceof GithubRequestError) {
    if (err.status === 401) return 'O token foi recusado pelo GitHub. Gere outro token ou confira se ele expirou.';
    if (err.status === 403) return 'O GitHub recusou a operação (limite de requisições ou falta de permissão para criar repositórios).';
    if (err.status === 404) return 'Repositório ou conta não encontrados, ou o token não tem permissão de escrita.';
    if (err.status === 422) return `O GitHub recusou os dados (${err.message}).`;
    return `O GitHub respondeu ${err.status}: ${err.message}`;
  }
  if (err instanceof ProjectStorageError) return err.message;
  return errorMessage(err);
}
