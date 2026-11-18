import { describe, expect, test } from 'bun:test';
import {
  DesktopUpdateService,
  RELEASES_URL,
  compareVersions,
  downloadUrlFor,
  evaluateReleases,
  installDesktopUpdate,
  releaseUrlFor,
} from './desktopUpdates.ts';
import express from 'express';

// O atualizador do Windows usa o mesmo contrato do APK: releases públicos do
// GitHub, nada de conta ou chave, e só o instalador canônico do repositório.

const V = '9.9.9';
const APK = { name: `Code-Assistants-v${V}.apk`, size: 400_000, browser_download_url: `https://github.com/renatozapelini/Al-Code-Assistant-Free/releases/download/v${V}/Code-Assistants-v${V}.apk` };
const EXE = { name: `Code-Assistants-v${V}.exe`, size: 120_000_000, browser_download_url: downloadUrlFor(V), digest: `sha256:${'a'.repeat(64)}` };
const SOURCE = { name: `Code-Assistants-v${V}-source.zip`, size: 1_000, browser_download_url: `https://github.com/renatozapelini/Al-Code-Assistant-Free/releases/download/v${V}/Code-Assistants-v${V}-source.zip` };

function release(version: string, assets: unknown[] = [
  { ...EXE, name: `Code-Assistants-v${version}.exe`, browser_download_url: downloadUrlFor(version) },
  APK, SOURCE,
], extra: Record<string, unknown> = {}) {
  return { tag_name: `v${version}`, draft: false, prerelease: false, assets, ...extra };
}

