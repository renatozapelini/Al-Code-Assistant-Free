import type { QoderModel, RealmId } from '../types/hub.ts';

interface RawCatalogEntry {
  key: string;
  display_name: string;
  price_factor: number;
  max_input_tokens: number;
  max_output_tokens?: number;
  is_vl: boolean;
  is_reasoning: boolean;
  enable: boolean;
  realms: RealmId[];
  thinking_efforts?: string[];
  context_options?: string[];
  disabled_reason?: string;
}

const DEFAULT_CATALOG_ENTRIES: RawCatalogEntry[] = [
  {
    key: 'auto',
    display_name: 'Auto',
    price_factor: 0.5,
    max_input_tokens: 200000,
    max_output_tokens: 32768,
    is_vl: true,
    is_reasoning: false,
    enable: true,
    realms: ['cn', 'intl'],
  },
  {
    key: 'ultimate',
    display_name: 'Ultimate',
    price_factor: 2.0,
    max_input_tokens: 1000000,
    max_output_tokens: 65536,
    is_vl: true,
    is_reasoning: true,
    enable: true,
    realms: ['intl', 'cn'],
    thinking_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    context_options: ['200K', '400K', '1M'],
  },
  {
    key: 'performance',
    display_name: 'Performance',
    price_factor: 1.1,
    max_input_tokens: 1000000,
    max_output_tokens: 65536,
    is_vl: true,
    is_reasoning: true,
    enable: true,
    realms: ['intl', 'cn'],
    thinking_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    context_options: ['272K', '400K', '1M'],
  },
  {
    key: 'efficient',
    display_name: 'Efficient',
    price_factor: 0.3,
    max_input_tokens: 200000,
    max_output_tokens: 32768,
    is_vl: true,
    is_reasoning: false,
    enable: true,
    realms: ['intl', 'cn'],
  },
  {
    key: 'qmodel_38max',
    display_name: 'Qwen3.8-Max',
    price_factor: 0.5,
    max_input_tokens: 180000,
    max_output_tokens: 32768,
    is_vl: true,
    is_reasoning: true,
    enable: true,
    realms: ['intl', 'cn'],
    thinking_efforts: ['low', 'medium', 'high'],
  },
  {
    key: 'qfmodel',
    display_name: 'Qwen3.8-Flash',
    price_factor: 0.0,
    max_input_tokens: 180000,
    max_output_tokens: 32768,
    is_vl: true,
    is_reasoning: false,
    enable: true,
    realms: ['intl', 'cn'],
  },
  {
    key: 'qmodel_latest',
    display_name: 'Qwen3.7-Max',
    price_factor: 0.5,
    max_input_tokens: 1000000,
    max_output_tokens: 65536,
    is_vl: true,
    is_reasoning: true,
    enable: true,
    realms: ['cn', 'intl'],
  },
  {
    key: 'qmodel',
    display_name: 'Qwen3.7-Plus',
    price_factor: 0.1,
    max_input_tokens: 1000000,
    max_output_tokens: 32768,
    is_vl: true,
    is_reasoning: false,
    enable: true,
    realms: ['cn', 'intl'],
  },
  {
    key: 'dmodel',
    display_name: 'DeepSeek-V4-Pro',
    price_factor: 0.5,
    max_input_tokens: 1000000,
    max_output_tokens: 65536,
    is_vl: false,
    is_reasoning: true,
    enable: true,
    realms: ['cn', 'intl'],
    thinking_efforts: ['low', 'medium', 'high'],
  },
  {
    key: 'dfmodel',
    display_name: 'DeepSeek-Flash',
    price_factor: 0.1,
    max_input_tokens: 1000000,
    max_output_tokens: 32768,
    is_vl: false,
    is_reasoning: true,
    enable: true,
    realms: ['cn', 'intl'],
  },
  {
    key: 'gmodel',
    display_name: 'GLM-5.3',
    price_factor: 0.8,
    max_input_tokens: 180000,
    max_output_tokens: 32768,
    is_vl: true,
    is_reasoning: true,
    enable: true,
    realms: ['cn', 'intl'],
  },
  {
    key: 'gfmodel',
    display_name: 'GLM-5.3-Flash',
    price_factor: 0.1,
    max_input_tokens: 1000000,
    max_output_tokens: 32768,
    is_vl: false,
    is_reasoning: false,
    enable: true,
    realms: ['cn', 'intl'],
  },
  {
    key: 'kmodel_latest',
    display_name: 'Kimi-K3',
    price_factor: 1.4,
    max_input_tokens: 180000,
    max_output_tokens: 32768,
    is_vl: true,
    is_reasoning: true,
    enable: true,
    realms: ['cn', 'intl'],
  },
  {
    key: 'kmodel',
    display_name: 'Kimi-K2.8-Preview',
    price_factor: 0.8,
    max_input_tokens: 180000,
    max_output_tokens: 32768,
    is_vl: false,
    is_reasoning: true,
    enable: true,
    realms: ['cn', 'intl'],
  },
  {
    key: 'mmodel',
    display_name: 'MiniMax-M3',
    price_factor: 0.2,
    max_input_tokens: 180000,
    max_output_tokens: 32768,
    is_vl: false,
    is_reasoning: true,
    enable: true,
    realms: ['intl', 'cn'],
  },
  {
    key: 'lmodel',
    display_name: 'QoDuck',
    price_factor: 0.0,
    max_input_tokens: 180000,
    max_output_tokens: 16384,
    is_vl: false,
    is_reasoning: false,
    enable: true,
    realms: ['intl', 'cn'],
  },
  {
    key: 'smodel',
    display_name: 'Sonus',
    price_factor: 8.0,
    max_input_tokens: 180000,
    max_output_tokens: 65536,
    is_vl: true,
    is_reasoning: true,
    enable: true,
    realms: ['intl'],
  },
  {
    key: 'cmodel',
    display_name: 'Cantus',
    price_factor: 4.0,
    max_input_tokens: 180000,
    max_output_tokens: 65536,
    is_vl: true,
    is_reasoning: true,
    enable: true,
    realms: ['intl'],
  },
];

