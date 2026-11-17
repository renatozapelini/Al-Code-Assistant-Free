import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = path.join(projectRoot, 'src/server/android-native');
let inFlight: Promise<{ directory: string; dexFiles: string[] }> | undefined;

async function requireDirectory(directory: string): Promise<void> {
  if (!(await fs.stat(directory)).isDirectory()) throw new Error(`Diretório inválido: ${directory}`);
}

async function createDirectory(directory: string): Promise<void> {
  // Never create an unexpected parent tree, including the .android-build parent.
  await requireDirectory(path.dirname(directory));
  await fs.mkdir(directory, { recursive: true });
}

async function requireFile(filename: string): Promise<void> {
  try {
    if ((await fs.stat(filename)).isFile()) return;
  } catch { /* Include an actionable offline-toolchain diagnostic below. */ }
  throw new Error(`Arquivo necessário não encontrado: ${filename}. Configure JAVA_HOME/ANDROID_SDK_ROOT; este helper não baixa ferramentas.`);
}

async function filesBelow(directory: string, extension: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(filename, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) result.push(filename);
  }
  return result.sort();
}

function argumentFile(args: string[]): string {
  // javac supports quoted response files. Forward slashes avoid Windows escape ambiguity.
  return args.map(arg => `"${arg.replace(/\\/g, '/').replace(/"/g, '\\"')}"`).join('\n') + '\n';
}

async function run(executable: string, args: string[], cwd: string): Promise<void> {
  try {
    await execute(executable, args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
  } catch (error) {
    const failure = error as { message?: string; stdout?: string; stderr?: string };
    throw new Error(`Build Android falhou (${path.basename(executable)}):\n${failure.stderr || failure.stdout || failure.message}`);
  }
}

/**
 * Offline Java/Android compilation only; no EXE, React build, download, install or signing.
 * directory contains aapt's binary AndroidManifest.xml, resources.arsc and compiled res/.
 * dexFiles contains absolute classes*.dex paths. The APK caller packages these plus its
 * assets/www/ and assets/provider-presets.json using the existing app signing identity.
 * Generated sources/classes and resources.ap_ are diagnostics, NOT APK payload entries.
 */
export async function buildNativeAndroid(): Promise<{ directory: string; dexFiles: string[] }> {
  if (inFlight) return inFlight;
  inFlight = compileNative();
  try { return await inFlight; }
  finally { inFlight = undefined; }
}

async function compileNative(): Promise<{ directory: string; dexFiles: string[] }> {
  const localToolchain = path.join(os.homedir(), 'AppData/Local/android-toolchain');
  const javaHome = process.env.JAVA_HOME || path.join(localToolchain, 'jdk17/jdk-17.0.21+9');
  const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || path.join(localToolchain, 'sdk');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const java = path.join(javaHome, 'bin', `java${suffix}`);
  const javac = path.join(javaHome, 'bin', `javac${suffix}`);
  const jar = path.join(javaHome, 'bin', `jar${suffix}`);
  const androidJar = path.join(sdk, 'platforms/android-34/android.jar');
  const buildTools = path.join(sdk, 'build-tools/34.0.0');
  const aapt = path.join(buildTools, `aapt${suffix}`);
  const d8 = path.join(buildTools, 'lib/d8.jar');
  const manifest = path.join(sourceRoot, 'AndroidManifest.xml');
  const gateway = path.join(sourceRoot, 'java/com/qoder2api/hub/Gateway.java');
  await Promise.all([java, javac, jar, androidJar, aapt, d8, manifest].map(requireFile));
  // Do not synthesize a second engine or silently produce a shell-only APK.
  try { await requireFile(gateway); }
  catch { throw new Error(`Gateway.java ainda não está disponível em ${gateway}. Aguarde o motor nativo; nenhum stub será criado.`); }
  await requireDirectory(sourceRoot);
  const staging = path.join(projectRoot, '.android-build');
  await createDirectory(staging);
  const directory = await fs.mkdtemp(path.join(staging, 'native-'));
  const generated = path.join(directory, 'generated');
  const classes = path.join(directory, 'classes');
  const dexDirectory = path.join(directory, 'dex');
  await Promise.all([generated, classes, dexDirectory].map(createDirectory));
  const resources = path.join(directory, 'resources.ap_');

  await run(aapt, ['package', '-f', '-M', manifest, '-S', path.join(sourceRoot, 'res'),
    '-I', androidJar, '-J', generated, '-F', resources,
    '--min-sdk-version', '26', '--target-sdk-version', '34',
    '--version-code', '43', '--version-name', '3.5.4'], directory);

  const sources = [...await filesBelow(path.join(sourceRoot, 'java'), '.java'), ...await filesBelow(generated, '.java')];
  const sourceArgs = path.join(directory, 'javac.args');
  await fs.writeFile(sourceArgs, argumentFile(sources), 'utf8');
  await run(javac, ['--release', '8', '-encoding', 'UTF-8', '-classpath', androidJar, '-d', classes, `@${sourceArgs}`], directory);

  const classFiles = await filesBelow(classes, '.class');
  if (!classFiles.length) throw new Error('javac não gerou classes Android.');
  // A single JAR input avoids Windows command-length limits and D8 response-file
  // quoting differences (unlike javac, D8 treats quotes as literal path characters).
  const classesJar = path.join(directory, 'classes.jar');
  await run(jar, ['cf', classesJar, '-C', classes, '.'], directory);
  await run(java, ['-cp', d8, 'com.android.tools.r8.D8', '--release', '--lib', androidJar,
    '--min-api', '26', '--output', dexDirectory, classesJar], directory);

  await run(jar, ['xf', resources], directory);
  await Promise.all(['AndroidManifest.xml', 'resources.arsc'].map(name => requireFile(path.join(directory, name))));
  const dexFiles = (await filesBelow(dexDirectory, '.dex')).filter(filename => /^classes(?:\d+)?\.dex$/.test(path.basename(filename)));
  if (!dexFiles.length) throw new Error('D8 não gerou classes.dex.');
  return { directory, dexFiles };
}
