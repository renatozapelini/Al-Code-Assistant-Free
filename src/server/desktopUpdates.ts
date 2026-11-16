import express from 'express';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_VERSION } from '../version.ts';

// Atualizador do aplicativo Windows: mesma ideia do APK — consulta os releases
// públicos do GitHub, confere o instalador e só oferece o que é realmente novo.
// Nada de chave, conta ou projeto sai do computador: a única chamada externa é a
// lista pública de releases.

export const RELEASES_URL = 'https://api.github.com/repos/renatozapelini/Al-Code-Assistant-Free/releases?per_page=30';
const REPO = 'https://github.com/renatozapelini/Al-Code-Assistant-Free';
const ASSET_PREFIX = 'Code-Assistants-v';
const ASSET_LIMIT = 200 * 1024 * 1024; // 200 MB: folga para o runtime embutido do Bun.
const BODY_LIMIT = 1024 * 1024;
const SUCCESS_TTL = 3600000;
const FAILURE_TTL = 300000;

export interface UpdateContract {
  ok: boolean;
  currentVersion: string;
  latestVersion?: string;
  available: boolean;
  downloadUrl?: string;
  releaseUrl?: string;
  checkedAt?: number;
  message: string;
  error?: string;
}

export function isDesktopBuild(): boolean {
  return process.env.CODE_ASSISTANTS_DESKTOP === '1';
}

function parts(version: string): number[] | null {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(version);
  if (!match) return null;
  const numbers = match.slice(1).map(Number);
  return numbers.every((value) => Number.isSafeInteger(value)) ? numbers : null;
}

