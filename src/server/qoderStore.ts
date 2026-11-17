import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AccountQuotaBucket,
  DiscoveredAiProvider,
  ExternalProviderAccount,
  GatewayApiKey,
  GatewaySettings,
  HubOverview,
  OAuthLoginSession,
  ProviderPresetId,
  QoderAccount,
  RealmId,
  RequestLogEntry,
  RiskTelemetry,
  SafeAccountSummary,
  SafeProviderSummary,
} from '../types/hub.ts';
import { PROVIDER_PRESETS } from './providerPresets.ts';
import { COSY_SESSIONS, DEFAULT_USER_TYPE, deriveId } from './qoderSign.ts';
import { mergeUpstreamCatalog } from './qoderCatalog.ts';

export interface RealmConfig {
  id: RealmId;
  name: string;
  openapi: string;
  gateway: string;
  gatewayFallbacks: string[];
  website: string;
  clientId: string;
  redirectUri: string;
  domain: string;
  ua: string;
  hasCheckin: boolean;
  sendClientId: boolean;
  sendRedirectUri: boolean;
  nonceDashed: boolean;
}

export const REALM_CONFIGS: Record<RealmId, RealmConfig> = {
  intl: {
    id: 'intl',
    name: 'Global (qoder.com)',
    openapi: 'https://openapi.qoder.sh',
    gateway: process.env.QD_INTL_GATEWAY?.trim() || 'https://api3.qoder.sh',
    gatewayFallbacks: ['https://api2.qoder.sh', 'https://api1.qoder.sh'],
    website: 'https://qoder.com',
    clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
    redirectUri: 'qoder://aicoding.aicoding-agent/login-success',
    domain: 'qoder.com',
    ua: 'Qoder/1.1.75',
    hasCheckin: false,
    sendClientId: true,
    sendRedirectUri: false,
    nonceDashed: false,
  },
  cn: {
    id: 'cn',
    name: 'China (qoder.com.cn)',
    openapi: 'https://openapi.qoder.com.cn',
    gateway: process.env.QD_CN_GATEWAY?.trim() || 'https://gateway.qoder.com.cn',
    gatewayFallbacks: [],
    website: 'https://qoder.com.cn',
    clientId: '1c5e33e1-364d-4ce6-b02c-acaa81274a5c',
    redirectUri: 'qoder-work-cn://',
    domain: 'qoder.com.cn',
    ua: 'QoderWork/1.1.75',
    hasCheckin: true,
    sendClientId: true,
    sendRedirectUri: true,
    nonceDashed: true,
  },
};

const DATA_DIR = process.env.QD_DATA_DIR
  ? path.resolve(process.env.QD_DATA_DIR)
  : path.resolve(process.cwd(), '.qoder2api-data');
const STATE_FILE = path.join(DATA_DIR, 'hub-state.json');

interface PendingOAuth {
  state: string;
  verifier: string;
  nonce: string;
  realm: RealmId;
  authUrl: string;
  createdAt: number;
  expiresAt: number;
}

interface PersistedState {
  accounts: QoderAccount[];
  providers: ExternalProviderAccount[];
  settings: GatewaySettings;
  apiKeys: GatewayApiKey[];
  logs: RequestLogEntry[];
  risk: RiskTelemetry;
  totalRequests: number;
}

const DEFAULT_SETTINGS: GatewaySettings = {
  defaultRealm: 'intl',
  autoRealm: true,
  queueWaitMode: 'wait',
  trafficGuard: true,
  maxConcurrencyPerAccount: 2,
  autoCheckinEnabled: true,
  requireApiKey: false,
  autoFailoverEnabled: true,
  fallbackToQoderZeroX: true,
  autoRefreshTokens: true,
  bannedModels: [],
};

const STARTED_AT = Date.now();
const pendingLogins = new Map<string, PendingOAuth>();
const sessionAffinity = new Map<string, string>();
let roundRobinCursor = 0;

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadState(): PersistedState {
  ensureDataDir();
  if (fs.existsSync(STATE_FILE)) {
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      return {
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
        providers: Array.isArray(parsed.providers) ? parsed.providers : [],
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
        apiKeys: Array.isArray(parsed.apiKeys) ? parsed.apiKeys : [],
        logs: Array.isArray(parsed.logs) ? parsed.logs.slice(0, 200) : [],
        risk: {
          queueCount: parsed.risk?.queueCount ?? 0,
          rateLimitCount: parsed.risk?.rateLimitCount ?? 0,
          rejectedCount: parsed.risk?.rejectedCount ?? 0,
          versionGateCount: parsed.risk?.versionGateCount ?? 0,
          lastSignalAt: parsed.risk?.lastSignalAt,
          lastSignalDetail: parsed.risk?.lastSignalDetail,
        },
        totalRequests: parsed.totalRequests ?? 0,
      };
    } catch {
      // fall through to default state
    }
  }

  const defaultKey: GatewayApiKey = {
    id: `key-${crypto.randomBytes(4).toString('hex')}`,
    name: 'Android Default Key',
    key: `qd-${crypto.randomBytes(18).toString('hex')}`,
    realmLock: 'auto',
    createdAt: Date.now(),
    requestCount: 0,
  };

  return {
    accounts: [],
    providers: [],
    settings: { ...DEFAULT_SETTINGS },
    apiKeys: [defaultKey],
    logs: [],
    risk: {
      queueCount: 0,
      rateLimitCount: 0,
      rejectedCount: 0,
      versionGateCount: 0,
    },
    totalRequests: 0,
  };
}

let state: PersistedState = loadState();

export { state };

