import fs from 'node:fs';
import path from 'node:path';
import { buildSignedAndroidApk } from '../src/server/apkBuilder.ts';

// Compila o motor Java nativo, empacota a interface construída e assina o APK.
// A versão sai do próprio AndroidManifest.xml para o arquivo nunca divergir do app.
const root = path.resolve(import.meta.dir, '..');
process.chdir(root);

const manifest = fs.readFileSync(path.join(root, 'src/server/android-native/AndroidManifest.xml'), 'utf8');
const version = /android:versionName="([^"]+)"/.exec(manifest)?.[1];
if (!version) throw new Error('android:versionName não encontrado em src/server/android-native/AndroidManifest.xml');

const apk = await buildSignedAndroidApk();
const outDir = path.join(root, 'build');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `Code-Assistants-v${version}.apk`);
fs.copyFileSync(apk, out);
console.log(`APK ${version}: ${out} (${fs.statSync(out).size} bytes)`);
