import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import express from 'express';
import { createProjectBuildRouter, type ProjectBuildOptions } from './projectBuild.ts';

// All project execution AND capability probes use process doubles. Fake executable
// files are empty and are never executed. Only isolated temporary state is read.
interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill(signal?: NodeJS.Signals): boolean;
  unref(): void;
  complete(code: number | null, signal?: NodeJS.Signals): void;
}
interface Invocation { command: string; args: string[]; options: SpawnOptions; child: FakeChild }
interface FixtureOptions extends Omit<ProjectBuildOptions, 'spawn' | 'dataDir' | 'environment'> {
  missing?: boolean;
  badProbe?: boolean;
  linger?: boolean;
  windowsTree?: boolean;
  probe?: () => void;
  run?: (child: FakeChild, invocation: Invocation) => void;
}
async function fixture(t: TestContext, settings: FixtureOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'project-build-test-'));
  const dataDir = path.join(directory, 'data');
  const tools = path.join(directory, 'tools');
  fs.mkdirSync(tools);
  const platform = settings.platform ?? process.platform;
  if (!settings.missing) {
    for (const tool of ['bun', 'npm']) fs.writeFileSync(path.join(tools, platform === 'win32' ? `${tool}.exe` : tool), '', { mode: 0o700 });
  }
  const calls: Invocation[] = [];
  const kills: NodeJS.Signals[] = [];
  let clock = 1_000_000;
  const spawner: NonNullable<ProjectBuildOptions['spawn']> = (command, args, options) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), pid: settings.windowsTree ? 43210 : undefined,
      kill(signal: NodeJS.Signals = 'SIGTERM') {
        kills.push(signal);
        if (!settings.linger) queueMicrotask(() => child.complete(null, signal));
        return true;
      },
      unref() {},
      complete(code: number | null, signal?: NodeJS.Signals) {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', code, signal);
      },
    }) as FakeChild;
    const invocation = { command, args, options, child };
    calls.push(invocation);
    queueMicrotask(() => {
      if (args[0] === '--version') {
        settings.probe?.();
        child.stdout.write(settings.badProbe ? 'I am the Hub, not a runtime' : '1.3.14\n');
        child.complete(0);
      } else if (args[0] === '/PID') {
        child.complete(0);
        calls.find(call => call.args[0] === 'run')?.child.complete(null, 'SIGKILL');
      } else if (settings.run) {
        settings.run(child, invocation);
      } else {
        child.stdout.write('controlled output\n');
        child.stderr.write('controlled diagnostic\n');
        child.complete(0);
      }
    });
    return child as unknown as ChildProcess;
  };
  const app = express();
  app.use(express.json({ limit: '4mb', strict: false }));
  app.use('/project-build', createProjectBuildRouter({ dataDir, platform, spawn: spawner,
    now: settings.now ?? (() => clock), timeoutMs: settings.timeoutMs,
    environment: { PATH: tools, SystemRoot: settings.windowsTree ? path.join(directory, 'fake-windows') : undefined,
      OPENAI_API_KEY: 'dummy-not-a-secret', NODE_OPTIONS: '--invalid-loader',
      BUN_OPTIONS: 'untrusted', HOME: '/never-read-host-home', USERPROFILE: '/never-read-host-home',
      npm_config_userconfig: '/never-read-host-config', QD_DATA_DIR: '/never-use-host-state',
      arbitrarySecret: 'dummy-not-a-secret', LANG: 'test-secret-value' } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/project-build`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function request(route: string, body?: unknown) {
    const response = await fetch(url + route, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any, headers: response.headers };
  }
  return { directory, dataDir, tools, calls, kills, request, advance: (ms: number) => { clock += ms; } };
}
function project(files: Record<string, unknown> = {}, revision = 7) {
  return { projectId: 'user-project', name: 'User Project', revision, files };
}
function manifest(scripts: Record<string, unknown> = { lint: 'tsc --noEmit', test: 'vitest run', build: 'vite build' }) {
  return JSON.stringify({ name: 'user-project', scripts });
}
async function prepare(f: Awaited<ReturnType<typeof fixture>>, files: Record<string, unknown> = { 'package.json': manifest(), 'src/index.ts': 'export const answer = 42;\n' }) {
  const response = await f.request('/prepare', project(files));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

test('preparation exports actual user files atomically without running code or installing dependencies', async t => {
  const f = await fixture(t);
  const response = await prepare(f, { 'package.json': manifest({ build: 'printf reviewed', start: 'not exposed', lint: false, test: 'test command' }), 'src/main.ts': 'hello\n' });
  assert.equal(response.revision, 7);
  assert.match(response.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(response.scripts, { test: 'test command', build: 'printf reviewed' });
  assert.match(response.warning, /NÃO é um sandbox/);
  assert.match(response.warning, /suas permissões no sistema/);
  assert.match(response.warning, /aprovação explícita/);
  assert.match(response.warning, /Preparar não instala dependências/);
  const relative = path.relative(path.join(f.dataDir, 'project-builds'), response.workspace);
  assert.match(relative.replaceAll('\\', '/'), /^[a-f0-9-]{36}\/workspace$/);
  assert.equal(fs.readFileSync(path.join(response.workspace, 'src/main.ts'), 'utf8'), 'hello\n');
  assert.equal(fs.readFileSync(path.join(response.workspace, 'package.json'), 'utf8'), manifest({ build: 'printf reviewed', start: 'not exposed', lint: false, test: 'test command' }));
  assert.equal(f.calls.length, 0, 'prepare must not even probe a runtime');
  const staged = fs.readdirSync(path.join(f.dataDir, 'project-builds'));
  assert.equal(staged.length, 1);
  assert.ok(staged.every(name => !name.startsWith('.prepare-')));
  const second = await prepare(f, { 'package.json': manifest({ build: 'second snapshot' }) });
  assert.notEqual(second.workspace, response.workspace);
  assert.notEqual(second.token, response.token);
  assert.equal(fs.readFileSync(path.join(response.workspace, 'src/main.ts'), 'utf8'), 'hello\n');
});

test('manifest handling exposes only own allowlisted string scripts and no invented build', async t => {
  const f = await fixture(t);
  const empty = await prepare(f, { 'README.txt': 'no manifest' });
  assert.deepEqual(empty.scripts, {});
  assert.match(empty.warning, /No runnable/);
  const other = await prepare(f, { 'package.json': manifest({ lint: '', build: 123, test: null, install: 'do not execute', '__proto__': 'ignored' }) });
  assert.deepEqual(other.scripts, { lint: '' });
  for (const content of ['{', 'null', '[]', '{"scripts":[]}', '{"scripts":null}']) {
    const result = await f.request('/prepare', project({ 'package.json': content }));
    assert.equal(result.status, 400, content);
  }
  for (const hook of ['prebuild', 'postbuild', 'pretest', 'postlint']) {
    const result = await f.request('/prepare', project({ 'package.json': manifest({ build: 'build', test: 'test', lint: 'lint', [hook]: 'unreviewed' }) }));
    assert.equal(result.status, 400);
    assert.match(result.body.error.message, /pre\/post/);
  }
  assert.equal(f.calls.length, 0);
});

test('paths reject traversal, platform aliases, secrets and Windows devices before writing', async t => {
  const f = await fixture(t);
  for (const name of ['', '../escape', 'a/../escape', 'foo..bar', '/tmp/escape', 'C:/escape', 'C:escape',
    'a\\b', '\\\\server\\share', 'a\0b', 'a\nb', './a', 'a//b', 'a/',
    '.git/config', 'NODE_MODULES/a', '.env', '.env.local', 'nested/.ENV.production',
    'secrets/key.txt', '.secrets/key.txt', 'secret.json', 'credentials.json', '.credentials', '.npmrc', '.netrc', '.ssh/config',
    'private.pem', 'id_rsa', 'service-account.json', 'CON', 'nul.txt', 'dir/COM1.ts',
    'LPT9', 'com¹.txt', 'CONOUT$.txt', 'CON .txt', 'trailing.', 'trailing ', 'a?b', 'a*b', 'a|b', 'a<b', 'a"b', 'bad\ud800.txt',
    'a'.repeat(256), 'a/'.repeat(260) + 'file']) {
    const result = await f.request('/prepare', project({ [name]: 'x' }));
    assert.equal(result.status, 400, name);
  }
  assert.equal(fs.existsSync(f.dataDir), false, 'validation failures must not create partial staging');
  assert.equal(f.calls.length, 0);
});

test('case/Unicode normalized duplicates and file-directory collisions are rejected', async t => {
  const f = await fixture(t);
  for (const files of [
    { 'src/a.ts': 'x', 'src/A.ts': 'y' },
    { 'Src/a.ts': 'x', 'src/b.ts': 'y' },
    { 'café.ts': 'x', 'cafe\u0301.ts': 'y' },
    { 'σ.ts': 'x', 'ς.ts': 'y' },
    { 'src': 'x', 'src/a.ts': 'y' },
    { 'src': 'x', 'SRC/a.ts': 'y' },
    { 'PACKAGE.JSON': manifest() },
  ]) {
    const response = await f.request('/prepare', project(files));
    assert.equal(response.status, 400, JSON.stringify(files));
  }
  const accepted = await prepare(f, { 'cafe\u0301.ts': 'NFC' });
  assert.equal(fs.readFileSync(path.join(accepted.workspace, 'café.ts'), 'utf8'), 'NFC');
});

test('request types and byte/file-count boundaries are enforced without coercion', async t => {
  const f = await fixture(t);
  for (const body of [null, [], {}, { ...project(), files: [] }, project({ a: { symlink: '/tmp' } }),
    { ...project(), projectId: '' }, { ...project(), name: 7 }, { ...project(), revision: '1' },
    project({}, -1), project({}, 1.5), project({}, Number.MAX_SAFE_INTEGER + 1)]) {
    assert.equal((await f.request('/prepare', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await f.request('/prepare', project({ a: 'x'.repeat(200 * 1024 + 1) }))).status, 400);
  assert.equal((await f.request('/prepare', project({ a: 'é'.repeat(100 * 1024 + 1) }))).status, 400, 'UTF-8 bytes, not JS length');
  const tooMany = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f${i}`, '']));
  assert.equal((await f.request('/prepare', project(tooMany))).status, 400);
  const exactCount = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`f${i}`, '']));
  await prepare(f, exactCount);
  const exactBytes = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, 'x'.repeat(200 * 1024)]));
  exactBytes.tail = 'x'.repeat(48 * 1024);
  await prepare(f, exactBytes);
  exactBytes.tail += 'x';
  assert.equal((await f.request('/prepare', project(exactBytes))).status, 400);
  assert.equal(f.calls.length, 0);
});