let dynamicCatalog: QoderModel[] = DEFAULT_CATALOG_ENTRIES.map((e) => ({
  key: e.key,
  id: e.display_name,
  displayName: e.display_name,
  realm: e.realms[0],
  availableRealms: e.realms,
  priceFactor: e.price_factor,
  maxInputTokens: e.max_input_tokens,
  maxOutputTokens: e.max_output_tokens ?? 32768,
  isVl: e.is_vl,
  isReasoning: e.is_reasoning,
  enable: e.enable,
  thinkingEfforts: e.thinking_efforts,
  contextOptions: e.context_options,
  disabledReason: e.disabled_reason,
}));

export function getCatalog(realm?: RealmId): QoderModel[] {
  if (!realm) return dynamicCatalog;
  return dynamicCatalog.filter((m) => m.availableRealms.includes(realm));
}

export function resolveModel(requestedModel: string, preferredRealm: RealmId): {
  modelKey: string;
  displayName: string;
  realm: RealmId;
  catalogEntry?: QoderModel;
} {
  const norm = requestedModel.trim().toLowerCase();
  const found = dynamicCatalog.find(
    (m) =>
      m.id.toLowerCase() === norm ||
      m.key.toLowerCase() === norm ||
      m.displayName.toLowerCase() === norm
  );
  if (found) {
    const realm = found.availableRealms.includes(preferredRealm)
      ? preferredRealm
      : found.availableRealms[0] || preferredRealm;
    return {
      modelKey: found.key,
      displayName: found.displayName,
      realm,
      catalogEntry: found,
    };
  }
  return {
    modelKey: requestedModel || 'qfmodel',
    displayName: requestedModel || 'Qwen3.8-Flash',
    realm: preferredRealm,
  };
}

export function mergeUpstreamCatalog(rawList: unknown[], realm: RealmId): number {
  if (!Array.isArray(rawList) || rawList.length === 0) return 0;
  let updated = 0;
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const key = String(obj.key || '').trim();
    const displayName = String(obj.display_name || key).trim();
    if (!key) continue;

    const existing = dynamicCatalog.find((m) => m.key === key || m.id.toLowerCase() === displayName.toLowerCase());
    const thinkingCfg = obj.thinking_config as Record<string, unknown> | undefined;
    const effortsObj = (thinkingCfg?.enabled as Record<string, unknown> | undefined)?.efforts as
      | Record<string, unknown>
      | undefined;
    const efforts = effortsObj ? Object.keys(effortsObj) : undefined;
    const ctxObj = obj.context_config as Record<string, unknown> | undefined;
    const contextOptions = ctxObj ? Object.keys(ctxObj) : undefined;

    const entry: QoderModel = {
      key,
      id: displayName,
      displayName,
      realm,
      availableRealms: existing
        ? Array.from(new Set([...existing.availableRealms, realm]))
        : [realm],
      priceFactor: Number(obj.price_factor ?? existing?.priceFactor ?? 0.5),
      maxInputTokens: Number(obj.max_input_tokens ?? existing?.maxInputTokens ?? 180000),
      maxOutputTokens: existing?.maxOutputTokens ?? 32768,
      isVl: Boolean(obj.is_vl ?? existing?.isVl),
      isReasoning: Boolean(obj.is_reasoning ?? existing?.isReasoning),
      enable: obj.enable !== false,
      thinkingEfforts: efforts ?? existing?.thinkingEfforts,
      contextOptions: contextOptions ?? existing?.contextOptions,
    };

    if (existing) {
      Object.assign(existing, entry);
    } else {
      dynamicCatalog.push(entry);
    }
    updated++;
  }
  return updated;
}