describe('atualizador do aplicativo Windows', () => {
  test('compara versões sem confiar em texto livre', () => {
    expect(compareVersions('3.4.0', '3.3.9')).toBe(1);
    expect(compareVersions('3.4.0', '3.4.0')).toBe(0);
    expect(compareVersions('3.10.0', '3.9.9')).toBe(1);
    expect(compareVersions('3.4', '3.4.0')).toBe(0);
    expect(compareVersions('3.4.0-beta', '3.4.0')).toBe(0);
  });

  test('oferece o instalador mais novo entre releases estáveis', () => {
    const result = evaluateReleases([release('3.3.0'), release(V), release('9.9.10', [
      { ...EXE, name: 'Code-Assistants-v9.9.10.exe', browser_download_url: downloadUrlFor('9.9.10') },
    ])], V, 1234);
    expect(result.ok).toBe(true);
    expect(result.available).toBe(true);
    expect(result.currentVersion).toBe(V);
    expect(result.latestVersion).toBe('9.9.10');
    expect(result.downloadUrl).toBe(downloadUrlFor('9.9.10'));
    expect(result.releaseUrl).toBe(releaseUrlFor('9.9.10'));
    expect(result.checkedAt).toBe(1234);
  });

  test('não repete a atualização quando já está na versão publicada', () => {
    const result = evaluateReleases([release(V)], V);
    expect(result.ok).toBe(true);
    expect(result.available).toBe(false);
    expect(result.downloadUrl).toBeUndefined();
    expect(result.message).toContain('mais nova');
  });

  test('ignora rascunho, pré-release, tag estranha e release sem .exe', () => {
    const result = evaluateReleases([
      release('9.9.9', undefined, { draft: true }),
      release('9.9.8', undefined, { prerelease: true }),
      { ...release('9.9.7'), tag_name: '9.9.7' },
      { ...release('9.9.6'), tag_name: 'v99.9.6.1' },
      release('9.9.5', [APK, SOURCE]),
    ], V);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no_compatible_installer');
    expect(result.available).toBe(false);
  });

  test('recusa link, tamanho e nome fora do contrato', () => {
    const bad = [
      [{ ...EXE, name: 'Code-Assistants.exe' }],
      [{ ...EXE, browser_download_url: 'https://github.com.evil.test/x/Code-Assistants-v9.9.9.exe' }],
      [{ ...EXE, browser_download_url: `http://github.com/renatozapelini/Al-Code-Assistant-Free/releases/download/v${V}/Code-Assistants-v${V}.exe` }],
      [{ ...EXE, browser_download_url: `https://github.com/other/repo/releases/download/v${V}/Code-Assistants-v${V}.exe` }],
      [{ ...EXE, size: 0 }],
      [{ ...EXE, size: 201 * 1024 * 1024 }],
      [{ ...EXE, size: 1.5 }],
      // Dois .exe com o mesmo nome: ambíguo, não confirma.
      [{ ...EXE }, { ...EXE }],
    ];
    for (const assets of bad) {
      const result = evaluateReleases([release(V, assets)], '3.0.0');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('no_compatible_installer');
    }
  });

  test('resposta fora do formato não vira atualização', () => {
    for (const raw of [null, 'texto', 42, {}, [{ nope: true }], 'x'.repeat(200)]) {
      expect(evaluateReleases(raw).available).toBe(false);
    }
    const huge = Array.from({ length: 101 }, () => release(V));
    expect(evaluateReleases(huge).error).toBe('invalid_payload');
  });

  test('consulta com cache: sucesso por 1h, falha por 5min, force sempre busca', async () => {
    let calls = 0;
    let now = 1000;
    let payload: unknown = [release('3.5.1')];
    let status = 200;
    const service = new DesktopUpdateService(async () => {
      calls++;
      return { ok: status === 200, status, text: async () => JSON.stringify(payload) };
    }, () => now);
    expect((await service.check()).latestVersion).toBe('3.5.1');
    expect(calls).toBe(1);
    await service.check();
    expect(calls).toBe(1);
    now += 3_599_999;
    await service.check();
    expect(calls).toBe(1);
    now += 1;
    await service.check();
    expect(calls).toBe(2);
    await service.check(true);
    expect(calls).toBe(3);

    status = 500;
    expect((await service.check(true)).error).toBe('http_500');
    expect(calls).toBe(4);
    now += 299_999;
    await service.check();
    expect(calls).toBe(4);
    now += 1;
    await service.check();
    expect(calls).toBe(5);
  });

  test('falhas de rede e formato viram mensagem honesta', async () => {
    const down = new DesktopUpdateService(async () => { throw new Error('offline'); });
    const offline = await down.check();
    expect(offline.ok).toBe(false);
    expect(offline.error).toBe('unavailable');

    const timeout = new DesktopUpdateService(async () => { const e = new Error('slow'); e.name = 'TimeoutError'; throw e; });
    expect((await timeout.check()).error).toBe('timeout');

    const garbage = new DesktopUpdateService(async () => ({ ok: true, status: 200, text: async () => '<html>' }));
    expect((await garbage.check()).error).toBe('invalid_payload');

    const tooBig = new DesktopUpdateService(async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(1024 * 1024 + 1) }));
    expect((await tooBig.check()).error).toBe('body_too_large');
  });

  test('guarda o sha256 publicado para o release mais novo', async () => {
    const service = new DesktopUpdateService(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify([release('3.5.1'), { ...release('3.5.1'), assets: [EXE, APK] }]),
    }));
    await service.check();
    expect(service.digestFor('3.5.1')).toBe(`sha256:${'a'.repeat(64)}`);
    expect(service.digestFor('3.4.8')).toBe('');
    expect(service.digestFor(undefined)).toBe('');
  });

  test('instalação automática só existe no .exe do Windows', async () => {
    const service = new DesktopUpdateService(async () => ({ ok: true, status: 200, text: async () => JSON.stringify([release('3.5.1')]) }));
    const result = await installDesktopUpdate(service, '3.5.1');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('not_desktop');
    const invalid = await installDesktopUpdate(service, 'não-é-versão');
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toBe('not_desktop');
  });

  test('rota recusa parâmetros desconhecidos e devolve o contrato', async () => {
    const service = new DesktopUpdateService(async () => ({ ok: true, status: 200, text: async () => JSON.stringify([release('3.5.14')]) }));
    const { createDesktopUpdateRouter } = await import('./desktopUpdates.ts');
    const app = express();
    app.use(express.json());
    app.use(createDesktopUpdateRouter(service));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
    try {
      const ok = await fetch(`${base}/api/app/updates`);
      expect(ok.status).toBe(200);
      const body = await ok.json() as { available: boolean; latestVersion: string };
      expect(body.available).toBe(true);
      expect(body.latestVersion).toBe('3.5.14');

      const bad = await fetch(`${base}/api/app/updates?force=0&x=1`);
      expect(bad.status).toBe(400);

      const install = await fetch(`${base}/api/app/updates/install`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '3.5.13' }),
      });
      expect(install.status).toBe(409);
      expect((await install.json() as { error: string }).error).toBe('not_desktop');

      const unreachable = new DesktopUpdateService(async () => { throw new Error('offline'); });
      const failing = express();
      failing.use(createDesktopUpdateRouter(unreachable));
      const failingServer = failing.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => failingServer.once('listening', () => resolve()));
      const failingAddress = failingServer.address();
      const failingBase = typeof failingAddress === 'object' && failingAddress ? `http://127.0.0.1:${failingAddress.port}` : '';
      const failure = await fetch(`${failingBase}/api/app/updates`);
      expect(failure.status).toBe(503);
      await new Promise<void>((resolve) => failingServer.close(() => resolve()));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('contrato aponta para o repositório público correto', () => {
    expect(RELEASES_URL).toBe('https://api.github.com/repos/renatozapelini/Al-Code-Assistant-Free/releases?per_page=30');
    expect(downloadUrlFor('3.4.0')).toBe('https://github.com/renatozapelini/Al-Code-Assistant-Free/releases/download/v3.4.0/Code-Assistants-v3.4.0.exe');
    expect(releaseUrlFor('3.4.0')).toBe('https://github.com/renatozapelini/Al-Code-Assistant-Free/releases/tag/v3.4.0');
  });
});
