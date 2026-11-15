import express from 'express';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const MAX_FILES = 200;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 120_000;
const SCRIPT_NAMES = ['lint', 'test', 'build'] as const;
const WARNING = 'Isto NÃO é um sandbox: os scripts e o código do projeto executam com suas permissões no sistema e podem acessar arquivos e rede fora desta pasta. Revise o projeto completo e o script exato; execute somente após aprovação explícita. Preparar não instala dependências. Chaves de API, opções de carregamento, arquivos .env e configurações pessoais não são herdados, mas isso não protege contra código malicioso. Hooks automáticos pre/post não são permitidos; o próprio script ainda pode chamar outros programas.';

type Spawner = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export interface ProjectBuildOptions {
  /** Trusted server configuration only; never populated from an HTTP request. */
  dataDir?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => number;
  timeoutMs?: number;
  /** Tests inject a process double; preparation never invokes this. */
  spawn?: Spawner;
}
interface Result { ok: boolean; stdout: string; stderr: string }
interface Tool { available: boolean; executable?: string; version?: string; reason?: string }
interface Prepared {
  token: string;
  revision: number;
  scripts: Readonly<Record<string, string>>;
  workspace: string;
  runtime: string;
  digest: string;
  files: readonly string[];
  directories: ReadonlySet<string>;
  expiresAt: number;
}
class BuildError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function fail(message: string): never { throw new BuildError(400, message); }
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function filePath(value: string): string {
  const normalized = value.normalize('NFC');
  if (!normalized || normalized.length > 512 || Buffer.from(normalized, 'utf8').toString('utf8') !== normalized || normalized.includes('..')
    || /[\\:\x00-\x1f\x7f]/.test(normalized) || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(normalized)) fail('Invalid relative file path.');
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.' || /[<>"|?*]/.test(segment) || /[. ]$/.test(segment)
      || Buffer.byteLength(segment) > 255
      || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)([. ]|$)/i.test(segment)) {
      fail('Invalid or Windows-reserved file name.');
    }
    if (/^(\.git|node_modules|\.ssh|\.aws|\.azure|\.gnupg)$/i.test(segment)
      || /^\.env/i.test(segment)
      || /^\.?(secrets?|credentials?)([._-]|$)/i.test(segment)
      || /^(\.npmrc|\.netrc|\.yarnrc(?:\.yml)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i.test(segment)
      || /\.(pem|key|p12|pfx)$/i.test(segment)
      || /^(service[-_]account)([._-]|$)/i.test(segment)) {
      fail('Git, dependencies, environment files and secret/config files are forbidden.');
    }
  }
  return normalized;
}
function validate(body: unknown) {
  if (!record(body) || typeof body.projectId !== 'string' || !body.projectId.trim()
    || body.projectId.length > 200 || typeof body.name !== 'string' || !body.name.trim()
    || body.name.length > 200 || /[\x00-\x1f\x7f]/.test(body.projectId + body.name)
    || !Number.isSafeInteger(body.revision) || (body.revision as number) < 0 || !record(body.files)) {
    fail('Expected {projectId, name, files: Record<string,string>, revision: nonnegative integer}.');
  }
  const entries = Object.entries(body.files);
  if (entries.length > MAX_FILES) fail('At most 200 files are allowed.');
  const files = new Map<string, Buffer>();
  const aliases = new Map<string, string>();
  const directories = new Set<string>();
  let total = 0;
  for (const [input, value] of entries) {
    const name = filePath(input);
    if (typeof value !== 'string') fail('Every file must contain a string, not a link or file descriptor.');
    if (value.length > MAX_FILE_BYTES) fail('A file exceeds 200 KB.');
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length > MAX_FILE_BYTES) fail('A file exceeds 200 KB.');
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) fail('Files exceed the 2 MB total limit.');
    const segments = name.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      const key = prefix.toUpperCase().toLowerCase();
      if (aliases.has(key) && aliases.get(key) !== prefix) fail('Duplicate normalized/case-insensitive path.');
      aliases.set(key, prefix);
      if (i < segments.length) directories.add(prefix);
    }
    if (files.has(name)) fail('Duplicate normalized file path.');
    files.set(name, bytes);
  }
  for (const name of files.keys()) {
    if (directories.has(name)) fail('A path cannot be both a file and a directory.');
  }
  // A case variant of package.json must not silently hide the manifest on Windows.
  if ([...files.keys()].some(name => name.toLowerCase() === 'package.json' && name !== 'package.json')) {
    fail('The root manifest must be named exactly package.json.');
  }
  const scripts: Record<string, string> = Object.create(null);
  if (files.has('package.json')) {
    let manifest: unknown;
    try { manifest = JSON.parse(files.get('package.json')!.toString('utf8')); }
    catch { fail('package.json is not valid JSON.'); }
    if (!record(manifest)) fail('package.json must be an object.');
    if (manifest.scripts !== undefined && !record(manifest.scripts)) fail('package.json scripts must be an object.');
    if (record(manifest.scripts)) {
      for (const name of SCRIPT_NAMES) {
        if (Object.hasOwn(manifest.scripts, name) && typeof manifest.scripts[name] === 'string') {
          // npm and Bun can otherwise execute unreviewed pre/post scripts automatically.
          if (Object.hasOwn(manifest.scripts, `pre${name}`) || Object.hasOwn(manifest.scripts, `post${name}`)) {
            fail(`Remove pre/post ${name} hooks or fold them into the explicitly reviewed ${name} script.`);
          }
          scripts[name] = manifest.scripts[name];
        }
      }
    }
  }
  return { files, directories, scripts: Object.freeze(scripts), revision: body.revision as number };
}
function digest(files: Map<string, Buffer>): string {
  const hash = createHash('sha256');
  for (const name of [...files.keys()].sort()) {
    const bytes = files.get(name)!;
    hash.update(JSON.stringify([name, bytes.length]) + '\n');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

/** Refuse links/junctions in every ancestor, not just the last path component. */
async function safeDirectory(directory: string, create = false): Promise<void> {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (create) {
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new BuildError(409, 'Workspace ancestors must be real directories, never symlinks/junctions.');
  }
}
async function snapshotFiles(prepared: Prepared): Promise<Map<string, Buffer>> {
  await safeDirectory(prepared.workspace);
  const expected = new Set(prepared.files);
  const files = new Map<string, Buffer>();
  let total = 0;
  async function walk(directory: string, prefix: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new BuildError(409, 'Snapshot contains a symlink/junction. Prepare again.');
      if (stat.isDirectory()) {
        if (!prepared.directories.has(relative)) throw new BuildError(409, 'Snapshot directory set changed. Prepare again.');
        await walk(absolute, relative);
      } else {
        if (!stat.isFile() || stat.nlink !== 1 || !expected.has(relative) || stat.size > MAX_FILE_BYTES) {
          throw new BuildError(409, 'Snapshot file set changed or contains a link. Prepare again.');
        }
        const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.nlink !== 1 || before.ino !== stat.ino || before.dev !== stat.dev || before.size > MAX_FILE_BYTES) {
            throw new BuildError(409, 'Snapshot file changed during verification.');
          }
          // Fixed-size read: a concurrent file growth must not allocate unbounded memory.
          const buffer = Buffer.alloc(before.size + 1);
          let count = 0;
          while (count < buffer.length) {
            const read = await handle.read(buffer, count, buffer.length - count, count);
            if (!read.bytesRead) break;
            count += read.bytesRead;
          }
          const after = await handle.stat();
          if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
            throw new BuildError(409, 'Snapshot file changed during verification.');
          }
          total += count;
          if (total > MAX_TOTAL_BYTES || files.size >= MAX_FILES) throw new BuildError(409, 'Snapshot size limit exceeded.');
          files.set(relative, buffer.subarray(0, count));
        } finally { await handle.close(); }
      }
    }
  }
  await walk(prepared.workspace, '');
  if (files.size !== expected.size || digest(files) !== prepared.digest) throw new BuildError(409, 'Snapshot digest changed. Prepare and review again.');
  return files;
}