export function saveState(): void {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

export function sanitizeAccount(a: QoderAccount): SafeAccountSummary {
  const token = a.accessToken || '';
  const prefix = token.includes('-') ? `${token.split('-')[0]}-***` : token ? '***' : 'sem-token';
  return {
    uid: a.uid,
    nickname: a.nickname,
    email: a.email,
    realm: a.realm,
    source: a.source,
    tokenPrefix: prefix,
    expiresAt: a.expiresAt,
    enabled: a.enabled,
    userType: a.userType,
    organizationName: a.organizationName,
    creditsRemain: a.creditsRemain,
    creditsUsed: a.creditsUsed,
    creditsSize: a.creditsSize,
    quotaBuckets: a.quotaBuckets || [],
    planName: a.planName,
    checkinClaimedToday: a.checkinClaimedToday,
    lastCheckinAt: a.lastCheckinAt,
    lastQuotaSyncAt: a.lastQuotaSyncAt,
    cooldownUntil: a.cooldownUntil,
    lastError: a.lastError,
    requestCount: a.requestCount || 0,
    createdAt: a.createdAt,
  };
}

export function sanitizeProvider(p: ExternalProviderAccount): SafeProviderSummary {
  const key = p.apiKey || '';
  const keyPrefix = key.length > 8 ? `${key.slice(0, 6)}***${key.slice(-3)}` : key ? '***' : 'sem-chave';
  return {
    id: p.id,
    provider: p.provider,
    name: p.name,
    baseUrl: p.baseUrl,
    keyPrefix,
    defaultModel: p.defaultModel,
    protocol: p.protocol,
    enabled: p.enabled,
    priority: p.priority,
    cooldownUntil: p.cooldownUntil,
    lastError: p.lastError,
    requestCount: p.requestCount || 0,
    errorCount: p.errorCount || 0,
    failoverCount: p.failoverCount || 0,
    promptTokens: p.promptTokens || 0,
    completionTokens: p.completionTokens || 0,
    totalLatencyMs: p.totalLatencyMs || 0,
    createdAt: p.createdAt,
  };
}

export function getOverview(): HubOverview {
  const now = Math.floor(Date.now() / 1000);
  const safeAccounts = state.accounts.map(sanitizeAccount);
  const safeProviders = [...state.providers]
    .sort((a, b) => a.priority - b.priority)
    .map(sanitizeProvider);

  let creditsRemain = 0;
  let creditsUsed = 0;
  let creditsSize = 0;
  let enabledCount = 0;
  let cooldownCount = 0;

  for (const a of state.accounts) {
    if (a.enabled) enabledCount++;
    if (a.cooldownUntil && a.cooldownUntil > now) cooldownCount++;
    if (typeof a.creditsRemain === 'number') creditsRemain += a.creditsRemain;
    if (typeof a.creditsUsed === 'number') creditsUsed += a.creditsUsed;
    if (typeof a.creditsSize === 'number') creditsSize += a.creditsSize;
  }

  const providersEnabled = state.providers.filter((p) => p.enabled).length;

  return {
    version: '2.1.0-android',
    uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
    defaultRealm: state.settings.defaultRealm,
    autoRealm: state.settings.autoRealm,
    accounts: safeAccounts,
    providers: safeProviders,
    totals: {
      accountsTotal: state.accounts.length,
      accountsEnabled: enabledCount,
      accountsInCooldown: cooldownCount,
      providersTotal: state.providers.length,
      providersEnabled,
      creditsRemain,
      creditsUsed,
      creditsSize,
      totalRequests: state.totalRequests,
    },
    risk: state.risk,
    settings: state.settings,
    apiKeys: state.apiKeys,
    recentLogs: state.logs.slice(0, 60),
  };
}

export function getSettings(): GatewaySettings {
  return state.settings;
}

export function updateSettings(patch: Partial<GatewaySettings>): GatewaySettings {
  state.settings = {
    ...state.settings,
    ...patch,
    defaultRealm: patch.defaultRealm === 'cn' || patch.defaultRealm === 'intl'
      ? patch.defaultRealm
      : state.settings.defaultRealm,
  };
  saveState();
  return state.settings;
}

export function validateBearerKey(authHeader?: string, xApiKey?: string): {
  ok: boolean;
  keyEntry?: GatewayApiKey;
  error?: string;
} {
  const raw = (xApiKey || authHeader || '').trim();
  const token = raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : raw;
  if (!state.settings.requireApiKey && !token) {
    return { ok: true };
  }
  if (!token) {
    return { ok: false, error: 'API Key obrigatória para acessar o gateway.' };
  }
  const hit = state.apiKeys.find((k) => k.key === token);
  if (!hit) {
    if (!state.settings.requireApiKey) return { ok: true };
    return { ok: false, error: 'API Key inválida ou revogada.' };
  }
  hit.lastUsedAt = Date.now();
  hit.requestCount += 1;
  saveState();
  return { ok: true, keyEntry: hit };
}

export function createApiKey(name: string, realmLock: RealmId | 'auto' = 'auto'): GatewayApiKey {
  const entry: GatewayApiKey = {
    id: `key-${crypto.randomBytes(4).toString('hex')}`,
    name: name.trim() || 'Chave Android',
    key: `qd-${crypto.randomBytes(18).toString('hex')}`,
    realmLock,
    createdAt: Date.now(),
    requestCount: 0,
  };
  state.apiKeys.unshift(entry);
  saveState();
  return entry;
}

export function deleteApiKey(id: string): boolean {
  const before = state.apiKeys.length;
  state.apiKeys = state.apiKeys.filter((k) => k.id !== id);
  if (state.apiKeys.length !== before) {
    saveState();
    return true;
  }
  return false;
}

export function recordRequestLog(entry: Omit<RequestLogEntry, 'id' | 'timestamp'>): void {
  state.totalRequests += 1;
  state.logs.unshift({
    ...entry,
    id: `req-${crypto.randomBytes(4).toString('hex')}`,
    timestamp: Date.now(),
  });
  if (state.logs.length > 200) {
    state.logs = state.logs.slice(0, 200);
  }
  saveState();
}

export function recordRiskSignal(kind: 'queue' | 'rate' | 'rejected' | 'version', detail: string): void {
  if (kind === 'queue') state.risk.queueCount += 1;
  if (kind === 'rate') state.risk.rateLimitCount += 1;
  if (kind === 'rejected') state.risk.rejectedCount += 1;
  if (kind === 'version') state.risk.versionGateCount += 1;
  state.risk.lastSignalAt = Date.now();
  state.risk.lastSignalDetail = detail.slice(0, 240);
  saveState();
}

function makePkce(): { verifier: string; challenge: string } {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.randomBytes(64);
  let verifier = '';
  for (let i = 0; i < bytes.length; i++) {
    verifier += alphabet[bytes[i] % alphabet.length];
  }
  const challenge = crypto
    .createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return { verifier, challenge };
}

export function startOAuthLogin(realm: RealmId = 'intl'): OAuthLoginSession {
  const cfg = REALM_CONFIGS[realm];
  const { verifier, challenge } = makePkce();
  const nonce = cfg.nonceDashed ? crypto.randomUUID() : crypto.randomUUID().replace(/-/g, '');
  const machineId = deriveId('android-hub-device', 'machine');

  const params = new URLSearchParams({
    challenge,
    challenge_method: 'S256',
    nonce,
  });
  if (cfg.sendRedirectUri) {
    params.set('redirect_uri', cfg.redirectUri);
  }
  if (cfg.sendClientId) {
    params.set('client_id', cfg.clientId);
    params.set('machine_id', machineId);
  }

  const authUrl = `${cfg.website}/device/selectAccounts?${params.toString()}`;
  const stateId = `qd-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const expiresAt = Date.now() + 600_000;

  pendingLogins.set(stateId, {
    state: stateId,
    verifier,
    nonce,
    realm,
    authUrl,
    createdAt: Date.now(),
    expiresAt,
  });

  return {
    state: stateId,
    authUrl,
    realm,
    expiresAt,
  };
}

export async function pollOAuthLogin(stateId: string): Promise<{
  status: 'pending' | 'success' | 'expired' | 'unknown' | 'error';
  message: string;
  account?: SafeAccountSummary;
}> {
  const info = pendingLogins.get(stateId);
  if (!info) {
    return { status: 'unknown', message: 'Sessão OAuth não encontrada. Inicie o login novamente.' };
  }
  if (Date.now() > info.expiresAt) {
    pendingLogins.delete(stateId);
    return { status: 'expired', message: 'Janela de autorização expirada (10 min). Tente novamente.' };
  }

  const cfg = REALM_CONFIGS[info.realm];
  const q = new URLSearchParams({
    nonce: info.nonce,
    verifier: info.verifier,
    challenge_method: 'S256',
  });

  try {
    const res = await fetch(`${cfg.openapi}/api/v1/deviceToken/poll?${q.toString()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'QoderWork',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 404 || res.status === 202) {
      return { status: 'pending', message: 'Aguardando autorização no navegador Qoder...' };
    }

    const rawText = await res.text();
    if (!res.ok) {
      return {
        status: 'error',
        message: `HTTP ${res.status}: ${rawText.slice(0, 160)}`,
      };
    }

    const data = JSON.parse(rawText) as Record<string, unknown>;
    const token = String(data.token || data.device_token || '');
    if (!token) {
      return { status: 'pending', message: 'Aguardando confirmação do token...' };
    }

    const refreshToken = String(data.refresh_token || data.refreshToken || '');
    let uid = String(data.user_id || data.uid || '');
    let nickname = '';
    let email = '';
    let userType = DEFAULT_USER_TYPE;
    let orgId = '';
    let orgName = '';

    try {
      const uiRes = await fetch(`${cfg.openapi}/api/v1/userinfo`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': cfg.ua,
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(12000),
      });
      if (uiRes.ok) {
        const ui = (await uiRes.json()) as Record<string, unknown>;
        uid = String(ui.id || uid);
        nickname = String(ui.name || ui.nickname || '');
        email = String(ui.email || '');
        userType = String(ui.user_type || DEFAULT_USER_TYPE);
        orgId = String(ui.organization_id || ui.organizationId || '');
        orgName = String(ui.organization_name || ui.organizationName || '');
      }
    } catch {
      // userinfo is best-effort
    }

    const finalUid = uid || `q-${crypto.randomBytes(10).toString('hex')}`;
    const expiresInMs = Number(data.expires_in || 0);
    const expiresAt = expiresInMs > 0
      ? Math.floor(Date.now() / 1000 + (expiresInMs > 1000000 ? expiresInMs / 1000 : expiresInMs))
      : Math.floor(Date.now() / 1000 + 30 * 86400);

    const account: QoderAccount = {
      uid: finalUid,
      nickname: nickname || `Qoder-${finalUid.slice(-6)}`,
      email: email || undefined,
      realm: info.realm,
      source: 'oauth',
      accessToken: token,
      refreshToken,
      expiresAt,
      enabled: true,
      userType,
      organizationId: orgId || undefined,
      organizationName: orgName || undefined,
      creditsRemain: null,
      creditsUsed: null,
      creditsSize: null,
      quotaBuckets: [],
      requestCount: 0,
      createdAt: Date.now(),
    };

    upsertAccount(account);
    pendingLogins.delete(stateId);
    void syncAccountQuota(account.uid);

    return {
      status: 'success',
      message: 'Conta Qoder conectada com sucesso via OAuth.',
      account: sanitizeAccount(account),
    };
  } catch (err) {
    return {
      status: 'pending',
      message: err instanceof Error ? err.message : 'Consultando dispositivo Qoder...',
    };
  }
}

