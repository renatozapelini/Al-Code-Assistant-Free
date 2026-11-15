import 'dotenv/config';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHubRouter } from './src/server/hubRouter.ts';
import { buildSignedAndroidApk } from './src/server/apkBuilder.ts';
import { ensureFreshDist } from './src/server/distHelper.ts';
import { buildStandaloneWindowsExe } from './src/server/winExeBuilder.ts';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const app = express();
app.use(express.json({ limit: '25mb' }));

// Mount all Qoder2API-Hub protocol (/v1/*, /health, /ping, /credits) & management (/api/hub/*) routes
app.use(createHubRouter());

// Compilation Agent ("Agente de Compilação") for project finalization
app.post('/api/hub/build-agent/run', async (req, res) => {
  const target = String(req.body?.target || 'all') as 'lint' | 'web' | 'apk' | 'exe' | 'all';
  const steps: Array<{ name: string; ok: boolean; durationMs: number; detail: string }> = [];
  const artifacts: Array<{ label: string; filename: string; sizeBytes: number; sha256: string; downloadUrl: string }> = [];
  const logLines: string[] = [];

  const fileSha256 = (filePath: string) =>
    crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

  try {
    // Step 1: TypeScript Lint
    const t0 = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync('npm', ['run', 'lint'], {
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024,
      });
      steps.push({ name: 'Verificação TypeScript (tsc --noEmit)', ok: true, durationMs: Date.now() - t0, detail: 'Zero erros de tipo' });
      logLines.push(`[OK] TypeScript check (${Date.now() - t0}ms)`, stdout.trim(), stderr.trim());
    } catch (err) {
      const errOut = err instanceof Error ? err.message : 'Erro de TypeScript';
      steps.push({ name: 'Verificação TypeScript (tsc --noEmit)', ok: false, durationMs: Date.now() - t0, detail: errOut.slice(0, 240) });
      logLines.push(`[FALHA] TypeScript check`, errOut);
      res.status(200).json({ ok: false, target, steps, artifacts, logs: logLines.filter(Boolean).join('\n') });
      return;
    }

    if (target === 'lint') {
      res.json({ ok: true, target, steps, artifacts, logs: logLines.filter(Boolean).join('\n') });
      return;
    }

    // Step 2: Production Web Bundle (Vite)
    const t1 = Date.now();
    await ensureFreshDist(true);
    steps.push({ name: 'Build Produção Web (dist/)', ok: true, durationMs: Date.now() - t1, detail: 'Bundle SPA + PWA gerado' });
    logLines.push(`[OK] Vite production build (${Date.now() - t1}ms)`);

    if (target === 'web') {
      res.json({ ok: true, target, steps, artifacts, logs: logLines.filter(Boolean).join('\n') });
      return;
    }

    // Step 3: Android Signed APK
    if (target === 'apk' || target === 'all') {
      const t2 = Date.now();
      const apkPath = await buildSignedAndroidApk();
      const stat = fs.statSync(apkPath);
      const sha256 = fileSha256(apkPath);
      steps.push({
        name: 'Empacotar & Assinar Android .APK (v2 RSA-2048)',
        ok: true,
        durationMs: Date.now() - t2,
        detail: `${(stat.size / (1024 * 1024)).toFixed(2)} MB`,
      });
      artifacts.push({
        label: 'Android APK Assinado',
        filename: 'Qoder2API-Hub.apk',
        sizeBytes: stat.size,
        sha256,
        downloadUrl: '/api/hub/download/android-apk',
      });
      logLines.push(`[OK] Qoder2API-Hub.apk gerado (${stat.size} bytes, SHA256=${sha256.slice(0, 16)}...)`);
    }

    // Step 4: Windows x64 Standalone EXE
    if (target === 'exe' || target === 'all') {
      const t3 = Date.now();
      const exePath = await buildStandaloneWindowsExe();
      const stat = fs.statSync(exePath);
      const sha256 = fileSha256(exePath);
      steps.push({
        name: 'Compilar Executável Windows x64 (.EXE)',
        ok: true,
        durationMs: Date.now() - t3,
        detail: `${(stat.size / (1024 * 1024)).toFixed(2)} MB`,
      });
      artifacts.push({
        label: 'Windows x64 Executável',
        filename: 'Qoder2API-Hub.exe',
        sizeBytes: stat.size,
        sha256,
        downloadUrl: '/api/hub/download/windows-exe',
      });
      logLines.push(`[OK] Qoder2API-Hub.exe compilado (${stat.size} bytes, SHA256=${sha256.slice(0, 16)}...)`);
    }

    res.json({ ok: true, target, steps, artifacts, logs: logLines.filter(Boolean).join('\n') });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erro no agente de compilação';
    steps.push({ name: 'Execução do Agente de Compilação', ok: false, durationMs: 0, detail: msg });
    logLines.push(`[ERRO] ${msg}`);
    res.status(200).json({ ok: false, target, steps, artifacts, logs: logLines.filter(Boolean).join('\n') });
  }
});

// Compile & stream signed Android APK (.apk) with native HTTP gateway + embedded UI
app.get('/api/hub/download/android-apk', async (_req, res) => {
  try {
    const apkPath = await buildSignedAndroidApk();
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.download(apkPath, 'Qoder2API-Hub.apk');
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Falha ao gerar o pacote Android (.apk).',
    });
  }
});

// Compile & stream standalone Windows x64 executable (.exe) with embedded UI + Hub gateway
app.get('/api/hub/download/windows-exe', async (_req, res) => {
  try {
    const exePath = await buildStandaloneWindowsExe();
    res.download(exePath, 'Qoder2API-Hub.exe');
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Falha ao compilar o executável Windows (.exe).',
    });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Qoder2API-Hub Android Gateway running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