test('capabilities probe real resolved locations, prefer Bun, and never use Windows shell fallback', async t => {
  const f = await fixture(t);
  const result = await f.request('/capabilities');
  assert.equal(result.status, 200);
  assert.equal(result.body.platform, process.platform);
  assert.equal(result.body.bun.available, true);
  assert.equal(result.body.bun.version, '1.3.14');
  assert.equal(result.body.runtime, 'bun');
  assert.equal(result.body.npm.available, process.platform !== 'win32');
  if (process.platform === 'win32') assert.match(result.body.npm.reason, /npm.cmd.*shell-free/);
  for (const call of f.calls) {
    assert.deepEqual(call.args, ['--version']);
    assert.equal(call.options.shell, false);
    assert.equal(path.dirname(call.command), f.tools);
    assert.equal(call.options.env?.OPENAI_API_KEY, undefined);
  }
  assert.equal(result.headers.get('access-control-allow-origin'), null);
  assert.equal(fs.existsSync(f.dataDir), false, 'GET must not stage projects');
});

test('missing or invalid toolchains report honest unavailable status (including packaged EXEs)', async t => {
  for (const settings of [{ missing: true }, { badProbe: true }]) {
    const f = await fixture(t, settings);
    const caps = await f.request('/capabilities');
    assert.equal(caps.body.bun.available, false);
    assert.equal(caps.body.npm.available, false);
    assert.equal(caps.body.runtime, null);
    const prepared = await prepare(f);
    const result = await f.request('/run', { token: prepared.token, script: 'build' });
    assert.equal(result.status, 503);
    assert.equal(result.body.ok, false);
    assert.match(result.body.stderr, /toolchain|packaged|compiled/);
    assert.equal(f.calls.filter(call => call.args[0] === 'run').length, 0);
    assert.equal((await f.request('/run', { token: prepared.token, script: 'build' })).status, 410);
  }
});