export async function importPatAccount(pat: string, realm: RealmId = 'intl'): Promise<SafeAccountSummary> {
  const cleanPat = pat.trim();
  if (!cleanPat.startsWith('pt-')) {
    throw new Error('O Personal Access Token (PAT) deve começar com "pt-".');
  }
  const cfg = REALM_CONFIGS[realm];
  const res = await fetch(`${cfg.openapi}/api/v1/jobToken/exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': cfg.ua,
    },
    body: JSON.stringify({ personal_token: cleanPat }),
    signal: AbortSignal.timeout(20000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Falha ao trocar PAT (${res.status}): ${text.slice(0, 180)}`);
  }

  const data = JSON.parse(text) as Record<string, unknown>;
  const token = String(data.token || '');
  if (!token) {
    throw new Error('O servidor Qoder não retornou jobToken para este PAT.');
  }

  let uid = '';
  let nickname = '';
  let email = '';
  let userType = DEFAULT_USER_TYPE;
  let orgId = '';
  let orgName = '';

  try {
    const uiRes = await fetch(`${cfg.openapi}/api/v1/userinfo`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': cfg.ua,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(12000),
    });
    if (uiRes.ok) {
      const ui = (await uiRes.json()) as Record<string, unknown>;
      uid = String(ui.id || '');
      nickname = String(ui.name || ui.nickname || '');
      email = String(ui.email || '');
      userType = String(ui.user_type || DEFAULT_USER_TYPE);
      orgId = String(ui.organization_id || ui.organizationId || '');
      orgName = String(ui.organization_name || ui.organizationName || '');
    }
  } catch {
    // best-effort userinfo
  }

  const finalUid = uid || `p-${crypto.randomBytes(10).toString('hex')}`;
  const expIn = Number(data.expires_in || 0);
  const expiresAt = expIn > 0
    ? Math.floor(Date.now() / 1000 + (expIn > 1000000 ? expIn / 1000 : expIn))
    : Math.floor(Date.now() / 1000 + 86400);

  const account: QoderAccount = {
    uid: finalUid,
    nickname: nickname || `PAT-${finalUid.slice(-6)}`,
    email: email || undefined,
    realm,
    source: 'pat',
    accessToken: token,
    refreshToken: String(data.refresh_token || ''),
    personalToken: cleanPat,
    expiresAt,
    enabled: true,
    userType,
    organizationId: orgId || undefined,
    organizationName: orgName || undefined,
    creditsRemain: null,
    creditsUsed: null,
    creditsSize: null,
    quotaBuckets: [],
    requestCount: 0,
    createdAt: Date.now(),
  };

  upsertAccount(account);
  await syncAccountQuota(account.uid).catch(() => undefined);
  return sanitizeAccount(findAccount(account.uid)!);
}

export function importAccountsJson(rawItems: unknown[]): { imported: number; skipped: number } {
  let imported = 0;
  let skipped = 0;
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') {
      skipped++;
      continue;
    }
    const obj = raw as Record<string, unknown>;
    const accessToken = String(obj.accessToken || obj.access_token || obj.token || '').trim();
    const pat = String(obj.personalToken || obj.personal_token || obj.pat || '').trim();
    if (!accessToken && !pat) {
      skipped++;
      continue;
    }
    const realm: RealmId = obj.realm === 'cn' ? 'cn' : 'intl';
    const uid = String(obj.uid || obj.id || `imp-${crypto.randomBytes(6).toString('hex')}`);
    const account: QoderAccount = {
      uid,
      nickname: String(obj.nickname || obj.name || `Conta-${uid.slice(-6)}`),
      email: obj.email ? String(obj.email) : undefined,
      realm,
      source: 'import',
      accessToken: accessToken || pat,
      refreshToken: String(obj.refreshToken || obj.refresh_token || ''),
      personalToken: pat || undefined,
      expiresAt: Number(obj.expiresAt || obj.expires_at || Math.floor(Date.now() / 1000 + 86400 * 7)),
      enabled: obj.enabled !== false,
      userType: String(obj.userType || obj.user_type || DEFAULT_USER_TYPE),
      creditsRemain: typeof obj.creditsRemain === 'number' ? obj.creditsRemain : null,
      creditsUsed: typeof obj.creditsUsed === 'number' ? obj.creditsUsed : null,
      creditsSize: typeof obj.creditsSize === 'number' ? obj.creditsSize : null,
      quotaBuckets: [],
      requestCount: 0,
      createdAt: Date.now(),
    };
    upsertAccount(account);
    imported++;
  }
  return { imported, skipped };
}

export function upsertAccount(account: QoderAccount): void {
  const idx = state.accounts.findIndex((a) => a.uid === account.uid && a.realm === account.realm);
  if (idx >= 0) {
    state.accounts[idx] = {
      ...state.accounts[idx],
      ...account,
      requestCount: state.accounts[idx].requestCount || 0,
    };
  } else {
    state.accounts.unshift(account);
  }
  COSY_SESSIONS.invalidate(account.uid);
  saveState();
}

export function findAccount(uid: string): QoderAccount | undefined {
  return state.accounts.find((a) => a.uid === uid);
}

export function getAllRawAccounts(): QoderAccount[] {
  return state.accounts;
}