export function compareVersions(a: string, b: string): number {
  const left = parts(a), right = parts(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

export function downloadUrlFor(version: string): string {
  return `${REPO}/releases/download/v${version}/Code-Assistants-v${version}.exe`;
}

export function releaseUrlFor(version: string): string {
  return `${REPO}/releases/tag/v${version}`;
}

function failure(error: string, message: string): UpdateContract {
  return { ok: false, currentVersion: APP_VERSION, available: false, message, error };
}

function validAsset(release: Record<string, unknown>, version: string): { url: string; digest: string } | null {
  const assets = release.assets;
  if (!Array.isArray(assets) || assets.length === 0 || assets.length > 100) return null;
  // O release publica o APK, o código-fonte e o .exe: procuramos o instalador
  // pelo nome exato e exigimos que exista uma única vez.
  const wanted = `${ASSET_PREFIX}${version}.exe`;
  const matches = assets.filter((asset) => asset && typeof asset === 'object' && !Array.isArray(asset)
    && (asset as Record<string, unknown>).name === wanted);
  if (matches.length !== 1) return null;
  const item = matches[0] as Record<string, unknown>;
  if (typeof item.size !== 'number' || !Number.isInteger(item.size) || item.size <= 0 || item.size > ASSET_LIMIT) return null;
  const url = item.browser_download_url;
  if (url !== downloadUrlFor(version)) return null;
  const digest = typeof item.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(item.digest) ? item.digest : '';
  return { url, digest };
}

/**
 * Interpreta a lista pública de releases sem confiar em nada dela: só aceita
 * release estável, tag vX.Y.Z e o instalador canônico do repositório.
 */
export function evaluateReleases(raw: unknown, currentVersion = APP_VERSION, checkedAt = Date.now()): UpdateContract {
  if (!Array.isArray(raw)) return failure('invalid_payload', 'O GitHub respondeu em um formato inesperado; atualização não confirmada.');
  if (raw.length > 100) return failure('invalid_payload', 'Lista de releases maior que o esperado; atualização não confirmada.');
  let best: { version: string; url: string; digest: string } | null = null;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const release = entry as Record<string, unknown>;
    if (release.draft !== false || release.prerelease !== false) continue;
    const tag = release.tag_name;
    if (typeof tag !== 'string' || !tag.startsWith('v')) continue;
    const version = tag.slice(1);
    if (!parts(version)) continue;
    const asset = validAsset(release, version);
    if (!asset) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { version, ...asset };
  }
  if (!best) return failure('no_compatible_installer', 'Nenhum release estável publica Code-Assistants-vX.Y.Z.exe; atualização não confirmada.');
  if (compareVersions(best.version, currentVersion) <= 0) {
    return { ok: true, currentVersion, latestVersion: best.version, available: false, checkedAt,
      message: `Você já está na versão mais nova publicada (${best.version}).` };
  }
  return { ok: true, currentVersion, latestVersion: best.version, available: true,
    downloadUrl: best.url, releaseUrl: releaseUrlFor(best.version), checkedAt,
    message: `Nova versão ${best.version} disponível para o computador.` };
}

interface FetchLike {
  (url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<{ ok: boolean; status: number; headers?: { get?: (name: string) => string | null }; text: () => Promise<string> }>;
}

export class DesktopUpdateService {
  private hit: { at: number; result: UpdateContract } | null = null;
  private digests = new Map<string, string>();
  constructor(private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike, private readonly now: () => number = Date.now) {}

  async check(force = false): Promise<UpdateContract> {
    const cached = this.hit;
    if (cached && !force) {
      const ttl = cached.result.ok ? SUCCESS_TTL : FAILURE_TTL;
      if (this.now() - cached.at < ttl) return { ...cached.result };
    }
    const at = this.now();
    let result: UpdateContract;
    try {
      const response = await this.fetchImpl(RELEASES_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Code-Assistants-Desktop/${APP_VERSION}`, 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        result = failure(`http_${response.status}`, `O GitHub não respondeu (HTTP ${response.status}); tente novamente mais tarde.`);
      } else {
        const text = await response.text();
        if (text.length > BODY_LIMIT) result = failure('body_too_large', 'Resposta do GitHub acima do limite; atualização não confirmada.');
        else {
          let parsed: unknown;
          try { parsed = JSON.parse(text); } catch { parsed = null; }
          if (parsed === null) result = failure('invalid_payload', 'O GitHub respondeu em um formato inesperado; atualização não confirmada.');
          else {
            result = evaluateReleases(parsed, APP_VERSION, at);
            this.collectDigests(parsed);
          }
        }
      }
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      result = failure(timedOut ? 'timeout' : 'unavailable', timedOut
        ? 'O GitHub demorou para responder; tente novamente mais tarde.'
        : 'Não foi possível consultar o GitHub; verifique a conexão.');
    }
    this.hit = { at, result };
    return result;
  }

  private collectDigests(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const release = entry as Record<string, unknown>;
      const tag = release.tag_name;
      if (typeof tag !== 'string' || !tag.startsWith('v')) continue;
      const version = tag.slice(1);
      if (!parts(version)) continue;
      const asset = validAsset(release, version);
      if (asset?.digest) this.digests.set(version, asset.digest);
    }
  }

  digestFor(version: string | undefined): string {
    return version ? this.digests.get(version) ?? '' : '';
  }
}

function updatesDir(): string {
  const base = process.env.LOCALAPPDATA || process.env.QD_DATA_DIR || path.join(os.homedir(), '.qoder2api-hub');
  return path.join(base, 'Code-Assistants', 'updates');
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

const UPDATE_SCRIPT = (newExe: string, currentExe: string, pid: number) => `@echo off
setlocal
set "NEW=${newExe}"
set "CUR=${currentExe}"
for /l %%i in (1,1,120) do (
  tasklist /FI "PID eq ${pid}" /NH 2>nul | find "${pid}" >nul
  if errorlevel 1 goto install
  timeout /t 1 /nobreak >nul
)
:install
copy /y "%NEW%" "%CUR%" >nul 2>nul
if errorlevel 1 (
  start "" "%NEW%"
) else (
  start "" "%CUR%"
)
del "%~f0" >nul 2>nul
`;

/**
 * Baixa o instalador confirmado, confere o tamanho e o sha256 publicado pelo
 * GitHub e prepara a troca do .exe em uso. Só roda no aplicativo empacotado:
 * em desenvolvimento recusa, para nunca sobrescrever o runtime do Bun.
 */
export async function installDesktopUpdate(service: DesktopUpdateService, latestVersion: string): Promise<{ ok: boolean; error?: string; message: string }> {
  if (!isDesktopBuild() || process.platform !== 'win32') {
    return { ok: false, error: 'not_desktop', message: 'A instalação automática só existe no aplicativo Windows; baixe o instalador pelo link.' };
  }
  if (!parts(latestVersion)) return { ok: false, error: 'invalid_version', message: 'Versão recebida inválida.' };
  const update = await service.check(true);
  if (!update.ok || !update.available || update.latestVersion !== latestVersion || !update.downloadUrl) {
    return { ok: false, error: 'not_available', message: 'A atualização não está mais disponível; verifique novamente.' };
  }
  const expected = downloadUrlFor(latestVersion);
  if (update.downloadUrl !== expected) return { ok: false, error: 'invalid_url', message: 'Link de download fora do repositório autorizado.' };
  let response: Response;
  try {
    response = await fetch(expected, { signal: AbortSignal.timeout(60000) });
  } catch {
    return { ok: false, error: 'unavailable', message: 'Não foi possível baixar o instalador; verifique a conexão.' };
  }
  if (!response.ok) return { ok: false, error: `http_${response.status}`, message: `O download falhou (HTTP ${response.status}).` };
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > ASSET_LIMIT) return { ok: false, error: 'too_large', message: 'O instalador é maior que o limite aceito.' };
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > ASSET_LIMIT) return { ok: false, error: 'invalid_size', message: 'O instalador baixado tem tamanho inesperado.' };
  const digest = service.digestFor(latestVersion);
  if (digest && digest !== `sha256:${sha256(buffer)}`) {
    return { ok: false, error: 'digest_mismatch', message: 'O instalador baixado não confere com o arquivo publicado; nada foi trocado.' };
  }
  const dir = updatesDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `Code-Assistants-v${latestVersion}.exe`);
  fs.writeFileSync(target, buffer);
  const script = path.join(dir, `apply-${Date.now().toString(36)}.cmd`);
  fs.writeFileSync(script, UPDATE_SCRIPT(target, process.execPath, process.pid), 'utf8');
  try {
    const child = spawn('cmd.exe', ['/c', 'start', '', '/min', script], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    return { ok: false, error: 'spawn_failed', message: `Instalador baixado em ${target}, mas não foi possível reiniciar automaticamente.` };
  }
  // Fecha o aplicativo em uso para o script poder trocar o .exe; ele reabre em seguida.
  setTimeout(() => process.exit(0), 1500);
  return { ok: true, message: 'Instalador baixado. O aplicativo vai fechar, atualizar e abrir de novo.' };
}

export function createDesktopUpdateRouter(service = new DesktopUpdateService()): express.Router {
  const router = express.Router();
  router.get('/api/app/updates', async (req, res) => {
    const query = Object.keys(req.query);
    if (query.some((key) => key !== 'force') || (req.query.force !== undefined && req.query.force !== '1')) {
      res.status(400).json({ error: { message: 'Use apenas ?force=1 para verificar manualmente.' } });
      return;
    }
    const result = await service.check(req.query.force === '1');
    res.status(result.ok ? 200 : 503).json(result);
    return;
  });
  router.post('/api/app/updates/install', async (req, res) => {
    const version = typeof req.body?.version === 'string' ? req.body.version : '';
    const result = await installDesktopUpdate(service, version);
    res.status(result.ok ? 200 : 409).json(result);
    return;
  });
  return router;
}