test('explicit run uses only reviewed script name with shell:false and isolated allowlisted environment', async t => {
  const f = await fixture(t);
  const prepared = await prepare(f, { 'package.json': manifest({ build: 'reviewed command && arbitrary project code' }) });
  assert.equal(f.calls.length, 0);
  const result = await f.request('/run', { token: prepared.token, script: 'build', workspace: '/must-not-be-used', command: 'must-not-be-used' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, stdout: 'controlled output\n', stderr: 'controlled diagnostic\n', workspace: prepared.workspace });
  const calls = f.calls.filter(call => call.args[0] === 'run');
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(path.basename(call.command), process.platform === 'win32' ? 'bun.exe' : 'bun');
  assert.deepEqual(call.args, ['run', 'build']);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.cwd, prepared.workspace);
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
  const env = call.options.env!;
  for (const key of ['OPENAI_API_KEY', 'NODE_OPTIONS', 'BUN_OPTIONS', 'arbitrarySecret', 'QD_DATA_DIR', 'LANG']) assert.equal(env[key], undefined, key);
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_cache', 'BUN_INSTALL_CACHE_DIR']) {
    assert.ok(env[key]?.startsWith(path.dirname(prepared.workspace) + path.sep), key);
  }
  assert.equal(env.npm_config_ignore_scripts, 'true');
  assert.equal(fs.readFileSync(env.npm_config_userconfig!, 'utf8'), '');
  assert.equal((await f.request('/run', { token: prepared.token, script: 'build' })).status, 410);
});