export function toggleAccount(uid: string): SafeAccountSummary | null {
  const acc = findAccount(uid);
  if (!acc) return null;
  acc.enabled = !acc.enabled;
  if (acc.enabled) {
    acc.cooldownUntil = undefined;
    acc.lastError = undefined;
  }
  saveState();
  return sanitizeAccount(acc);
}

export function deleteAccount(uid: string): boolean {
  const before = state.accounts.length;
  state.accounts = state.accounts.filter((a) => a.uid !== uid);
  if (state.accounts.length !== before) {
    COSY_SESSIONS.invalidate(uid);
    saveState();
    return true;
  }
  return false;
}

export function markAccountCooldown(uid: string, seconds: number, errorMsg: string): void {
  const acc = findAccount(uid);
  if (!acc) return;
  acc.cooldownUntil = Math.floor(Date.now() / 1000) + Math.max(5, seconds);
  acc.lastError = errorMsg.slice(0, 200);
  saveState();
}

export function selectAccountForRequest(realm: RealmId, sessionKey?: string): QoderAccount | null {
  const now = Math.floor(Date.now() / 1000);
  const candidates = state.accounts.filter(
    (a) =>
      a.enabled &&
      a.realm === realm &&
      (!a.cooldownUntil || a.cooldownUntil <= now) &&
      (a.creditsRemain === null || a.creditsRemain > 0)
  );

  const fallbackPool =
    candidates.length > 0
      ? candidates
      : state.accounts.filter((a) => a.enabled && a.realm === realm && (!a.cooldownUntil || a.cooldownUntil <= now));

  if (fallbackPool.length === 0) return null;

  if (sessionKey && sessionAffinity.has(sessionKey)) {
    const stickyUid = sessionAffinity.get(sessionKey);
    const sticky = fallbackPool.find((a) => a.uid === stickyUid);
    if (sticky) {
      sticky.requestCount = (sticky.requestCount || 0) + 1;
      saveState();
      return sticky;
    }
  }

  roundRobinCursor = (roundRobinCursor + 1) % fallbackPool.length;
  const chosen = fallbackPool[roundRobinCursor];
  chosen.requestCount = (chosen.requestCount || 0) + 1;
  if (sessionKey) {
    sessionAffinity.set(sessionKey, chosen.uid);
  }
  saveState();
  return chosen;
}

function parseQuotaBuckets(payload: Record<string, unknown>): {
  buckets: AccountQuotaBucket[];
  remain: number;
  used: number;
  size: number;
} {
  const buckets: AccountQuotaBucket[] = [];
  const root = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<
    string,
    unknown
  >;

  const inspectItem = (src: unknown, kind: AccountQuotaBucket['kind'], defaultName: string) => {
    if (!src) return;
    if (Array.isArray(src)) {
      src.forEach((el, idx) => inspectItem(el, kind, `${defaultName} #${idx + 1}`));
      return;
    }
    if (typeof src !== 'object') return;
    const obj = src as Record<string, unknown>;
    const remainVal = Number(obj.remaining ?? obj.remain ?? obj.balance ?? NaN);
    const usedVal = Number(obj.used ?? 0);
    const sizeVal = Number(obj.total ?? obj.cap ?? obj.size ?? NaN);
    if (Number.isNaN(remainVal) && Number.isNaN(sizeVal)) return;

    const finalRemain = Number.isNaN(remainVal) ? Math.max(0, sizeVal - usedVal) : remainVal;
    const finalSize = Number.isNaN(sizeVal) ? finalRemain + usedVal : sizeVal;

    buckets.push({
      name: String(obj.name || defaultName),
      kind,
      remain: Math.max(0, Math.round(finalRemain)),
      used: Math.max(0, Math.round(usedVal)),
      size: Math.max(0, Math.round(finalSize)),
    });
  };

  inspectItem(root.userQuota ?? root.planQuota ?? root.subscriptionQuota, 'plan', 'Plano Base');
  inspectItem(
    root.sotaCredits ?? root.sotaQuota ?? root.dedicatedResourcePackages,
    'sota',
    'SOTA Credits'
  );
  inspectItem(root.addOnQuota ?? root.resourcePackages ?? root.packages, 'pack', 'Pacote Extra');
  inspectItem(root.orgResourcePackage ?? root.sharedQuota ?? root.teamQuota, 'shared', 'Pool Equipe');

  if (buckets.length === 0) {
    const directRemain = Number(root.remaining ?? root.remain ?? root.credits ?? NaN);
    const directUsed = Number(root.used ?? 0);
    const directTotal = Number(root.total ?? root.limit ?? NaN);
    if (!Number.isNaN(directRemain) || !Number.isNaN(directTotal)) {
      const r = Number.isNaN(directRemain) ? Math.max(0, directTotal - directUsed) : directRemain;
      const s = Number.isNaN(directTotal) ? r + directUsed : directTotal;
      buckets.push({
        name: 'Credits',
        kind: 'plan',
        remain: Math.round(r),
        used: Math.round(directUsed),
        size: Math.round(s),
      });
    }
  }

  let remain = 0;
  let used = 0;
  let size = 0;
  for (const b of buckets) {
    remain += b.remain;
    used += b.used;
    size += b.size;
  }
  return { buckets, remain, used, size };
}

export async function refreshAccountToken(uid: string): Promise<SafeAccountSummary> {
  const acc = findAccount(uid);
  if (!acc) throw new Error('Conta não encontrada.');
  const cfg = REALM_CONFIGS[acc.realm];

  if (acc.refreshToken.startsWith('drt-')) {
    const res = await fetch(`${cfg.openapi}/api/v1/deviceToken/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': cfg.ua,
      },
      body: JSON.stringify({ refresh_token: acc.refreshToken }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      if (data.token || data.device_token) {
        acc.accessToken = String(data.token || data.device_token);
        if (data.refresh_token) acc.refreshToken = String(data.refresh_token);
        acc.lastError = undefined;
        acc.cooldownUntil = undefined;
        COSY_SESSIONS.invalidate(acc.uid);
        saveState();
      }
    } else {
      throw new Error(`Refresh falhou (${res.status})`);
    }
  } else if (acc.personalToken?.startsWith('pt-')) {
    await importPatAccount(acc.personalToken, acc.realm);
  }

  await syncAccountQuota(uid).catch(() => undefined);
  return sanitizeAccount(findAccount(uid)!);
}

export async function syncAccountQuota(uid: string): Promise<SafeAccountSummary> {
  const acc = findAccount(uid);
  if (!acc) throw new Error('Conta não encontrada.');
  const cfg = REALM_CONFIGS[acc.realm];

  const candidateUrls = [
    `${cfg.openapi}/api/v2/quota/usage`,
    `${cfg.openapi}/api/v1/quota/usage`,
    `${cfg.website}/sash/api/v1/me/quota`,
    `${cfg.website}/sash/api/v1/me/credits`,
  ];

  let synced = false;
  let lastErr = '';

  for (const url of candidateUrls) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${acc.accessToken}`,
          'User-Agent': cfg.ua,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      const json = (await res.json()) as Record<string, unknown>;
      const parsed = parseQuotaBuckets(json);
      if (parsed.buckets.length > 0 || parsed.size > 0 || parsed.remain > 0) {
        acc.quotaBuckets = parsed.buckets;
        acc.creditsRemain = parsed.remain;
        acc.creditsUsed = parsed.used;
        acc.creditsSize = parsed.size;
        acc.lastQuotaSyncAt = Date.now();
        acc.lastError = undefined;
        synced = true;
        break;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : 'Erro de rede';
    }
  }

  if (!synced && lastErr) {
    acc.lastQuotaSyncAt = Date.now();
    acc.lastError = `Quota: ${lastErr}`;
  }

  saveState();
  return sanitizeAccount(acc);
}

export async function claimDailyCheckin(uid: string): Promise<{
  ok: boolean;
  message: string;
  account: SafeAccountSummary;
}> {
  const acc = findAccount(uid);
  if (!acc) throw new Error('Conta não encontrada.');
  const cfg = REALM_CONFIGS[acc.realm];

  try {
    const res = await fetch(`${cfg.openapi}/sash/api/v1/me/daily-check-in/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${acc.accessToken}`,
        'User-Agent': cfg.ua,
      },
      body: '{}',
      signal: AbortSignal.timeout(12000),
    });
    const text = await res.text();
    if (res.ok) {
      acc.checkinClaimedToday = true;
      acc.lastCheckinAt = Date.now();
      acc.lastError = undefined;
      saveState();
      await syncAccountQuota(uid).catch(() => undefined);
      return {
        ok: true,
        message: 'Check-in diário reivindicado com sucesso.',
        account: sanitizeAccount(findAccount(uid)!),
      };
    }
    return {
      ok: false,
      message: `Check-in retornou HTTP ${res.status}: ${text.slice(0, 140)}`,
      account: sanitizeAccount(acc),
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Erro ao reivindicar check-in.',
      account: sanitizeAccount(acc),
    };
  }
}

