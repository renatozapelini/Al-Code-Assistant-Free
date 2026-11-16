import { describe, expect, test } from 'bun:test';
import { APP_VERSION, readUpdateResponse, validateUpdateInfo } from '../components/AppUpdatePanel';
import { createCodeProject, restoreCodeProjects } from './codeAssistant';
import { readFileSync } from 'node:fs';

describe('atualização e pastas locais', () => {
  // A versão mais nova é derivada da instalada para o teste não quebrar a cada release.
  const latestVersion = APP_VERSION.replace(/\.(\d+)$/, (_all, patch: string) => `.${Number(patch) + 1}`);
  const update = { ok: true, currentVersion: APP_VERSION, latestVersion, available: true,
    downloadUrl: `https://github.com/renatozapelini/Al-Code-Assistant-Free/releases/download/v${latestVersion}/Code-Assistants-v${latestVersion}.apk` };
  test('valida release mais novo e não inventa disponibilidade', () => {
    expect(validateUpdateInfo(update).available).toBe(true);
    expect(validateUpdateInfo({ ok: false, currentVersion: APP_VERSION, available: false }).available).toBe(false);
  });
  test('recusa versões erradas, inseguras e links fora do APK autorizado', () => {
    for (const patch of [{ currentVersion: '3.0.1' }, { latestVersion: '3.1.0' }, { latestVersion: '3.0.9' }, { latestVersion: '3.1.1-beta' },
      { downloadUrl: update.downloadUrl + '?token=secret' }, { downloadUrl: update.downloadUrl.replace('github.com', 'github.com.evil.test') },
      { downloadUrl: update.downloadUrl.replace('/Al-Code-Assistant-Free/', '/Other/') }, { downloadUrl: update.downloadUrl.replace('https:', 'http:') },
      { downloadUrl: update.downloadUrl.replace('.apk', '.exe') }, { ok: false }, { latestVersion: '3.99999999999999999999999999.0' }]) {
      expect(() => validateUpdateInfo({ ...update, ...patch })).toThrow();
    }
  });
  test('503 do motor nativo mostra o motivo exato, não um erro HTTP genérico', async () => {
    const empty = { ok: false, currentVersion: APP_VERSION, available: false, error: 'empty_releases',
      message: 'A lista pública de releases está vazia; nenhum APK foi confirmado.' };
    const data = await readUpdateResponse({ ok: false, status: 503, json: async () => empty });
    expect(data.ok).toBe(false); expect(data.available).toBe(false); expect(data.message).toBe(empty.message);
    const noApk = await readUpdateResponse({ ok: false, status: 503, json: async () => ({ ...empty, error: 'no_compatible_apk', message: 'Nenhum release estável contém um APK válido.' }) });
    expect(noApk.message).toContain('Nenhum release estável');
  });
  test('200 com release mais novo continua oferecendo o APK canônico', async () => {
    const data = await readUpdateResponse({ ok: true, status: 200, json: async () => update });
    expect(data.available).toBe(true); expect(data.downloadUrl).toBe(update.downloadUrl);
  });
  test('503 nunca fabrica disponibilidade e corpo inválido vira erro de transporte', async () => {
    const transport = 'Não foi possível consultar atualizações (HTTP 503).';
    await expect(readUpdateResponse({ ok: false, status: 503, json: async () => { throw new Error('not json'); } })).rejects.toThrow(transport);
    await expect(readUpdateResponse({ ok: false, status: 503, json: async () => '<html>erro</html>' })).rejects.toThrow(transport);
    await expect(readUpdateResponse({ ok: false, status: 503, json: async () => update })).rejects.toThrow(transport);
    await expect(readUpdateResponse({ ok: false, status: 503, json: async () => ({ ...update, ok: false }) })).rejects.toThrow(transport);
    await expect(readUpdateResponse({ ok: false, status: 503, json: async () => ({ ok: false, currentVersion: '3.0.1', available: false }) })).rejects.toThrow(transport);
    await expect(readUpdateResponse({ ok: true, status: 200, json: async () => ({ ok: true }) })).rejects.toThrow();
  });
  test('versão UI, manifest, helper e backend concordam', () => {
    expect(readFileSync(new URL('../server/android-native/AndroidManifest.xml', import.meta.url), 'utf8')).toContain(`android:versionName="${APP_VERSION}"`);
    expect(readFileSync(new URL('../server/native-build.ts', import.meta.url), 'utf8')).toContain(`'--version-name', '${APP_VERSION}'`);
    expect(readFileSync(new URL('../server/android-native/java/com/qoder2api/hub/AppUpdates.java', import.meta.url), 'utf8')).toContain(`CURRENT_VERSION = "${APP_VERSION}"`);
  });
  test('pasta sem API é criada e restaurada, sem executar nada', () => {
    const project = createCodeProject({ name: 'Minha pasta', goal: 'Controle de estoque', blueprint: 'Pré-prompt revisado', providerIds: [] });
    expect(project.status).toBe('idle'); expect(project.turn).toBe(0);
    expect(project.providerIds).toEqual([]);
    expect(restoreCodeProjects(JSON.stringify([project]))[0].blueprint).toBe('Pré-prompt revisado');
    expect(() => createCodeProject({ name: 'Projeto', goal: 'Objetivo', providerIds: [''] })).toThrow();
  });
});