test('on non-Windows npm is an observed, shell-free fallback rather than an install command', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  fs.unlinkSync(path.join(f.tools, 'bun'));
  const prepared = await prepare(f);
  const result = await f.request('/run', { token: prepared.token, script: 'test' });
  assert.equal(result.body.ok, true);
  const call = f.calls.find(call => call.args[0] === 'run')!;
  assert.equal(path.basename(call.command), 'npm');
  assert.deepEqual(call.args, ['run', 'test']);
  assert.equal(call.options.shell, false);
});

test('Windows reports unavailable when only npm is present instead of invoking a .cmd shell', async t => {
  const f = await fixture(t, { platform: 'win32', missing: true });
  fs.writeFileSync(path.join(f.tools, 'npm.cmd'), 'not executable');
  const prepared = await prepare(f);
  const result = await f.request('/run', { token: prepared.token, script: 'build' });
  assert.equal(result.status, 503);
  assert.match(result.body.stderr, /Windows.*Bun|npm.cmd/);
  assert.equal(f.calls.length, 0);
});

test('tokens are consumed even on invalid script requests and expire at exactly ten minutes', async t => {
  const f = await fixture(t);
  for (const script of ['install', 'start', 'build;whoami', '../build', '--help', '', null]) {
    const prepared = await prepare(f);
    const result = await f.request('/run', { token: prepared.token, script });
    assert.equal(result.status, 400);
    assert.equal(result.body.ok, false);
    assert.equal((await f.request('/run', { token: prepared.token, script: 'build' })).status, 410);
  }
  const noBuild = await prepare(f, { 'package.json': manifest({ test: 'reviewed' }) });
  assert.equal((await f.request('/run', { token: noBuild.token, script: 'build' })).status, 400);
  const expired = await prepare(f);
  f.advance(10 * 60 * 1000);
  const response = await f.request('/run', { token: expired.token, script: 'build' });
  assert.equal(response.status, 410);
  assert.match(response.body.stderr, /expired/);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('/run', { token: 'a'.repeat(64), script: 'build' })).status, 410);
  assert.equal((await f.request('/run', { token: '/arbitrary/path', script: 'build' })).status, 400);
});