export async function refreshCatalogFromUpstream(realm: RealmId): Promise<{
  updated: number;
  realm: RealmId;
  message: string;
}> {
  const acc = state.accounts.find((a) => a.enabled && a.realm === realm);
  if (!acc) {
    return {
      updated: 0,
      realm,
      message: `Nenhuma conta ${realm.toUpperCase()} ativa para consultar o catálogo oficial. Usando catálogo embutido.`,
    };
  }
  const cfg = REALM_CONFIGS[realm];
  const rawUrl = `${cfg.gateway}/algo/api/v2/model/list?Encode=1`;
  const session = COSY_SESSIONS.get(acc);
  const headers = session.headers('', rawUrl, '', false);

  try {
    const res = await fetch(rawUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      return { updated: 0, realm, message: `Upstream HTTP ${res.status}` };
    }
    const data = (await res.json()) as unknown;
    const list = Array.isArray(data)
      ? data
      : Array.isArray((data as Record<string, unknown>)?.models)
        ? ((data as Record<string, unknown>).models as unknown[])
        : [];
    const updated = mergeUpstreamCatalog(list, realm);
    return { updated, realm, message: `${updated} modelos sincronizados do Qoder ${realm.toUpperCase()}.` };
  } catch (err) {
    return {
      updated: 0,
      realm,
      message: err instanceof Error ? err.message : 'Falha de rede ao consultar modelos.',
    };
  }
}

// ---------------------------------------------------------------------------
// Multi-Provider AI Code Assistant Pool (Failover Chain)
// ---------------------------------------------------------------------------

function isLocalEndpointUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return ['localhost', '[::1]', '::1', '0.0.0.0'].includes(host) ||
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d/.test(host);
  } catch { return false; }
}

function validateProviderInput(input: { provider?: string; baseUrl?: string; apiKey?: string; defaultModel?: string }): void {
  const preset = PROVIDER_PRESETS.find((p) => p.id === input.provider);
  if (!preset) throw new Error('Provedor desconhecido; use o preset Customizada.');
  const baseUrl = (input.baseUrl || preset.baseUrl).trim();
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('Informe uma URL base válida.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('A URL base deve ser HTTP/HTTPS, sem senha, consulta ou fragmento.');
  }
  if (!isLocalEndpointUrl(baseUrl) && url.protocol !== 'https:') throw new Error('APIs remotas devem usar HTTPS para proteger sua chave.');
  if (!(input.defaultModel || preset.defaultModel).trim()) throw new Error('Informe o nome do modelo.');
  if (!input.apiKey?.trim() && preset.requiresKey && !isLocalEndpointUrl(baseUrl)) throw new Error('Informe a API Key do provedor de IA.');
}

export function addProviderAccount(input: {
  provider: ProviderPresetId;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  protocol?: 'openai' | 'anthropic';
}): SafeProviderSummary {
  validateProviderInput(input);
  const preset = PROVIDER_PRESETS.find((p) => p.id === input.provider) || PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
  const baseUrl = (input.baseUrl || preset.baseUrl).trim().replace(/\/+$/, '');
  const apiKey = (input.apiKey || '').trim();
  const isLocal = !preset.requiresKey || isLocalEndpointUrl(baseUrl);

  if (!apiKey && !isLocal) {
    throw new Error('Informe a API Key do provedor de IA.');
  }

  const maxPriority = state.providers.reduce((max, p) => Math.max(max, p.priority), 0);
  const protocol: 'openai' | 'anthropic' =
    input.protocol === 'anthropic'
      ? 'anthropic'
      : input.protocol === 'openai'
        ? 'openai'
        : preset.protocol;

  const entry: ExternalProviderAccount = {
    id: `prv-${crypto.randomBytes(4).toString('hex')}`,
    provider: input.provider || preset.id,
    name: (input.name || preset.name).trim(),
    baseUrl,
    apiKey: apiKey || 'local-no-key',
    defaultModel: (input.defaultModel || preset.defaultModel).trim(),
    protocol,
    enabled: true,
    priority: maxPriority + 1,
    requestCount: 0,
    errorCount: 0,
    failoverCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalLatencyMs: 0,
    createdAt: Date.now(),
  };

  state.providers.push(entry);
  saveState();
  return sanitizeProvider(entry);
}

export function addProviderAccountsBatch(
  items: Array<{
    provider: ProviderPresetId;
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    defaultModel?: string;
    protocol?: 'openai' | 'anthropic';
  }>
): SafeProviderSummary[] {
  // Validate the entire batch before persisting any key (avoid half-saved submissions).
  if (!items.length || items.length > 200) throw new Error('Envie entre 1 e 200 chaves por lote.');
  for (const item of items) validateProviderInput(item);
  const created: SafeProviderSummary[] = [];
  for (const item of items) {
    created.push(addProviderAccount(item));
  }
  return created;
}

export function updateProviderAccount(
  id: string,
  patch: {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    defaultModel?: string;
    protocol?: 'openai' | 'anthropic';
  }
): SafeProviderSummary | null {
  const prv = state.providers.find((p) => p.id === id);
  if (!prv) return null;
  validateProviderInput({ provider: prv.provider, baseUrl: patch.baseUrl?.trim() || prv.baseUrl,
    apiKey: patch.apiKey?.trim() || prv.apiKey, defaultModel: patch.defaultModel?.trim() || prv.defaultModel });

  if (typeof patch.name === 'string' && patch.name.trim()) {
    prv.name = patch.name.trim();
  }
  if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) {
    prv.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '');
  }
  if (typeof patch.defaultModel === 'string' && patch.defaultModel.trim()) {
    prv.defaultModel = patch.defaultModel.trim();
  }
  if (patch.protocol === 'anthropic' || patch.protocol === 'openai') {
    prv.protocol = patch.protocol;
  }
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
    prv.apiKey = patch.apiKey.trim();
  }
  prv.cooldownUntil = undefined;
  prv.lastError = undefined;
  saveState();
  return sanitizeProvider(prv);
}

