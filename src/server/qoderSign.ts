import crypto from 'node:crypto';
import type { QoderAccount } from '../types/hub.ts';

export const COSY_VERSION = process.env.QD_COSY_VERSION?.trim() || '1.1.75';
export const COSY_CLIENT_TYPE = process.env.QD_COSY_CLIENTTYPE?.trim() || '5';
export const COSY_USER_AGENT = process.env.QD_COSY_UA?.trim() || 'undici';
export const COSY_MACHINE_OS = process.env.QD_COSY_MACHINE_OS?.trim() || 'x86_64_linux';
export const DEFAULT_USER_TYPE = 'personal_professional_trial';

const QODER_STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const QODER_CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const QODER_PAD = '$';

const STD_TO_CUSTOM = new Map<string, string>();
const CUSTOM_TO_STD = new Map<string, string>();
for (let i = 0; i < 64; i++) {
  STD_TO_CUSTOM.set(QODER_STD_ALPHABET[i], QODER_CUSTOM_ALPHABET[i]);
  CUSTOM_TO_STD.set(QODER_CUSTOM_ALPHABET[i], QODER_STD_ALPHABET[i]);
}
STD_TO_CUSTOM.set('=', QODER_PAD);
CUSTOM_TO_STD.set(QODER_PAD, '=');

export const SERVER_PUB_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

export function deriveId(uid: string, salt: string): string {
  const seed = `${salt}:${uid || 'anonymous'}`;
  const md5 = crypto.createHash('md5').update(seed, 'utf8').digest('hex');
  const h = md5.slice(0, 12) + '4' + md5.slice(13, 16) + 'a' + md5.slice(17);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function deriveMachineType(uid: string): string {
  return deriveId(uid, 'machinetype').replace(/-/g, '').slice(0, 18);
}

export function deriveMachineToken(uid: string): string {
  const digest = crypto.createHash('sha512').update(`machinetoken:${uid}`, 'utf8').digest();
  return digest
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, 43);
}

export function machineHostname(uid: string): string {
  const h = crypto.createHash('md5').update(`hostname:${uid || 'anonymous'}`, 'utf8').digest('hex');
  return `DESKTOP-${h.slice(0, 7).toUpperCase()}`;
}

export function generateRequestId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export function qoderEncode(plain: string | Buffer): string {
  const buf = typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain;
  const std = buf.toString('base64');
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = '';
  for (let i = 0; i < rearranged.length; i++) {
    const ch = rearranged[i];
    out += STD_TO_CUSTOM.get(ch) ?? ch;
  }
  return out;
}

export function qoderDecode(encoded: string): Buffer {
  let std = '';
  for (let i = 0; i < encoded.length; i++) {
    const ch = encoded[i];
    std += CUSTOM_TO_STD.get(ch) ?? ch;
  }
  const n = std.length;
  const a = Math.floor(n / 3);
  const r1 = std.slice(0, a);
  const r2 = std.slice(a, n - a);
  const r3 = std.slice(n - a);
  return Buffer.from(r3 + r2 + r1, 'base64');
}

