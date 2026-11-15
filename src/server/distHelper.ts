import fs from 'node:fs';
import path from 'node:path';
import { runPackageScript } from './pkgRunner.ts';

function getNewestMtimeMs(dir: string): number {
  let newest = 0;
  if (!fs.existsSync(dir)) return newest;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'apk-template') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, getNewestMtimeMs(abs));
    } else {
      const stat = fs.statSync(abs);
      newest = Math.max(newest, stat.mtimeMs);
    }
  }
  return newest;
}

let distBuildInFlight: Promise<void> | null = null;

export async function ensureFreshDist(forceRebuild = false): Promise<string> {
  const rootDir = process.cwd();
  const distDir = path.join(rootDir, 'dist');
  const indexHtml = path.join(distDir, 'index.html');

  const needsBuild =
    forceRebuild ||
    !fs.existsSync(indexHtml) ||
    getNewestMtimeMs(path.join(rootDir, 'src')) > fs.statSync(indexHtml).mtimeMs;

  if (needsBuild) {
    if (!distBuildInFlight) {
      distBuildInFlight = runPackageScript('build', rootDir)
        .then(() => undefined)
        .finally(() => {
          distBuildInFlight = null;
        });
    }
    await distBuildInFlight;
  }

  return distDir;
}