export function toggleProviderAccount(id: string): SafeProviderSummary | null {
  const prv = state.providers.find((p) => p.id === id);
  if (!prv) return null;
  prv.enabled = !prv.enabled;
  if (prv.enabled) {
    prv.cooldownUntil = undefined;
    prv.lastError = undefined;
  }
  saveState();
  return sanitizeProvider(prv);
}

export function moveProviderPriority(id: string, direction: 'up' | 'down'): SafeProviderSummary[] {
  const ordered = [...state.providers].sort((a, b) => a.priority - b.priority);
  const idx = ordered.findIndex((p) => p.id === id);
  if (idx !== -1) {
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx >= 0 && swapIdx < ordered.length) {
      const tmp = ordered[idx];
      ordered[idx] = ordered[swapIdx];
      ordered[swapIdx] = tmp;
    }
    ordered.forEach((p, i) => {
      p.priority = i + 1;
    });
    saveState();
  }
  return ordered.map(sanitizeProvider);
}

export function deleteProviderAccount(id: string): boolean {
  const before = state.providers.length;
  state.providers = state.providers.filter((p) => p.id !== id);
  if (state.providers.length !== before) {
    saveState();
    return true;
  }
  return false;
}

export function getOrderedActiveProviders(): ExternalProviderAccount[] {
  const now = Math.floor(Date.now() / 1000);
  return [...state.providers]
    .filter((p) => p.enabled && (!p.cooldownUntil || p.cooldownUntil <= now))
    .sort((a, b) => a.priority - b.priority);
}

export function getAllRawProviders(): ExternalProviderAccount[] {
  return [...state.providers].sort((a, b) => a.priority - b.priority);
}

export function markProviderCooldown(id: string, seconds: number, errorMsg: string): void {
  const prv = state.providers.find((p) => p.id === id);
  if (!prv) return;
  prv.errorCount = (prv.errorCount || 0) + 1;
  prv.cooldownUntil = Math.floor(Date.now() / 1000) + Math.max(10, seconds);
  prv.lastError = errorMsg.slice(0, 200);
  saveState();
}

export function recordProviderSuccess(
  id: string,
  wasFailover: boolean,
  usage?: { promptTokens?: number; completionTokens?: number; latencyMs?: number }
): void {
  const prv = state.providers.find((p) => p.id === id);
  if (!prv) return;
  prv.requestCount = (prv.requestCount || 0) + 1;
  if (wasFailover) prv.failoverCount = (prv.failoverCount || 0) + 1;
  if (usage?.promptTokens) prv.promptTokens = (prv.promptTokens || 0) + usage.promptTokens;
  if (usage?.completionTokens) prv.completionTokens = (prv.completionTokens || 0) + usage.completionTokens;
  if (usage?.latencyMs) prv.totalLatencyMs = (prv.totalLatencyMs || 0) + usage.latencyMs;
  prv.lastError = undefined;
  prv.cooldownUntil = undefined;
  saveState();
}

export function addProviderUsage(
  id: string,
  usage: { promptTokens?: number; completionTokens?: number; latencyMs?: number }
): void {
  const prv = state.providers.find((p) => p.id === id);
  if (!prv) return;
  if (usage.promptTokens) prv.promptTokens = (prv.promptTokens || 0) + usage.promptTokens;
  if (usage.completionTokens) prv.completionTokens = (prv.completionTokens || 0) + usage.completionTokens;
  if (usage.latencyMs) prv.totalLatencyMs = (prv.totalLatencyMs || 0) + usage.latencyMs;
  saveState();
}

