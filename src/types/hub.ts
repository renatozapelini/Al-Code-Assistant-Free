export type RealmId = 'intl' | 'cn';

export type NavTab = 'options' | 'projects' | 'hub' | 'chat' | 'scripts' | 'accounts' | 'apis' | 'analytics' | 'models' | 'android';

export type ProviderPresetId =
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'grok'
  | 'gemini'
  | 'openrouter'
  | 'groq'
  | 'github'
  | 'mistral'
  | 'cerebras'
  | 'together'
  | 'nvidia'
  | 'huggingface'
  | 'sambanova'
  | 'fireworks'
  | 'qwen'
  | 'kimi'
  | 'zhipu'
  | 'perplexity'
  | 'cloudflare'
  | 'pollinations'
  | 'ollama'
  | 'lmstudio'
  | 'custom';

export type ProviderCategory = 'free_tier' | 'major' | 'local' | 'custom';

export interface ProviderPreset {
  id: ProviderPresetId;
  name: string;
  badge: string;
  category: ProviderCategory;
  requiresKey: boolean;
  baseUrl: string;
  defaultModel: string;
  suggestedModels: string[];
  protocol: 'openai' | 'anthropic';
  signupUrl: string;
  description: string;
}

export interface ExternalProviderAccount {
  id: string;
  provider: ProviderPresetId;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  protocol: 'openai' | 'anthropic';
  enabled: boolean;
  priority: number;
  cooldownUntil?: number;
  lastError?: string;
  requestCount: number;
  errorCount: number;
  failoverCount: number;
  promptTokens: number;
  completionTokens: number;
  totalLatencyMs: number;
  createdAt: number;
}

export interface SafeProviderSummary {
  id: string;
  provider: ProviderPresetId;
  name: string;
  baseUrl: string;
  keyPrefix: string;
  defaultModel: string;
  protocol: 'openai' | 'anthropic';
  enabled: boolean;
  priority: number;
  cooldownUntil?: number;
  lastError?: string;
  requestCount: number;
  errorCount: number;
  failoverCount: number;
  promptTokens: number;
  completionTokens: number;
  totalLatencyMs: number;
  createdAt: number;
}

export interface AccountQuotaBucket {
  name: string;
  kind: 'plan' | 'sota' | 'pack' | 'shared';
  remain: number;
  used: number;
  size: number;
  expiresAt?: number;
}

export interface QoderAccount {
  uid: string;
  nickname: string;
  email?: string;
  realm: RealmId;
  source: 'oauth' | 'pat' | 'import';
  accessToken: string;
  refreshToken: string;
  personalToken?: string;
  expiresAt: number;
  enabled: boolean;
  userType: string;
  organizationId?: string;
  organizationName?: string;
  creditsRemain: number | null;
  creditsUsed: number | null;
  creditsSize: number | null;
  quotaBuckets: AccountQuotaBucket[];
  planName?: string;
  checkinClaimedToday?: boolean;
  lastCheckinAt?: number;
  lastQuotaSyncAt?: number;
  cooldownUntil?: number;
  lastError?: string;
  requestCount: number;
  createdAt: number;
}

export interface SafeAccountSummary {
  uid: string;
  nickname: string;
  email?: string;
  realm: RealmId;
  source: 'oauth' | 'pat' | 'import';
  tokenPrefix: string;
  expiresAt: number;
  enabled: boolean;
  userType: string;
  organizationName?: string;
  creditsRemain: number | null;
  creditsUsed: number | null;
  creditsSize: number | null;
  quotaBuckets: AccountQuotaBucket[];
  planName?: string;
  checkinClaimedToday?: boolean;
  lastCheckinAt?: number;
  lastQuotaSyncAt?: number;
  cooldownUntil?: number;
  lastError?: string;
  requestCount: number;
  createdAt: number;
}

export interface QoderModel {
  key: string;
  id: string;
  displayName: string;
  realm: RealmId;
  availableRealms: RealmId[];
  priceFactor: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  isVl: boolean;
  isReasoning: boolean;
  enable: boolean;
  thinkingEfforts?: string[];
  contextOptions?: string[];
  disabledReason?: string;
  source?: 'qoder' | 'openrouter' | 'github' | 'manual';
  provider?: ProviderPresetId;
  modelName?: string;
  baseUrl?: string;
  protocol?: 'openai' | 'anthropic';
  pricing?: { prompt?: number; completion?: number; currency: 'USD'; unit: 'token' };
  supportsTools?: boolean;
  updatedAt?: number;
}

export interface GatewayApiKey {
  id: string;
  name: string;
  key: string;
  realmLock?: RealmId | 'auto';
  models?: string[];
  createdAt: number;
  lastUsedAt?: number;
  requestCount: number;
}

export interface GatewaySettings {
  defaultRealm: RealmId;
  autoRealm: boolean;
  queueWaitMode: 'wait' | 'fast';
  trafficGuard: boolean;
  maxConcurrencyPerAccount: number;
  autoCheckinEnabled: boolean;
  requireApiKey: boolean;
  autoFailoverEnabled: boolean;
  fallbackToQoderZeroX: boolean;
  autoRefreshTokens: boolean;
  bannedModels: string[];
}

export interface RequestLogEntry {
  id: string;
  timestamp: number;
  protocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'android-chat';
  model: string;
  realm: RealmId;
  provider?: string;
  providerId?: string;
  providerName?: string;
  failoverFrom?: string;
  accountUid?: string;
  accountNickname?: string;
  status: number;
  latencyMs: number;
  stream: boolean;
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
}

export interface RiskTelemetry {
  queueCount: number;
  rateLimitCount: number;
  rejectedCount: number;
  versionGateCount: number;
  lastSignalAt?: number;
  lastSignalDetail?: string;
}

export interface HubOverview {
  version: string;
  uptimeSec: number;
  defaultRealm: RealmId;
  autoRealm: boolean;
  accounts: SafeAccountSummary[];
  providers: SafeProviderSummary[];
  totals: {
    accountsTotal: number;
    accountsEnabled: number;
    accountsInCooldown: number;
    providersTotal: number;
    providersEnabled: number;
    creditsRemain: number;
    creditsUsed: number;
    creditsSize: number;
    totalRequests: number;
  };
  risk: RiskTelemetry;
  settings: GatewaySettings;
  apiKeys: GatewayApiKey[];
  recentLogs: RequestLogEntry[];
}

export interface OAuthLoginSession {
  state: string;
  authUrl: string;
  realm: RealmId;
  expiresAt: number;
}

export interface ChatMessageItem {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning?: string;
  model?: string;
  realm?: RealmId;
  provider?: string;
  failoverFrom?: string;
  accountNickname?: string;
  latencyMs?: number;
  timestamp: number;
  error?: boolean;
  errorDetail?: string;
  partial?: boolean;
}

export interface DiscoveredAiProvider {
  id: string;
  provider: ProviderPresetId;
  name: string;
  baseUrl: string;
  defaultModel: string;
  protocol: 'openai' | 'anthropic';
  source: 'local-scan' | 'openrouter-free' | 'pollinations' | 'endpoint-sync';
  requiresKey: boolean;
  canAutoAdd: boolean;
  contextLength?: number;
  alreadyConfigured: boolean;
  description: string;
}