test('concurrent approvals can spawn only one project run per token', async t => {
  const f = await fixture(t);
  const prepared = await prepare(f);
  const responses = await Promise.all([f.request('/run', { token: prepared.token, script: 'build' }), f.request('/run', { token: prepared.token, script: 'build' })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 410]);
  assert.equal(f.calls.filter(call => call.args[0] === 'run').length, 1);
});

test('file mutations, missing/extra files and unreviewed directories invalidate the immutable digest', async t => {
  const f = await fixture(t);
  for (const mutate of [
    (workspace: string) => fs.writeFileSync(path.join(workspace, 'src/index.ts'), 'changed'),
    (workspace: string) => fs.writeFileSync(path.join(workspace, 'package.json'), manifest({ build: 'changed command' })),
    (workspace: string) => fs.unlinkSync(path.join(workspace, 'src/index.ts')),
    (workspace: string) => fs.writeFileSync(path.join(workspace, 'extra.txt'), 'extra'),
    (workspace: string) => fs.mkdirSync(path.join(workspace, 'empty-unreviewed-directory')),
  ]) {
    const prepared = await prepare(f);
    mutate(prepared.workspace);
    const response = await f.request('/run', { token: prepared.token, script: 'build' });
    assert.equal(response.status, 409);
    assert.equal(response.body.ok, false);
    assert.equal((await f.request('/run', { token: prepared.token, script: 'build' })).status, 410);
  }
  assert.equal(f.calls.length, 0, 'tampering rejected before toolchain probes');
});

test('staging ancestor junctions and snapshot links are refused without following them', async t => {
  const f = await fixture(t);
  const target = path.join(f.directory, 'isolated-target');
  fs.mkdirSync(target);
  try { fs.symlinkSync(target, f.dataDir, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code || '')) { t.skip('OS does not permit test symlinks'); return; }
    throw error;
  }
  const rejected = await f.request('/prepare', project({ 'package.json': manifest() }));
  assert.equal(rejected.status, 409);
  assert.deepEqual(fs.readdirSync(target), []);
  fs.unlinkSync(f.dataDir);
  const prepared = await prepare(f);
  fs.symlinkSync(target, path.join(prepared.workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.request('/run', { token: prepared.token, script: 'build' })).status, 409);
  assert.equal(f.calls.length, 0);
});

test('hard-linked snapshot files are refused and private runtime config cannot point at host state', async t => {
  const f = await fixture(t);
  const prepared = await prepare(f);
  fs.linkSync(path.join(prepared.workspace, 'src/index.ts'), path.join(f.directory, 'isolated-hard-link'));
  assert.equal((await f.request('/run', { token: prepared.token, script: 'build' })).status, 409);
  const other = await prepare(f);
  fs.writeFileSync(path.join(path.dirname(other.workspace), 'runtime/user.npmrc'), 'unreviewed-config');
  const result = await f.request('/run', { token: other.token, script: 'build' });
  assert.equal(result.status, 409);
  assert.match(result.body.stderr, /config changed/);
  assert.equal(f.calls.length, 0);
});

test('failed atomic staging leaves no half-published snapshot or issued token', async t => {
  const f = await fixture(t);
  fs.mkdirSync(f.dataDir);
  fs.writeFileSync(path.join(f.dataDir, 'project-builds'), 'not a directory');
  const result = await f.request('/prepare', project({ 'package.json': manifest() }));
  assert.equal(result.status, 409);
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'project-builds'), 'utf8'), 'not a directory');
  assert.equal(result.body.token, undefined);
  assert.equal(f.calls.length, 0);
});