function utf8Prefix(buffer: Buffer, limit: number): string {
  let text = buffer.subarray(0, limit).toString('utf8');
  while (Buffer.byteLength(text) > limit) text = text.slice(0, -1);
  return text;
}
function safeEnvironment(host: NodeJS.ProcessEnv, runtime: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null);
  const get = (name: string) => Object.entries(host).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
  const delimiter = platform === 'win32' ? ';' : ':';
  env.PATH = (get('PATH') || '').split(delimiter).filter(value => path.isAbsolute(value) && !/[\x00\r\n]/.test(value)).join(delimiter);
  if (platform === 'win32') {
    for (const key of ['SystemRoot', 'WINDIR']) {
      const value = get(key);
      if (value && path.isAbsolute(value)) env[key] = value;
    }
    env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  }
  env.HOME = env.USERPROFILE = path.join(runtime, 'home');
  env.APPDATA = env.LOCALAPPDATA = path.join(runtime, 'home');
  env.TMPDIR = env.TMP = env.TEMP = path.join(runtime, 'tmp');
  env.npm_config_userconfig = path.join(runtime, 'user.npmrc');
  env.npm_config_globalconfig = path.join(runtime, 'global.npmrc');
  env.npm_config_cache = path.join(runtime, 'npm-cache');
  env.npm_config_ignore_scripts = 'true';
  env.npm_config_update_notifier = env.npm_config_audit = env.npm_config_fund = 'false';
  env.BUN_INSTALL_CACHE_DIR = path.join(runtime, 'bun-cache');
  env.CI = '1';
  env.NO_COLOR = '1';
  return env;
}

