import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ensureFreshDist } from './distHelper.ts';
import { APP_VERSION } from '../version.ts';

const execFileAsync = promisify(execFile);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function walkFiles(dir: string, baseDir: string, out: { rel: string; abs: string }[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(abs, baseDir, out);
    } else {
      const rel = '/' + path.relative(baseDir, abs).replace(/\\/g, '/');
      out.push({ rel, abs });
    }
  }
}

let buildInFlight: Promise<string> | null = null;

export async function buildStandaloneWindowsExe(options: { includeAndroid?: boolean } = {}): Promise<string> {
  if (options.includeAndroid) throw new Error("O APK atualizado das code assistants ainda não está disponível.");
  if (buildInFlight) return buildInFlight;

  buildInFlight = (async () => {
    const rootDir = process.cwd();
    const outExe = path.join(os.tmpdir(), `Code-Assistants-v${APP_VERSION}.exe`);

    // O executável não usa service worker: a interface vem dos próprios assets.
    process.env.CODE_ASSISTANTS_DESKTOP_BUILD = '1';
    const distDir = await ensureFreshDist(true);
    delete process.env.CODE_ASSISTANTS_DESKTOP_BUILD;

    const collected: { rel: string; abs: string }[] = [];
    walkFiles(distDir, distDir, collected);

    const assetsMap: Record<string, { mime: string; b64: string }> = {};
    for (const item of collected) {
      const ext = path.extname(item.rel).toLowerCase();
      assetsMap[item.rel] = {
        mime: MIME_TYPES[ext] || 'application/octet-stream',
        b64: fs.readFileSync(item.abs).toString('base64'),
      };
    }

    // Build dir inside the project so bare imports (express) resolve against
    // the project node_modules without symlinks (which need privileges on Windows).
    const tempBuildDir = path.join(rootDir, '.win-build');
    fs.mkdirSync(tempBuildDir, { recursive: true });

    const assetsTsPath = path.join(tempBuildDir, 'embeddedAssets.ts');
    fs.writeFileSync(
      assetsTsPath,
      `export const EMBEDDED_ASSETS: Record<string, { mime: string; b64: string }> = ${JSON.stringify(assetsMap)};\n`,
      'utf8'
    );

    const hubRouterAbs = path.join(rootDir, 'src', 'server', 'hubRouter.ts').replace(/\\/g, '/');
    const assetsAbs = assetsTsPath.replace(/\\/g, '/');
    const entryPath = path.join(tempBuildDir, 'winMain.ts');

    const entryCode = `import express from 'express';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { EMBEDDED_ASSETS } from ${JSON.stringify(assetsAbs)};

if (!process.env.QD_DATA_DIR) {
  process.env.QD_DATA_DIR = path.join(os.homedir(), '.qoder2api-hub');
}
// Marca o aplicativo empacotado: o atualizador só troca o .exe quando esta
// variável existe, nunca o runtime do Bun em desenvolvimento.
process.env.CODE_ASSISTANTS_DESKTOP = '1';

// Dynamic import AFTER QD_DATA_DIR is set: the store reads it at module load.
const { createAssistantRouter } = await import(${JSON.stringify(hubRouterAbs)});

const DESKTOP_VERSION = ${JSON.stringify(APP_VERSION)};
const DESKTOP_BOOTSTRAP = 'window.CodeAssistantsDesktop=' + JSON.stringify({ version: DESKTOP_VERSION, platform: 'windows' }) + ';';
const PORT = Number(process.env.PORT || 8790);
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(createAssistantRouter());

app.get("/api/app/download/windows-exe", (_req, res) => res.download(process.execPath, "Code-Assistants-v" + DESKTOP_VERSION + ".exe"));
app.get("/api/app/download/android-apk", (_req, res) => {
  res.status(503).json({ error: { message: "O APK atualizado das code assistants ainda não está disponível." } });
});
app.use(['/api', '/v1'], (_req, res) => res.status(404).json({ error: { type: 'not_found', message: 'Endpoint não encontrado.' } }));

app.get('/desktop-bootstrap.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.send(DESKTOP_BOOTSTRAP);
});

function page(res, asset) {
  const html = Buffer.from(asset.b64, 'base64').toString('utf8')
    .replace('</head>', '<script src="/desktop-bootstrap.js"></script></head>');
  res.setHeader('Content-Type', asset.mime);
  res.send(html);
}

app.get('*', (req, res) => {
  const reqPath = req.path === '/' ? '/index.html' : req.path;
  if (reqPath === '/index.html') {
    const index = EMBEDDED_ASSETS['/index.html'];
    if (!index) { res.status(404).send('Not found'); return; }
    page(res, index);
    return;
  }
  const asset = EMBEDDED_ASSETS[reqPath];
  if (!asset) {
    res.status(404).send('Not found');
    return;
  }
  res.setHeader('Content-Type', asset.mime);
  res.send(Buffer.from(asset.b64, 'base64'));
});

function openDesktopWindow(url) {
  if (process.platform !== 'win32') return;
  try {
    const child = spawn('cmd', ['/c', 'start', '', 'msedge', '--app=' + url], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    try {
      const fallback = spawn('cmd', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
      });
      fallback.unref();
    } catch {
      // ignore launch error
    }
  }
}

const server = app.listen(PORT, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + PORT;
  console.log('Code Assistants Windows ' + DESKTOP_VERSION + ' rodando em ' + url);
  console.log('Dados salvos em: ' + process.env.QD_DATA_DIR);
  openDesktopWindow(url);
});

// Uma segunda cópia apenas reabre a janela do aplicativo que já está rodando.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    openDesktopWindow('http://127.0.0.1:' + PORT);
    process.exit(0);
  }
  throw err;
});
`;

    fs.writeFileSync(entryPath, entryCode, 'utf8');

    await execFileAsync(
      'bun',
      [
        'build',
        '--compile',
        '--target=bun-windows-x64',
        // Sem prompt de comando junto da janela. Os metadados (título, versão,
        // ícone) do .exe só podem ser gravados ao compilar no próprio Windows.
        '--windows-hide-console',
        entryPath,
        '--outfile',
        outExe,
      ],
      { cwd: rootDir, maxBuffer: 10 * 1024 * 1024 }
    );

    return outExe;
  })();

  try {
    return await buildInFlight;
  } finally {
    buildInFlight = null;
  }
}
