import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { ensureFreshDist } from './distHelper.ts';

const execFileAsync = promisify(execFile);

interface ZipInputEntry {
  name: string;
  data: Buffer;
  compress: boolean;
  align4?: boolean;
}

function makeCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrc32Table();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildZipSections(entries: ZipInputEntry[]): {
  entriesSection: Buffer;
  centralDir: Buffer;
  eocd: Buffer;
} {
  const localParts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const uncompressedSize = entry.data.length;
    const compressedData = entry.compress ? zlib.deflateRawSync(entry.data, { level: 6 }) : entry.data;
    const compressedSize = compressedData.length;
    const method = entry.compress ? 8 : 0;

    // 4-byte align uncompressed entry data offset (required by Android R+ for resources.arsc)
    let extraLen = 0;
    if (entry.align4 && !entry.compress) {
      const headerEnd = offset + 30 + nameBuf.length;
      extraLen = (4 - (headerEnd % 4)) % 4;
    }
    const extraBuf = extraLen > 0 ? Buffer.alloc(extraLen, 0) : Buffer.alloc(0);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0x0800, 6); // UTF-8 flag
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10); // mod time
    lfh.writeUInt16LE(0x5421, 12); // mod date
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compressedSize, 18);
    lfh.writeUInt32LE(uncompressedSize, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(extraLen, 28);

    const localRecord = Buffer.concat([lfh, nameBuf, extraBuf, compressedData]);
    localParts.push(localRecord);

    const cdfh = Buffer.alloc(46);
    cdfh.writeUInt32LE(0x02014b50, 0);
    cdfh.writeUInt16LE(20, 4); // version made by
    cdfh.writeUInt16LE(20, 6); // version needed
    cdfh.writeUInt16LE(0x0800, 8); // UTF-8 flag
    cdfh.writeUInt16LE(method, 10);
    cdfh.writeUInt16LE(0, 12);
    cdfh.writeUInt16LE(0x5421, 14);
    cdfh.writeUInt32LE(crc, 16);
    cdfh.writeUInt32LE(compressedSize, 20);
    cdfh.writeUInt32LE(uncompressedSize, 24);
    cdfh.writeUInt16LE(nameBuf.length, 28);
    cdfh.writeUInt16LE(0, 30); // extra len in CD
    cdfh.writeUInt16LE(0, 32); // comment len
    cdfh.writeUInt16LE(0, 34); // disk start
    cdfh.writeUInt16LE(0, 36); // internal attrs
    cdfh.writeUInt32LE(0, 38); // external attrs
    cdfh.writeUInt32LE(offset, 42); // relative local header offset

    cdParts.push(Buffer.concat([cdfh, nameBuf]));
    offset += localRecord.length;
  }

  const entriesSection = Buffer.concat(localParts);
  const centralDir = Buffer.concat(cdParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(entriesSection.length, 16);
  eocd.writeUInt16LE(0, 20);

  return { entriesSection, centralDir, eocd };
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function u64le(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

function lenPrefixed32(buf: Buffer): Buffer {
  return Buffer.concat([u32le(buf.length), buf]);
}

function computeApkV2DigestSha256(sections: Buffer[]): Buffer {
  const CHUNK_SIZE = 1024 * 1024;
  const chunkDigests: Buffer[] = [];

  for (const sec of sections) {
    for (let pos = 0; pos < sec.length; pos += CHUNK_SIZE) {
      const slice = sec.subarray(pos, Math.min(sec.length, pos + CHUNK_SIZE));
      const h = crypto.createHash('sha256');
      h.update(Buffer.from([0xa5]));
      h.update(u32le(slice.length));
      h.update(slice);
      chunkDigests.push(h.digest());
    }
  }

  const top = crypto.createHash('sha256');
  top.update(Buffer.from([0x5a]));
  top.update(u32le(chunkDigests.length));
  for (const d of chunkDigests) {
    top.update(d);
  }
  return top.digest();
}

function signApkV2(
  entriesSection: Buffer,
  centralDir: Buffer,
  eocd: Buffer,
  certDer: Buffer,
  privateKeyPem: string
): Buffer {
  // Per AOSP APK Signature Scheme v2: digest covers [entries, centralDir, eocd(before sig block offset)]
  const contentDigest = computeApkV2DigestSha256([entriesSection, centralDir, eocd]);

  // RSA-PKCS1-v1.5 SHA-256 algorithm ID = 0x0103
  const SIG_ALG_RSA_PKCS1_SHA256 = 0x0103;

  const digestEntry = Buffer.concat([u32le(SIG_ALG_RSA_PKCS1_SHA256), lenPrefixed32(contentDigest)]);
  const digestsSeq = lenPrefixed32(lenPrefixed32(digestEntry));
  const certsSeq = lenPrefixed32(lenPrefixed32(certDer));
  const attrsSeq = lenPrefixed32(Buffer.alloc(0));

  const signedData = Buffer.concat([digestsSeq, certsSeq, attrsSeq]);

  const signerKey = crypto.createPrivateKey(privateKeyPem);
  const sigBytes = crypto.sign('RSA-SHA256', signedData, {
    key: signerKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });

  const sigEntry = Buffer.concat([u32le(SIG_ALG_RSA_PKCS1_SHA256), lenPrefixed32(sigBytes)]);
  const sigsSeq = lenPrefixed32(lenPrefixed32(sigEntry));

  const spkiDer = crypto.createPublicKey(signerKey).export({ type: 'spki', format: 'der' }) as Buffer;

  const signer = Buffer.concat([
    lenPrefixed32(signedData),
    sigsSeq,
    lenPrefixed32(spkiDer),
  ]);

  const v2Block = lenPrefixed32(lenPrefixed32(signer));

  // APK Signing Block ID for v2 = 0x7109871a
  const pairBody = Buffer.concat([u32le(0x7109871a), v2Block]);
  const pair = Buffer.concat([u64le(pairBody.length), pairBody]);

  // sizeOfBlock = bytes after initial 8-byte size = pair.length + 8 (trailing size) + 16 (magic)
  const sizeOfBlock = pair.length + 8 + 16;
  const apkSigBlock = Buffer.concat([
    u64le(sizeOfBlock),
    pair,
    u64le(sizeOfBlock),
    Buffer.from('APK Sig Block 42', 'ascii'),
  ]);

  // Update EOCD Central Directory offset to account for inserted APK Signing Block
  const updatedEocd = Buffer.from(eocd);
  updatedEocd.writeUInt32LE(entriesSection.length + apkSigBlock.length, 16);

  return Buffer.concat([entriesSection, apkSigBlock, centralDir, updatedEocd]);
}

function walkDir(dir: string, baseDir: string, out: { rel: string; abs: string }[]): void {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const abs = path.join(dir, item.name);
    if (item.isDirectory()) {
      walkDir(abs, baseDir, out);
    } else {
      out.push({
        rel: path.relative(baseDir, abs).replace(/\\/g, '/'),
        abs,
      });
    }
  }
}

let apkBuildInFlight: Promise<string> | null = null;

export async function buildSignedAndroidApk(): Promise<string> {
  if (apkBuildInFlight) return apkBuildInFlight;

  apkBuildInFlight = (async () => {
    const rootDir = process.cwd();
    const templateDir = path.join(rootDir, 'src', 'server', 'apk-template');
    const outApk = '/tmp/Qoder2API-Hub.apk';

    if (!fs.existsSync(path.join(templateDir, 'classes.dex'))) {
      throw new Error('Template Android (classes.dex) não encontrado no servidor.');
    }

    const distDir = await ensureFreshDist();

    const keyInfo = JSON.parse(
      fs.readFileSync(path.join(templateDir, 'signing-key.json'), 'utf8')
    ) as { certDerB64: string; privateKeyPem: string };
    const certDer = Buffer.from(keyInfo.certDerB64, 'base64');

    const entries: ZipInputEntry[] = [];

    // 1. AndroidManifest.xml, classes.dex, resources.arsc (4-byte aligned, uncompressed)
    entries.push({
      name: 'AndroidManifest.xml',
      data: fs.readFileSync(path.join(templateDir, 'AndroidManifest.xml')),
      compress: true,
    });
    entries.push({
      name: 'classes.dex',
      data: fs.readFileSync(path.join(templateDir, 'classes.dex')),
      compress: true,
    });
    entries.push({
      name: 'resources.arsc',
      data: fs.readFileSync(path.join(templateDir, 'resources.arsc')),
      compress: false,
      align4: true,
    });

    // 2. Compiled res/
    const resDir = path.join(templateDir, 'res');
    if (fs.existsSync(resDir)) {
      const resFiles: { rel: string; abs: string }[] = [];
      walkDir(resDir, resDir, resFiles);
      for (const rf of resFiles) {
        const isPng = rf.rel.toLowerCase().endsWith('.png');
        entries.push({
          name: `res/${rf.rel}`,
          data: fs.readFileSync(rf.abs),
          compress: !isPng,
          align4: isPng,
        });
      }
    }

    // 3. Built React UI inside assets/www/
    const distFiles: { rel: string; abs: string }[] = [];
    walkDir(distDir, distDir, distFiles);
    for (const df of distFiles) {
      entries.push({
        name: `assets/www/${df.rel}`,
        data: fs.readFileSync(df.abs),
        compress: true,
      });
    }

    const { entriesSection, centralDir, eocd } = buildZipSections(entries);
    const signedApkBuf = signApkV2(
      entriesSection,
      centralDir,
      eocd,
      certDer,
      keyInfo.privateKeyPem
    );

    fs.writeFileSync(outApk, signedApkBuf);
    return outApk;
  })();

  try {
    return await apkBuildInFlight;
  } finally {
    apkBuildInFlight = null;
  }
}