export async function testProviderAccount(id: string): Promise<{
  ok: boolean;
  message: string;
  provider: SafeProviderSummary;
}> {
  const prv = state.providers.find((p) => p.id === id);
  if (!prv) throw new Error('Provedor não encontrado.');

  const startedAt = Date.now();
  try {
    if (prv.protocol === 'anthropic') {
      const res = await fetch(`${prv.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': prv.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: prv.defaultModel,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(15000),
      });
      const latencyMs = Date.now() - startedAt;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        prv.errorCount = (prv.errorCount || 0) + 1;
        prv.lastError = `HTTP ${res.status}: ${text.slice(0, 140)}`;
        recordRequestLog({
          protocol: 'anthropic-messages',
          model: prv.defaultModel,
          realm: 'intl',
          provider: prv.name,
          accountUid: prv.id,
          accountNickname: prv.name,
          status: res.status,
          latencyMs,
          stream: false,
          error: prv.lastError,
        });
        return { ok: false, message: prv.lastError, provider: sanitizeProvider(prv) };
      }
      const data = (await res.json().catch(() => ({}))) as {
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const pt = Number(data.usage?.input_tokens || 4);
      const ct = Number(data.usage?.output_tokens || 4);
      recordProviderSuccess(prv.id, false, { promptTokens: pt, completionTokens: ct, latencyMs });
      recordRequestLog({
        protocol: 'anthropic-messages',
        model: prv.defaultModel,
        realm: 'intl',
        provider: prv.name,
        accountUid: prv.id,
        accountNickname: prv.name,
        status: 200,
        latencyMs,
        stream: false,
        promptTokens: pt,
        completionTokens: ct,
      });
      return {
        ok: true,
        message: `Conectado em ${latencyMs}ms (${prv.defaultModel}).`,
        provider: sanitizeProvider(prv),
      };
    }

    const res = await fetch(`${prv.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${prv.apiKey}`,
      },
      body: JSON.stringify({
        model: prv.defaultModel,
        max_tokens: 16,
        stream: false,
        messages: [{ role: 'user', content: 'Reply with OK' }],
      }),
      signal: AbortSignal.timeout(15000),
    });

    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      if (isLocalEndpointUrl(prv.baseUrl)) {
        const modelsRes = await fetch(`${prv.baseUrl}/models`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        }).catch(() => null);
        if (modelsRes?.ok) {
          recordProviderSuccess(prv.id, false, { latencyMs });
          recordRequestLog({
            protocol: 'openai-chat',
            model: prv.defaultModel,
            realm: 'intl',
            provider: prv.name,
            accountUid: prv.id,
            accountNickname: prv.name,
            status: 200,
            latencyMs,
            stream: false,
          });
          return {
            ok: true,
            message: `Servidor local acessível em ${latencyMs}ms (${prv.defaultModel}).`,
            provider: sanitizeProvider(prv),
          };
        }
      }
      const text = await res.text().catch(() => '');
      prv.errorCount = (prv.errorCount || 0) + 1;
      prv.lastError = `HTTP ${res.status}: ${text.slice(0, 140)}`;
      recordRequestLog({
        protocol: 'openai-chat',
        model: prv.defaultModel,
        realm: 'intl',
        provider: prv.name,
        accountUid: prv.id,
        accountNickname: prv.name,
        status: res.status,
        latencyMs,
        stream: false,
        error: prv.lastError,
      });
      return { ok: false, message: prv.lastError, provider: sanitizeProvider(prv) };
    }

    const data = (await res.json().catch(() => ({}))) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const pt = Number(data.usage?.prompt_tokens || 6);
    const ct = Number(data.usage?.completion_tokens || 2);
    recordProviderSuccess(prv.id, false, { promptTokens: pt, completionTokens: ct, latencyMs });
    recordRequestLog({
      protocol: 'openai-chat',
      model: prv.defaultModel,
      realm: 'intl',
      provider: prv.name,
      accountUid: prv.id,
      accountNickname: prv.name,
      status: 200,
      latencyMs,
      stream: false,
      promptTokens: pt,
      completionTokens: ct,
    });
    return {
      ok: true,
      message: `API ativa em ${latencyMs}ms (${prv.defaultModel}).`,
      provider: sanitizeProvider(prv),
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    prv.errorCount = (prv.errorCount || 0) + 1;
    prv.lastError = isLocalEndpointUrl(prv.baseUrl)
      ? `Servidor local offline (${prv.baseUrl})`
      : err instanceof Error
        ? err.message
        : 'Erro de conexão';
    recordRequestLog({
      protocol: prv.protocol === 'anthropic' ? 'anthropic-messages' : 'openai-chat',
      model: prv.defaultModel,
      realm: 'intl',
      provider: prv.name,
      accountUid: prv.id,
      accountNickname: prv.name,
      status: 503,
      latencyMs,
      stream: false,
      error: prv.lastError,
    });
    return { ok: false, message: prv.lastError, provider: sanitizeProvider(prv) };
  }
}

const CODING_MODEL_REGEX =
  /coder|code|codestral|devstral|starcoder|deepseek|qwen|llama|mistral|gemma|r1|reasoning|nemotron|gpt|claude|grok/i;

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

function isAlreadyConfigured(baseUrl: string, model: string): boolean {
  const normUrl = normalizeBaseUrl(baseUrl);
  const normModel = model.trim().toLowerCase();
  return state.providers.some(
    (p) => normalizeBaseUrl(p.baseUrl) === normUrl && p.defaultModel.trim().toLowerCase() === normModel
  );
}

export async function discoverCodingProviders(): Promise<{
  discovered: DiscoveredAiProvider[];
  sourcesChecked: string[];
}> {
  const discovered: DiscoveredAiProvider[] = [];
  const seenKeys = new Set<string>();
  const sourcesChecked: string[] = [];

  const pushItem = (item: DiscoveredAiProvider) => {
    const key = `${normalizeBaseUrl(item.baseUrl)}::${item.defaultModel.trim().toLowerCase()}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    discovered.push(item);
  };

  // 1. Probe Local AI Coding Engines (Ollama, LM Studio, LocalAI / vLLM / llama.cpp)
  const localProbes = [
    async () => {
      try {
        const res = await fetch('http://127.0.0.1:11434/api/tags', {
          signal: AbortSignal.timeout(1300),
        });
        if (!res.ok) return;
        sourcesChecked.push('Ollama Local (11434)');
        const data = (await res.json()) as { models?: Array<{ name?: string; details?: { parameter_size?: string } }> };
        const models = Array.isArray(data.models) ? data.models : [];
        for (const m of models.slice(0, 8)) {
          const modelId = String(m.name || '').trim();
          if (!modelId) continue;
          const baseUrl = 'http://127.0.0.1:11434/v1';
          pushItem({
            id: `disc-ollama-${modelId}`,
            provider: 'ollama',
            name: `Ollama · ${modelId}`,
            baseUrl,
            defaultModel: modelId,
            protocol: 'openai',
            source: 'local-scan',
            requiresKey: false,
            canAutoAdd: true,
            alreadyConfigured: isAlreadyConfigured(baseUrl, modelId),
            description: `Modelo local detectado no Ollama${m.details?.parameter_size ? ` (${m.details.parameter_size})` : ''}. Sem chave de API.`,
          });
        }
      } catch {
        // Ollama not running locally
      }
    },
    async () => {
      const localServers: Array<{ label: string; provider: ProviderPresetId; baseUrl: string }> = [
        { label: 'LM Studio (1234)', provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' },
        { label: 'Jan Local (1337)', provider: 'custom', baseUrl: 'http://127.0.0.1:1337/v1' },
        { label: 'LocalAI / llama.cpp (8080)', provider: 'custom', baseUrl: 'http://127.0.0.1:8080/v1' },
        { label: 'vLLM / Local OpenAI (8000)', provider: 'custom', baseUrl: 'http://127.0.0.1:8000/v1' },
      ];
      await Promise.all(
        localServers.map(async (srv) => {
          try {
            const res = await fetch(`${srv.baseUrl}/models`, { signal: AbortSignal.timeout(1200) });
            if (!res.ok) return;
            const data = (await res.json()) as {
              data?: Array<{ id?: string; owned_by?: string; qoder_key?: string }>;
            };
            const models = Array.isArray(data.data) ? data.data : [];
            const isSelfHub = models.some(
              (m) => m.owned_by === 'qoder2api-hub' || m.id === 'auto-failover' || Boolean(m.qoder_key)
            );
            if (isSelfHub || models.length === 0) return;

            sourcesChecked.push(srv.label);
            for (const m of models.slice(0, 6)) {
              const modelId = String(m.id || '').trim();
              if (!modelId) continue;
              pushItem({
                id: `disc-${srv.provider}-${modelId}`,
                provider: srv.provider,
                name: `${srv.label.split(' ')[0]} · ${modelId}`,
                baseUrl: srv.baseUrl,
                defaultModel: modelId,
                protocol: 'openai',
                source: 'local-scan',
                requiresKey: false,
                canAutoAdd: true,
                alreadyConfigured: isAlreadyConfigured(srv.baseUrl, modelId),
                description: `Servidor local detectado em ${srv.baseUrl}. Pronto para uso offline.`,
              });
            }
          } catch {
            // server not running on this port
          }
        })
      );
    },
  ];

  // 2. Probe OpenRouter live public :free coding models catalog
  const openRouterKeyAvailable = state.providers.some(
    (p) =>
      p.provider === 'openrouter' &&
      Boolean(p.apiKey) &&
      p.apiKey !== 'local-no-key'
  );

  const openRouterProbe = async () => {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4500),
      });
      if (!res.ok) return;
      sourcesChecked.push('OpenRouter Catálogo :free');
      const data = (await res.json()) as {
        data?: Array<{ id?: string; name?: string; context_length?: number; description?: string }>;
      };
      const allModels = Array.isArray(data.data) ? data.data : [];
      const freeCoding = allModels
        .filter((m) => {
          const id = String(m.id || '');
          return id.endsWith(':free') && CODING_MODEL_REGEX.test(`${id} ${m.name || ''}`);
        })
        .sort((a, b) => {
          const aCoder = /coder|devstral|codestral|deepseek/i.test(String(a.id)) ? 0 : 1;
          const bCoder = /coder|devstral|codestral|deepseek/i.test(String(b.id)) ? 0 : 1;
          if (aCoder !== bCoder) return aCoder - bCoder;
          return (b.context_length || 0) - (a.context_length || 0);
        })
        .slice(0, 12);

      const baseUrl = 'https://openrouter.ai/api/v1';
      for (const m of freeCoding) {
        const modelId = String(m.id || '').trim();
        if (!modelId) continue;
        const cleanTitle = String(m.name || modelId).replace(/\s*\(free\)\s*/i, '').trim();
        pushItem({
          id: `disc-or-${modelId}`,
          provider: 'openrouter',
          name: `OpenRouter · ${cleanTitle}`,
          baseUrl,
          defaultModel: modelId,
          protocol: 'openai',
          source: 'openrouter-free',
          requiresKey: true,
          canAutoAdd: openRouterKeyAvailable,
          contextLength: typeof m.context_length === 'number' ? m.context_length : undefined,
          alreadyConfigured: isAlreadyConfigured(baseUrl, modelId),
          description: openRouterKeyAvailable
            ? 'Modelo :free ao vivo do OpenRouter — reutiliza sua chave OpenRouter já salva.'
            : 'Modelo :free ao vivo do OpenRouter — clique para preencher e informar sua chave OpenRouter gratuita.',
        });
      }
    } catch {
      // ignore network failure
    }
  };

  // 3. Probe Pollinations public zero-key catalog
  const pollinationsProbe = async () => {
    try {
      const res = await fetch('https://text.pollinations.ai/models', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return;
      sourcesChecked.push('Pollinations (Sem Chave)');
      const list = (await res.json()) as Array<{
        name?: string;
        description?: string;
        audio?: boolean;
        reasoning?: boolean;
      }>;
      if (!Array.isArray(list)) return;
      const baseUrl = 'https://text.pollinations.ai/openai';
      const filtered = list
        .filter((m) => !m.audio && m.name && CODING_MODEL_REGEX.test(`${m.name} ${m.description || ''}`))
        .slice(0, 6);

      for (const m of filtered) {
        const modelId = String(m.name || '').trim();
        if (!modelId) continue;
        pushItem({
          id: `disc-poll-${modelId}`,
          provider: 'pollinations',
          name: `Pollinations · ${modelId}`,
          baseUrl,
          defaultModel: modelId,
          protocol: 'openai',
          source: 'pollinations',
          requiresKey: false,
          canAutoAdd: true,
          alreadyConfigured: isAlreadyConfigured(baseUrl, modelId),
          description: m.description
            ? `${String(m.description).slice(0, 110)} (Grátis sem chave)`
            : 'Endpoint público Pollinations AI sem necessidade de API Key.',
        });
      }
    } catch {
      // ignore network failure
    }
  };

  // 4. Probe user's already-saved OpenAI-compatible providers for extra coding models
  const configuredProbes = state.providers
    .filter((p) => p.enabled && p.protocol === 'openai' && p.provider !== 'openrouter' && !isLocalEndpointUrl(p.baseUrl))
    .slice(0, 4)
    .map(async (prv) => {
      try {
        const res = await fetch(`${prv.baseUrl}/models`, {
          headers: { Authorization: `Bearer ${prv.apiKey}` },
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return;
        sourcesChecked.push(prv.name);
        const data = (await res.json()) as { data?: Array<{ id?: string }> };
        const models = Array.isArray(data.data) ? data.data : [];
        const coding = models
          .map((m) => String(m.id || '').trim())
          .filter((id) => Boolean(id) && CODING_MODEL_REGEX.test(id))
          .slice(0, 4);

        for (const modelId of coding) {
          pushItem({
            id: `disc-sync-${prv.id}-${modelId}`,
            provider: prv.provider,
            name: `${prv.name} · ${modelId}`,
            baseUrl: prv.baseUrl,
            defaultModel: modelId,
            protocol: prv.protocol,
            source: 'endpoint-sync',
            requiresKey: Boolean(prv.apiKey && prv.apiKey !== 'local-no-key'),
            canAutoAdd: true,
            alreadyConfigured: isAlreadyConfigured(prv.baseUrl, modelId),
            description: `Descoberto diretamente na sua conta ${prv.name} — 1 clique adiciona usando a mesma chave.`,
          });
        }
      } catch {
        // ignore providers without /models endpoint
      }
    });

  // 5. Probe Hugging Face Router public inference catalog for top coding models
  const hfKeyAvailable = state.providers.some(
    (p) => p.provider === 'huggingface' && Boolean(p.apiKey) && p.apiKey !== 'local-no-key'
  );
  const hfProbe = async () => {
    try {
      const res = await fetch('https://router.huggingface.co/v1/models', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return;
      sourcesChecked.push('Hugging Face Router (Cota Grátis)');
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const models = Array.isArray(data.data) ? data.data : [];
      const baseUrl = 'https://router.huggingface.co/v1';
      const coding = models
        .map((m) => String(m.id || '').trim())
        .filter((id) => Boolean(id) && /coder|deepseek|qwen|devstral|codestral/i.test(id))
        .slice(0, 6);

      for (const modelId of coding) {
        pushItem({
          id: `disc-hf-${modelId}`,
          provider: 'huggingface',
          name: `HF Router · ${modelId.split('/').pop() || modelId}`,
          baseUrl,
          defaultModel: modelId,
          protocol: 'openai',
          source: 'endpoint-sync',
          requiresKey: true,
          canAutoAdd: hfKeyAvailable,
          alreadyConfigured: isAlreadyConfigured(baseUrl, modelId),
          description: hfKeyAvailable
            ? 'Modelo de código no Hugging Face Router — reutiliza seu token HF salvo.'
            : 'Modelo gratuito via token HF — clique para preencher e informar seu token Hugging Face.',
        });
      }
    } catch {
      // ignore network failure
    }
  };

  await Promise.all([
    ...localProbes.map((fn) => fn()),
    openRouterProbe(),
    pollinationsProbe(),
    hfProbe(),
    ...configuredProbes,
  ]);

  return { discovered, sourcesChecked };
}

export function addDiscoveredProvider(item: {
  provider: ProviderPresetId;
  name: string;
  baseUrl: string;
  defaultModel: string;
  protocol?: 'openai' | 'anthropic';
  source?: DiscoveredAiProvider['source'];
  apiKey?: string;
}): SafeProviderSummary {
  const normUrl = normalizeBaseUrl(item.baseUrl);
  const existing = state.providers.find(
    (p) =>
      normalizeBaseUrl(p.baseUrl) === normUrl &&
      p.defaultModel.trim().toLowerCase() === item.defaultModel.trim().toLowerCase()
  );
  if (existing) {
    return sanitizeProvider(existing);
  }

  let resolvedKey = (item.apiKey || '').trim();
  if (!resolvedKey) {
    const keyDonor =
      state.providers.find((p) => normalizeBaseUrl(p.baseUrl) === normUrl && p.apiKey && p.apiKey !== 'local-no-key') ||
      (item.provider === 'openrouter'
        ? state.providers.find((p) => p.provider === 'openrouter' && p.apiKey && p.apiKey !== 'local-no-key')
        : undefined);
    if (keyDonor) {
      resolvedKey = keyDonor.apiKey;
    }
  }

  return addProviderAccount({
    provider: item.provider,
    name: item.name,
    baseUrl: item.baseUrl,
    apiKey: resolvedKey,
    defaultModel: item.defaultModel,
    protocol: item.protocol || 'openai',
  });
}

// Background self-healing scheduler: refreshes expiring tokens & runs daily check-in
async function runBackgroundMaintenance(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (state.settings.autoRefreshTokens) {
    for (const acc of state.accounts) {
      if (!acc.enabled) continue;
      const expiresSoon = acc.expiresAt > 0 && acc.expiresAt - nowSec < 43200; // < 12h
      if (expiresSoon && acc.refreshToken) {
        await refreshAccountToken(acc.uid).catch(() => undefined);
      }
    }
  }
  if (state.settings.autoCheckinEnabled) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    for (const acc of state.accounts) {
      if (!acc.enabled) continue;
      const needsCheckin = !acc.lastCheckinAt || acc.lastCheckinAt < startOfDay.getTime();
      if (needsCheckin && acc.realm === 'cn') {
        await claimDailyCheckin(acc.uid).catch(() => undefined);
      }
    }
  }
}

const maintenanceTimer = setInterval(() => {
  void runBackgroundMaintenance();
}, 30 * 60 * 1000);
if (typeof maintenanceTimer.unref === 'function') {
  maintenanceTimer.unref();
}

