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
    const appLogAbs = path.join(rootDir, 'src', 'server', 'appLog.ts').replace(/\\/g, '/');
    const desktopPathsAbs = path.join(rootDir, 'src', 'server', 'desktopPaths.ts').replace(/\\/g, '/');
    const assetsAbs = assetsTsPath.replace(/\\/g, '/');
    const entryPath = path.join(tempBuildDir, 'winMain.ts');

    const entryCode = `import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { EMBEDDED_ASSETS } from ${JSON.stringify(assetsAbs)};
import { appendLog, logError } from ${JSON.stringify(appLogAbs)};
import { ensureDesktopDirs } from ${JSON.stringify(desktopPathsAbs)};

// Pastas criadas na primeira execução (mesmo sem o instalador): dados, projetos
// visíveis em Documentos e logs para o diagnóstico.
const PATHS = ensureDesktopDirs();
if (!process.env.QD_DATA_DIR) process.env.QD_DATA_DIR = PATHS.dataDir;
// Marca o aplicativo empacotado: o atualizador só troca o .exe quando esta
// variável existe, nunca o runtime do Bun em desenvolvimento.
process.env.CODE_ASSISTANTS_DESKTOP = '1';

// Dynamic import AFTER QD_DATA_DIR is set: the store reads it at module load.
const { createAssistantRouter } = await import(${JSON.stringify(hubRouterAbs)});

const DESKTOP_VERSION = ${JSON.stringify(APP_VERSION)};
const DESKTOP_BOOTSTRAP = 'window.CodeAssistantsDesktop=' + JSON.stringify({ version: DESKTOP_VERSION, platform: 'windows' }) + ';';
const BASE_PORT = Number(process.env.PORT || 8790);
const CANDIDATES = Number.isInteger(BASE_PORT) && BASE_PORT > 0 && BASE_PORT < 65000
  ? [BASE_PORT, ...Array.from({ length: 9 }, (_, index) => Math.min(BASE_PORT + index + 1, 65535))]
  : [8790, 8791, 8792, 8793, 8794, 8795, 8796, 8797, 8798, 8799];
let fatalError = '';
let boundPort = 0;

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(createAssistantRouter());

app.get("/api/app/download/windows-exe", (_req, res) => res.download(process.execPath, "Code-Assistants-v" + DESKTOP_VERSION + ".exe"));
app.get("/api/app/download/android-apk", (_req, res) => {
  res.status(503).json({ error: { message: "O APK atualizado das code assistants ainda não está disponível." } });
});
app.use(['/api', '/v1'], (_req, res) => res.status(404).json({ error: { type: 'not_found', message: 'Endpoint não encontrado.' } }));

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

function documentPage(title, body) {
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeHtml(title) + '</title><style>' +
    'body{margin:0;background:#090B0E;color:#e4e4e7;font:14px/1.5 system-ui,Segoe UI,sans-serif;padding:32px}' +
    'main{max-width:820px;margin:0 auto}h1{font-size:20px;margin:0 0 8px}p{margin:8px 0;color:#a1a1aa}' +
    'code,pre{background:#12151b;border:1px solid #27272a;border-radius:8px;padding:2px 6px;color:#d4d4d8;font-size:12px}' +
    'pre{padding:12px;overflow:auto;max-height:360px;white-space:pre-wrap}button{background:#059669;color:#fff;border:0;' +
    'border-radius:8px;padding:10px 14px;font-weight:600;cursor:pointer;margin:12px 8px 0 0}</style></head><body><main>' +
    body + '</main></body></html>';
}

function errorPage(res, status, title, detail) {
  const body = '<h1>' + escapeHtml(title) + '</h1>' +
    '<p>' + escapeHtml(detail) + '</p>' +
    '<p>Log: <code>' + escapeHtml(PATHS.logFile) + '</code></p>' +
    '<p>Projetos: <code>' + escapeHtml(PATHS.projectsDir) + '</code></p>' +
    '<button type="button" onclick="location.reload()">Tentar de novo</button> ' +
    '<button type="button" onclick="fetch(\\'/api/app/desktop/open-folder\\',{method:\\'POST\\',headers:{\\'Content-Type\\':\\'application/json\\'},body:JSON.stringify({target:\\'logs\\'})})">Abrir pasta do log</button> ' +
    '<p><a style="color:#34d399" href="/diagnostico">Ver diagnóstico completo</a></p>';
  res.status(status).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(documentPage(title, body));
}

app.get('/desktop-bootstrap.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(DESKTOP_BOOTSTRAP);
});

app.get('/diagnostico', (_req, res) => {
  const tail = (() => {
    try { return fs.readFileSync(PATHS.logFile, 'utf8').split('\\n').slice(-120).join('\\n'); } catch { return '(sem log)'; }
  })();
  const body = '<h1>Diagnóstico</h1>' +
    '<p>Versão ' + escapeHtml(DESKTOP_VERSION) + ' • Windows • porta ' + escapeHtml(boundPort || '?') + '</p>' +
    '<p>Dados: <code>' + escapeHtml(PATHS.dataDir) + '</code></p>' +
    '<p>Projetos: <code>' + escapeHtml(PATHS.projectsDir) + '</code></p>' +
    '<p>Log: <code>' + escapeHtml(PATHS.logFile) + '</code></p>' +
    (fatalError ? '<p style="color:#fca5a5">Erro: ' + escapeHtml(fatalError) + '</p>' : '') +
    '<pre>' + escapeHtml(tail) + '</pre>' +
    '<button type="button" onclick="fetch(\\'/api/app/desktop/open-folder\\',{method:\\'POST\\',headers:{\\'Content-Type\\':\\'application/json\\'},body:JSON.stringify({target:\\'logs\\'})})">Abrir pasta do log</button>';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(documentPage('Diagnóstico', body));
});

function page(res, asset) {
  let html = Buffer.from(asset.b64, 'base64').toString('utf8');
  // Injeta a identificação do Windows diretamente no HTML, sem depender de
  // requisição externa para /desktop-bootstrap.js (que um service worker
  // antigo poderia interceptar e retornar 404).
  const bootstrap = '<script>' +
    '(function(){' +
    'try{if("serviceWorker"in navigator){navigator.serviceWorker.getRegistrations().then(function(rs){for(var i=0;i<rs.length;i++)rs[i].unregister();}});}catch(e){}' +
    'window.CodeAssistantsDesktop={version:' + JSON.stringify(DESKTOP_VERSION) + ',platform:"windows"};' +
    '})();</script>';
  if (html.includes('</head>')) {
    html = html.replace('</head>', bootstrap + '</head>');
  } else if (html.includes('<body')) {
    html = html.replace('<body', bootstrap + '<body');
  } else {
    html = bootstrap + html;
  }
  res.setHeader('Content-Type', asset.mime);
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
}

app.get('*', (req, res) => {
  const reqPath = req.path === '/' ? '/index.html' : req.path;
  if (reqPath === '/index.html') {
    if (fatalError) {
      errorPage(res, 500, 'O Code Assistants encontrou um problema', fatalError);
      return;
    }
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
  if (process.platform !== 'win32') return false;
  const bases = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const browsers = [
    ...bases.map((base) => path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ...bases.map((base) => path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')),
  ];
  for (const exe of browsers) {
    try {
      if (fs.existsSync(exe)) {
        spawn(exe, ['--app=' + url, '--window-size=1280,860'], { detached: true, stdio: 'ignore' }).unref();
        return true;
      }
    } catch {
      // tenta o próximo navegador
    }
  }
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(app);

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); const address = server.address(); resolve(address && address.port ? address.port : port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function isOurInstance(port) {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(900) });
    if (!response.ok) return false;
    const data = await response.json();
    return Boolean(data && data.service === 'code-assistants');
  } catch {
    return false;
  }
}

function runningInstanceUrl() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(PATHS.dataDir, 'runtime.json'), 'utf8'));
    if (info && Number.isInteger(info.port) && info.port > 0 && info.port < 65536) return 'http://127.0.0.1:' + info.port;
  } catch {
    // sem instância anterior
  }
  return null;
}

async function boot() {
  appendLog('info', 'iniciando Code Assistants ' + DESKTOP_VERSION + ' (Windows)');
  const previous = runningInstanceUrl();
  if (previous) {
    const previousPort = Number(new URL(previous).port);
    if (await isOurInstance(previousPort)) {
      appendLog('info', 'outra cópia já roda na porta ' + previousPort + '; reabrindo a janela');
      openDesktopWindow(previous);
      process.exit(0);
    }
  }
  for (const port of CANDIDATES) {
    try {
      boundPort = await listenOn(port);
      break;
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        if (await isOurInstance(port)) {
          appendLog('info', 'porta ' + port + ' já é deste aplicativo; reabrindo a janela');
          openDesktopWindow('http://127.0.0.1:' + port);
          process.exit(0);
        }
        appendLog('warn', 'porta ' + port + ' ocupada por outro programa; tentando a próxima');
        continue;
      }
      throw err;
    }
  }
  if (!boundPort) {
    fatalError = 'Todas as portas de ' + CANDIDATES[0] + ' a ' + CANDIDATES[CANDIDATES.length - 1] + ' estão ocupadas por outros programas. Feche o outro programa e abra de novo.';
    boundPort = await listenOn(0);
  }
  try {
    fs.writeFileSync(path.join(PATHS.dataDir, 'runtime.json'), JSON.stringify({
      version: DESKTOP_VERSION, port: boundPort, pid: process.pid, startedAt: Date.now(),
      dataDir: PATHS.dataDir, projectsDir: PATHS.projectsDir, logFile: PATHS.logFile,
    }, null, 2));
  } catch (err) {
    logError('gravar runtime.json', err);
  }
  const url = 'http://127.0.0.1:' + boundPort;
  appendLog('info', 'servidor em ' + url);
  appendLog('info', 'projetos em ' + PATHS.projectsDir);
  console.log('Code Assistants Windows ' + DESKTOP_VERSION + ' em ' + url);
  console.log('Projetos: ' + PATHS.projectsDir);
  openDesktopWindow(url);
}

process.on('uncaughtException', (err) => {
  logError('erro nao tratado', err);
  fatalError = 'Erro inesperado: ' + (err && err.message ? err.message : String(err));
});
process.on('unhandledRejection', (err) => {
  logError('promessa rejeitada sem tratamento', err);
  fatalError = 'Erro inesperado: ' + (err && err.message ? err.message : String(err));
});

boot().catch(async (err) => {
  logError('iniciar o servidor', err);
  fatalError = 'Não foi possível iniciar o serviço local: ' + (err && err.message ? err.message : String(err));
  try {
    if (!boundPort) boundPort = await listenOn(0);
    openDesktopWindow('http://127.0.0.1:' + boundPort);
  } catch (fallbackError) {
    logError('abrir pagina de erro', fallbackError);
  }
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