/** Always drain both pipes. Keep only a bounded prefix and terminate stalled/noisy children. */
function execute(spawner: Spawner, platform: NodeJS.Platform, executable: string, args: string[], cwd: string,
  env: NodeJS.ProcessEnv, timeoutMs: number, outputLimit = MAX_OUTPUT_BYTES): Promise<Result> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawner(executable, args, { cwd, env, shell: false, windowsHide: true,
        detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { resolve({ ok: false, stdout: '', stderr: 'Unable to launch the selected runtime.' }); return; }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const budget = Math.max(0, outputLimit - 1024);
    let bytes = 0;
    let stopped = false;
    let settled = false;
    let reason = '';
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    function kill(signal: NodeJS.Signals) {
      if (platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, signal); return; } catch { /* Already exited or not grouped. */ }
      }
      try { child.kill(signal); } catch { /* Report the original failure, not OS details. */ }
    }
    function stop(message: string) {
      if (stopped || settled) return;
      stopped = true;
      reason = message;
      // Ask Windows to kill the tree BEFORE killing its root: killing the root first
      // can orphan descendants before taskkill has a chance to enumerate them.
      let treeKillStarted = false;
      if (platform === 'win32' && child.pid && env.SystemRoot) {
        try {
          const killer = spawner(path.join(env.SystemRoot, 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'], { env, shell: false, windowsHide: true, stdio: 'ignore' });
          treeKillStarted = true;
          killer.on('error', () => kill('SIGTERM'));
          killer.on('close', code => { if (code !== 0) kill('SIGTERM'); });
          killer.unref();
        } catch { /* Direct child.kill remains the fallback. */ }
      }
      if (!treeKillStarted) kill('SIGTERM');
      forceTimer = setTimeout(() => kill('SIGKILL'), treeKillStarted ? 250 : 100);
      finishTimer = setTimeout(() => { kill('SIGKILL'); finish(false); }, 500);
    }
    function collect(target: Buffer[], chunk: Buffer | string) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = budget - bytes;
      if (remaining > 0) {
        const kept = buffer.subarray(0, remaining);
        target.push(Buffer.from(kept));
        bytes += kept.length;
      }
      if (buffer.length > remaining) stop('Output exceeded the 1 MB limit; process terminated and output truncated.');
    }
    function finish(ok: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (finishTimer) clearTimeout(finishTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const out = utf8Prefix(Buffer.concat(stdout), budget);
      const err = utf8Prefix(Buffer.concat(stderr), Math.max(0, budget - Buffer.byteLength(out)));
      resolve({ ok: ok && !stopped, stdout: out, stderr: err + (reason ? `\n${reason}` : '') });
    }
    const timer = setTimeout(() => stop(`Script timed out after ${timeoutMs} ms; process terminated.`), timeoutMs);
    child.stdout?.on('data', chunk => collect(stdout, chunk));
    child.stderr?.on('data', chunk => collect(stderr, chunk));
    child.stdout?.on('error', () => stop('Runtime stdout stream failed.'));
    child.stderr?.on('error', () => stop('Runtime stderr stream failed.'));
    child.on('error', () => { reason = 'Unable to launch the selected runtime; it may be missing from this packaged application.'; finish(false); });
    child.on('close', (code, signal) => {
      if (code !== 0 && !reason) reason = `Script failed (${signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`}).`;
      finish(code === 0);
    });
  });
}

/** Mount beneath the existing same-origin management guard; this router adds no CORS/auth bypass. */
export function createProjectBuildRouter(options: ProjectBuildOptions = {}): express.Router {
  const router = express.Router();
  const host = { ...(options.environment ?? process.env) };
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const spawner = options.spawn ?? ((command, args, settings) => spawn(command, args, settings));
  const configuredTimeout = options.timeoutMs ?? MAX_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(configuredTimeout) ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.floor(configuredTimeout))) : MAX_TIMEOUT_MS;
  const base = path.join(path.resolve(options.dataDir ?? (host.QD_DATA_DIR || path.join(process.cwd(), '.qoder2api-data'))), 'project-builds');
  const tokens = new Map<string, Prepared>();

  async function tool(name: 'bun' | 'npm', env: NodeJS.ProcessEnv): Promise<Tool> {
    if (name === 'npm' && platform === 'win32') {
      return { available: false, reason: 'npm.cmd is not a supported shell-free runtime on Windows. Install Bun; no shell fallback is used.' };
    }
    const candidates = (env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
    for (const directory of candidates) {
      // Never discover a generated project executable, even if the host PATH points at staging.
      const relative = path.relative(base, path.resolve(directory));
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) continue;
      const executable = path.join(directory, platform === 'win32' ? `${name}.exe` : name);
      try {
        if (!(await fs.stat(executable)).isFile()) continue;
        await fs.access(executable, constants.X_OK);
      } catch { continue; }
      const result = await execute(spawner, platform, executable, ['--version'], directory, env, 2000, 4096);
      const version = result.stdout.trim();
      if (result.ok && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) return { available: true, executable, version };
      return { available: false, reason: `${name} was found but its version probe failed. The external toolchain may be unavailable in this packaged application.` };
    }
    return { available: false, reason: `${name} was not found as an external executable on the server PATH. A compiled Hub EXE is not a project toolchain.` };
  }
  async function capabilities(runtime = path.join(base, '.probe')) {
    const env = safeEnvironment(host, runtime, platform);
    const [bun, npm] = await Promise.all([tool('bun', env), tool('npm', env)]);
    return { platform, bun, npm, runtime: bun.available ? 'bun' as const : npm.available ? 'npm' as const : null, warning: WARNING };
  }
  function sendError(res: express.Response, error: unknown) {
    res.status(error instanceof BuildError ? error.status : 500).json({ error: {
      message: error instanceof BuildError ? error.message : 'Unable to prepare or verify the private project snapshot.' } });
  }

  router.get('/capabilities', async (_req, res) => {
    try { res.json(await capabilities()); }
    catch { res.status(503).json({ platform, bun: { available: false }, npm: { available: false }, runtime: null, warning: WARNING, error: { message: 'External toolchain detection failed.' } }); }
  });
  router.post('/prepare', async (req, res) => {
    let temporary: string | undefined;
    let committed: string | undefined;
    try {
      const validated = validate(req.body);
      for (const [key, value] of tokens) if (value.expiresAt <= now()) tokens.delete(key);
      if (tokens.size >= 100) throw new BuildError(429, 'Too many pending reviews; use or expire existing tokens first.');
      await safeDirectory(base, true);
      const id = randomUUID();
      temporary = path.join(base, `.prepare-${id}`);
      const destination = path.join(base, id);
      await fs.mkdir(temporary, { mode: 0o700 });
      const workspace = path.join(temporary, 'workspace');
      const runtime = path.join(temporary, 'runtime');
      await fs.mkdir(workspace, { mode: 0o700 });
      await fs.mkdir(runtime, { mode: 0o700 });
      for (const directory of ['home', 'tmp', 'npm-cache', 'bun-cache']) await fs.mkdir(path.join(runtime, directory), { mode: 0o700 });
      for (const config of ['user.npmrc', 'global.npmrc']) await fs.writeFile(path.join(runtime, config), '', { flag: 'wx', mode: 0o600 });
      for (const [name, bytes] of validated.files) {
        const absolute = path.join(workspace, ...name.split('/'));
        await safeDirectory(path.dirname(absolute), true);
        await fs.writeFile(absolute, bytes, { flag: 'wx', mode: 0o600 });
      }
      const prepared: Prepared = Object.freeze({ token: randomBytes(32).toString('hex'), revision: validated.revision,
        scripts: validated.scripts, workspace, runtime, digest: digest(validated.files),
        files: Object.freeze([...validated.files.keys()]), directories: validated.directories, expiresAt: now() + TOKEN_TTL_MS });
      await snapshotFiles(prepared);
      await safeDirectory(base);
      await fs.rename(temporary, destination); // Publish the complete snapshot in one same-volume rename.
      committed = destination;
      temporary = undefined;
      const published = Object.freeze({ ...prepared, workspace: path.join(destination, 'workspace'), runtime: path.join(destination, 'runtime') });
      tokens.set(published.token, published);
      res.json({ token: published.token, revision: published.revision, scripts: published.scripts,
        warning: WARNING + (Object.keys(published.scripts).length ? '' : ' No runnable lint/test/build string scripts were found in root package.json.'), workspace: published.workspace });
      committed = undefined;
    } catch (error) {
      // These paths are generated here, never supplied by the caller.
      for (const directory of [temporary, committed]) if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      sendError(res, error);
    }
  });
  router.post('/run', async (req, res) => {
    const body: unknown = req.body;
    if (!record(body) || typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) {
      res.status(400).json({ ok: false, stdout: '', stderr: 'A valid preparation token is required.', workspace: '' });
      return;
    }
    const prepared = tokens.get(body.token);
    // Consume synchronously, before any await: concurrent requests cannot run this token twice.
    tokens.delete(body.token);
    if (!prepared) {
      res.status(410).json({ ok: false, stdout: '', stderr: 'Token is unknown, already used, or expired. Prepare and review again.', workspace: '' });
      return;
    }
    const reply = (status: number, result: Result) => res.status(status).json({ ...result, workspace: prepared.workspace });
    if (prepared.expiresAt <= now()) { reply(410, { ok: false, stdout: '', stderr: 'Review token expired after 10 minutes. Prepare and review again.' }); return; }
    if (typeof body.script !== 'string' || !SCRIPT_NAMES.includes(body.script as typeof SCRIPT_NAMES[number])
      || !Object.hasOwn(prepared.scripts, body.script)) {
      reply(400, { ok: false, stdout: '', stderr: 'Choose exactly one reviewed lint, test, or build script from this preparation.' }); return;
    }
    try {
      const started = Date.now();
      await snapshotFiles(prepared);
      await safeDirectory(prepared.runtime);
      // Recheck runtime config too: a local link must never redirect a config/cache write into host state.
      for (const directory of ['home', 'tmp', 'npm-cache', 'bun-cache']) await safeDirectory(path.join(prepared.runtime, directory));
      for (const config of ['user.npmrc', 'global.npmrc']) {
        const stat = await fs.lstat(path.join(prepared.runtime, config));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 0) throw new BuildError(409, 'Private runtime config changed. Prepare again.');
      }
      const detected = await capabilities(prepared.runtime);
      if (!detected.runtime) {
        reply(503, { ok: false, stdout: '', stderr: `No supported external project toolchain is available. ${detected.bun.reason} ${detected.npm.reason}` }); return;
      }
      // Probing must not leave a window in which a changed snapshot goes unnoticed.
      await snapshotFiles(prepared);
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) { reply(408, { ok: false, stdout: '', stderr: 'Project run timed out during verification/toolchain detection.' }); return; }
      const executable = detected[detected.runtime].executable!;
      reply(200, await execute(spawner, platform, executable, ['run', body.script], prepared.workspace,
        safeEnvironment(host, prepared.runtime, platform), remaining));
    } catch (error) {
      reply(error instanceof BuildError ? error.status : 409, { ok: false, stdout: '',
        stderr: error instanceof BuildError ? error.message : 'Snapshot verification failed; prepare and review again.' });
    }
  });
  return router;
}