function jsonSortedCompact(mapping: Record<string, string>): Buffer {
  const keys = Object.keys(mapping).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(mapping[k] ?? '')}`);
  return Buffer.from(`{${parts.join(',')}}`, 'utf8');
}

function aes128CbcEncrypt(plain: Buffer, key: Buffer, iv: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

function rsaPkcs1v15Encrypt(plain: Buffer): Buffer {
  return crypto.publicEncrypt(
    {
      key: SERVER_PUB_PEM,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    plain
  );
}

export class CosySession {
  readonly uid: string;
  readonly machineId: string;
  readonly machineToken: string;
  readonly machineType: string;
  readonly machineHostname: string;
  readonly accessToken: string;
  readonly tempKey: string;
  readonly cosyKey: string;
  readonly info: string;

  constructor(account: Pick<QoderAccount, 'uid' | 'nickname' | 'accessToken' | 'refreshToken' | 'userType' | 'organizationId' | 'organizationName'>) {
    this.uid = account.uid || '';
    this.machineId = deriveId(this.uid, 'machine');
    this.machineToken = deriveMachineToken(this.uid);
    this.machineType = deriveMachineType(this.uid);
    this.machineHostname = machineHostname(this.uid);
    this.accessToken = account.accessToken || '';
    this.tempKey = crypto.randomBytes(8).toString('hex'); // 16 ASCII bytes -> AES-128
    this.cosyKey = rsaPkcs1v15Encrypt(Buffer.from(this.tempKey, 'utf8')).toString('base64');

    const identity: Record<string, string> = {
      name: account.nickname || '',
      aid: this.uid,
      uid: this.uid,
      yx_uid: '',
      organization_id: account.organizationId || '',
      organization_name: account.organizationName || '',
      user_type: account.userType || DEFAULT_USER_TYPE,
      security_oauth_token: this.accessToken,
      refresh_token: account.refreshToken || '',
    };

    const plain = jsonSortedCompact(identity);
    const keyBuf = Buffer.from(this.tempKey, 'utf8');
    this.info = aes128CbcEncrypt(plain, keyBuf, keyBuf).toString('base64');
  }

  bearer(body: string, rawUrl: string): { payloadB64: string; date: string; bearer: string } {
    let urlPath = '/';
    try {
      urlPath = new URL(rawUrl).pathname || '/';
    } catch {
      urlPath = rawUrl.split('?')[0] || '/';
    }
    if (urlPath.startsWith('/algo')) {
      urlPath = urlPath.slice('/algo'.length) || '/';
    }

    const payload: Record<string, string> = {
      cosyVersion: COSY_VERSION,
      ideVersion: '',
      info: this.info,
      requestId: crypto.randomUUID(),
      version: 'v1',
    };
    const payloadB64 = jsonSortedCompact(payload).toString('base64');
    const date = String(Math.floor(Date.now() / 1000));
    const raw = [payloadB64, this.cosyKey, date, body, urlPath].join('\n');
    const sig = crypto.createHash('md5').update(raw, 'utf8').digest('hex');
    return {
      payloadB64,
      date,
      bearer: `Bearer COSY.${payloadB64}.${sig}`,
    };
  }

  headers(body: string, rawUrl: string, modelKey = '', sse = true): Record<string, string> {
    const { date, bearer } = this.bearer(body, rawUrl);
    const h: Record<string, string> = {
      'cosy-data-policy': 'agree',
      'content-type': 'application/json',
      'cosy-business-product': 'cli',
      'cosy-business-type': 'agent',
      'cosy-scene': 'assistant',
      'cosy-clienttype': COSY_CLIENT_TYPE,
      'cosy-date': date,
      'cosy-user': this.uid,
      'cosy-key': this.cosyKey,
      accept: sse ? 'text/event-stream' : 'application/json',
      authorization: bearer,
      'accept-encoding': 'identity',
      'cosy-version': COSY_VERSION,
      'cosy-machineid': this.machineId,
      'cosy-machinetoken': this.machineToken,
      'cosy-machinetype': this.machineType,
      'cosy-clientip': '169.254.198.161',
      'login-version': 'v2',
      'user-agent': COSY_USER_AGENT,
      'cosy-machineos': COSY_MACHINE_OS,
    };
    if (sse) {
      h['cosy-machinehostname'] = this.machineHostname;
      h['cache-control'] = 'no-cache';
    }
    if (modelKey) {
      h['x-model-key'] = modelKey;
      h['x-model-source'] = 'system';
    }
    return h;
  }
}

class CosySessionCache {
  private entries = new Map<string, { token: string; session: CosySession }>();

  get(account: QoderAccount): CosySession {
    if (!account.accessToken) {
      throw new Error('COSY: token de acesso vazio na conta.');
    }
    const key = account.uid || account.accessToken.slice(0, 16);
    const hit = this.entries.get(key);
    if (hit && hit.token === account.accessToken) {
      return hit.session;
    }
    const session = new CosySession(account);
    this.entries.set(key, { token: account.accessToken, session });
    return session;
  }

  invalidate(uid: string): void {
    this.entries.delete(uid);
  }
}

export const COSY_SESSIONS = new CosySessionCache();
