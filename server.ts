import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistantRouter } from './src/server/hubRouter.ts';
import { buildStandaloneWindowsExe } from './src/server/winExeBuilder.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const app = express();
app.use(express.json({ limit: '25mb' }));

// Local project execution and provider management; no public gateway.
app.use(createAssistantRouter());
app.get("/api/app/download/windows-exe", async (_req, res) => {
  try { res.download(await buildStandaloneWindowsExe({ includeAndroid: false }), "Code-Assistants.exe"); }
  catch (err) { res.status(500).json({ error: { message: err instanceof Error ? err.message : "Falha ao compilar o aplicativo Windows." } }); }
});
app.get("/api/app/download/android-apk", (_req, res) => {
  res.status(503).json({ error: { message: "O APK atualizado das code assistants ainda não está disponível." } });
});

async function startServer() {
  // Unknown API routes must never look like a successful HTML/SPA response.
  app.use(['/api', '/v1'], (_req, res) => {
    res.status(404).json({ error: { type: 'not_found', message: 'Endpoint não encontrado.' } });
  });
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

  const host = process.env.HOST || '127.0.0.1';
  app.listen(PORT, host, () => {
    console.log(`Code Assistants running on http://${host}:${PORT}`);
  });
}

startServer();
