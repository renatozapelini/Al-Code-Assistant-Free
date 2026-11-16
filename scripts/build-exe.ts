import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStandaloneWindowsExe } from '../src/server/winExeBuilder.ts';
import { APP_VERSION } from '../src/version.ts';

// Compila o aplicativo Windows (interface + motor de APIs em um único .exe).
// A versão vem de src/version.ts, a mesma do APK, para os dois nunca divergirem.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const exe = await buildStandaloneWindowsExe();
const outDir = path.join(root, 'build');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `Code-Assistants-v${APP_VERSION}.exe`);
fs.copyFileSync(exe, out);
console.log(`EXE ${APP_VERSION}: ${out} (${fs.statSync(out).size} bytes)`);
