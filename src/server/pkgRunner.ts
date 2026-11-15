import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Executa um script do package.json com o runtime disponível.
 * O projeto usa bun (bun.lock); em máquinas sem bun, cai para npm.
 * No Windows o npm é um shim .cmd, por isso o fallback usa shell.
 */
export async function runPackageScript(
  script: string,
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  const options = { cwd, maxBuffer: 15 * 1024 * 1024 };
  try {
    return await execFileAsync('bun', ['run', script], options);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return await execFileAsync('npm', ['run', script], {
        ...options,
        shell: process.platform === 'win32',
      });
    }
    throw err;
  }
}