test('nonzero exit and launch failures return diagnostics without retrying another runtime', async t => {
  for (const run of [
    (child: FakeChild) => { child.stdout.write('partial'); child.stderr.write('controlled failure'); child.complete(2); },
    (child: FakeChild) => { child.emit('error', Object.assign(new Error('do not leak /host/path'), { code: 'ENOENT' })); },
  ]) {
    const f = await fixture(t, { run });
    const prepared = await prepare(f);
    const response = await f.request('/run', { token: prepared.token, script: 'lint' });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, false);
    assert.match(response.body.stderr, /exit 2|Unable to launch/);
    assert.doesNotMatch(response.body.stderr, /\/host\/path/);
    assert.equal(f.calls.filter(call => call.args[0] === 'run').length, 1);
  }
});

test('combined UTF-8 output is bounded to 1 MB and noisy streams are drained while terminating', async t => {
  let drained = 0;
  const f = await fixture(t, { run: child => {
    child.stdout.on('data', (chunk: Buffer) => { drained += chunk.length; });
    child.stderr.on('data', (chunk: Buffer) => { drained += chunk.length; });
    child.stdout.write('é'.repeat(350_000));
    child.stderr.write('雪'.repeat(300_000));
    child.stdout.write('discarded-after-limit');
  } });
  const prepared = await prepare(f);
  const result = await f.request('/run', { token: prepared.token, script: 'build' });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, false);
  assert.ok(Buffer.byteLength(result.body.stdout) + Buffer.byteLength(result.body.stderr) <= 1024 * 1024);
  assert.match(result.body.stderr, /Output exceeded/);
  assert.ok(drained >= 1_600_000, 'both full streams consumed even after storage reaches the limit');
  assert.ok(f.kills.includes('SIGTERM'));
});

test('timeout kills a stalled child, escalates if it does not close, and consumes the token', async t => {
  const f = await fixture(t, { timeoutMs: 100, linger: true, run: () => {} });
  const prepared = await prepare(f);
  const started = Date.now();
  const result = await f.request('/run', { token: prepared.token, script: 'test' });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, false);
  assert.match(result.body.stderr, /timed out/);
  assert.ok(Date.now() - started < 2000);
  assert.ok(f.kills.includes('SIGTERM'));
  assert.ok(f.kills.includes('SIGKILL'));
  assert.equal((await f.request('/run', { token: prepared.token, script: 'test' })).status, 410);
});

test('Windows timeout requests fixed shell-free process-tree cleanup before killing the root', async t => {
  const f = await fixture(t, { platform: 'win32', timeoutMs: 100, windowsTree: true, run: () => {} });
  const prepared = await prepare(f);
  const result = await f.request('/run', { token: prepared.token, script: 'test' });
  assert.equal(result.body.ok, false);
  assert.match(result.body.stderr, /timed out/);
  const cleanup = f.calls.find(call => call.args[0] === '/PID');
  assert.ok(cleanup);
  assert.equal(cleanup.command, path.join(f.directory, 'fake-windows', 'System32', 'taskkill.exe'));
  assert.deepEqual(cleanup.args, ['/PID', '43210', '/T', '/F']);
  assert.equal(cleanup.options.shell, false);
  assert.equal(cleanup.options.stdio, 'ignore');
  assert.equal(f.kills.length, 0, 'root must remain alive until tree enumeration finishes');
});

test('snapshot changes during toolchain detection are caught before any script execution', async t => {
  let workspace = '';
  const f = await fixture(t, { probe: () => fs.writeFileSync(path.join(workspace, 'package.json'), manifest({ build: 'changed after review' })) });
  const prepared = await prepare(f);
  workspace = prepared.workspace;
  const result = await f.request('/run', { token: prepared.token, script: 'build' });
  assert.equal(result.status, 409);
  assert.match(result.body.stderr, /digest changed/);
  assert.equal(f.calls.filter(call => call.args[0] === 'run').length, 0);
});
