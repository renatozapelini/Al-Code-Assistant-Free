import fs from 'node:fs';
import path from 'node:path';
import type { ProviderPresetId, QoderModel } from '../types/hub.ts';
import { PROVIDER_PRESETS } from './providerPresets.ts';

export type CatalogProvider = 'openrouter' | 'github';
export interface CatalogStatus {
  updatedAt?: number;
  attemptedAt?: number;
  error?: string;
}
interface ProviderCache {
  models: QoderModel[];
  status: CatalogStatus;
}
interface CatalogCache {
  version: 1;
  providers: Record<CatalogProvider, ProviderCache>;
  manual: QoderModel[];
}

export const CATALOG_TTL_MS = 60 * 60 * 1000;
export const CATALOG_RETRY_MS = 5 * 60 * 1000;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const MAX_MODELS = 10_000;
const MAX_MANUAL = 500;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const GITHUB_UNAVAILABLE = 'GitHub Models foi descontinuado; catálogo automático indisponível. Cache anterior preservado. Use uma entrada manual com um endpoint válido.';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : undefined;
}

function modelId(value: unknown): string | undefined {
  const id = text(value, 256);
  return id && !/\s/.test(id) ? id : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function tokens(value: unknown): number {
  const n = finiteNonNegative(value);
  return n !== undefined && Number.isSafeInteger(n) ? n : 0;
}

export function normalizeCatalogBaseUrl(value: unknown): string {
  const raw = text(value, 2048);
  if (!raw) throw new Error('Informe uma baseUrl válida.');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('baseUrl deve usar HTTP(S), sem credenciais, query ou fragmento.');
  }
  return url.toString().replace(/\/+$/, '');
}

function identity(model: QoderModel): string {
  return JSON.stringify([model.provider, model.baseUrl, model.protocol, model.modelName]);
}

function externalModel(provider: ProviderPresetId, id: string, baseUrl: string, protocol: 'openai' | 'anthropic', source: QoderModel['source'], updatedAt: number): QoderModel {
  return {
    key: `external:${encodeURIComponent(provider)}:${encodeURIComponent(baseUrl)}:${protocol}:${encodeURIComponent(id)}`,
    id,
    displayName: id,
    realm: 'intl',
    availableRealms: [],
    // This required legacy field is not external pricing; consumers must use pricing instead.
    priceFactor: 0,
    maxInputTokens: 0,
    maxOutputTokens: 0,
    isVl: false,
    isReasoning: false,
    enable: true,
    source,
    provider,
    modelName: id,
    baseUrl,
    protocol,
    updatedAt,
  };
}

export function normalizeOpenRouterModels(payload: unknown, updatedAt: number): QoderModel[] {
  const envelope = record(payload);
  if (!Array.isArray(envelope.data)) throw new Error('OpenRouter retornou um catálogo JSON inválido.');
  if (envelope.data.length > MAX_MODELS) throw new Error('Catálogo excede o limite de modelos.');
  const models: QoderModel[] = [];
  for (const raw of envelope.data) {
    const item = record(raw);
    const id = modelId(item.id);
    if (!id) continue;
    const pricing = record(item.pricing);
    const architecture = record(item.architecture);
    const topProvider = record(item.top_provider);
    const parameters = Array.isArray(item.supported_parameters) ? item.supported_parameters : undefined;
    models.push({
      ...externalModel('openrouter', id, 'https://openrouter.ai/api/v1', 'openai', 'openrouter', updatedAt),
      displayName: text(item.name, 512) || id,
      maxInputTokens: tokens(item.context_length),
      maxOutputTokens: tokens(topProvider.max_completion_tokens),
      isVl: Array.isArray(architecture.input_modalities) && architecture.input_modalities.includes('image'),
      isReasoning: Boolean(parameters?.some((p) => p === 'reasoning' || p === 'include_reasoning')),
      supportsTools: parameters ? parameters.includes('tools') : undefined,
      pricing: {
        prompt: finiteNonNegative(pricing.prompt),
        completion: finiteNonNegative(pricing.completion),
        currency: 'USD',
        unit: 'token',
      },
    });
  }
  return deduplicateExternalModels(models);
}

export function normalizeManualModel(payload: unknown, updatedAt: number): QoderModel {
  const input = record(payload);
  const preset = PROVIDER_PRESETS.find((p) => p.id === input.provider);
  if (!preset) throw new Error('Provedor inválido.');
  const id = modelId(input.modelName ?? input.modelId);
  if (!id) throw new Error('Informe o ID do modelo (até 256 caracteres, sem espaços ou controles).');
  if (input.protocol !== undefined && input.protocol !== 'openai' && input.protocol !== 'anthropic') {
    throw new Error('Protocolo deve ser openai ou anthropic.');
  }
  if (preset.id === 'custom' && !input.baseUrl) throw new Error('Provedor custom exige baseUrl.');
  const baseUrl = normalizeCatalogBaseUrl(input.baseUrl ?? preset.baseUrl);
  const protocol = input.protocol ?? preset.protocol;
  if (input.displayName !== undefined && !text(input.displayName, 512)) throw new Error('Nome de exibição inválido.');
  return {
    ...externalModel(preset.id, id, baseUrl, protocol as 'openai' | 'anthropic', 'manual', updatedAt),
    displayName: text(input.displayName, 512) || id,
  };
}

export function deduplicateExternalModels(models: QoderModel[]): QoderModel[] {
  const unique = new Map<string, QoderModel>();
  for (const model of models) {
    const key = identity(model);
    const previous = unique.get(key);
    // A manual entry retains live metadata if it names the same endpoint/model.
    unique.set(key, previous && model.source === 'manual' ? {
      ...previous,
      source: 'manual',
      displayName: model.displayName,
    } : model);
  }
  return [...unique.values()];
}

function emptyCache(): CatalogCache {
  return { version: 1, providers: { openrouter: { models: [], status: {} }, github: { models: [], status: {} } }, manual: [] };
}

function restoreModels(raw: unknown, provider?: CatalogProvider): QoderModel[] {
  if (!Array.isArray(raw) || raw.length > (provider ? MAX_MODELS : MAX_MANUAL)) return [];
  return raw.flatMap((value) => {
    try {
      const item = record(value);
      if (provider && (item.provider !== provider || item.source !== provider)) return [];
      const entry = normalizeManualModel(item, finiteNonNegative(item.updatedAt) ?? 0);
      const pricing = record(item.pricing);
      return [{
        ...entry,
        source: provider ?? 'manual',
        maxInputTokens: tokens(item.maxInputTokens),
        maxOutputTokens: tokens(item.maxOutputTokens),
        isVl: item.isVl === true,
        isReasoning: item.isReasoning === true,
        supportsTools: typeof item.supportsTools === 'boolean' ? item.supportsTools : undefined,
        pricing: item.pricing ? {
          prompt: finiteNonNegative(pricing.prompt), completion: finiteNonNegative(pricing.completion),
          currency: 'USD' as const, unit: 'token' as const,
        } : undefined,
      }];
    } catch {
      return [];
    }
  });
}

async function readJsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`OpenRouter indisponível (HTTP ${response.status}). Cache anterior preservado.`);
  if (!response.headers.get('content-type')?.toLowerCase().includes('json')) {
    throw new Error('OpenRouter não retornou JSON. Cache anterior preservado.');
  }
  if (!response.body) throw new Error('OpenRouter retornou resposta vazia.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Resposta do catálogo excede o limite de tamanho.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(buffer));
}

export function createExternalCatalog(options: { cacheFile?: string; fetch?: typeof fetch; now?: () => number } = {}) {
  const dataDir = process.env.QD_DATA_DIR ? path.resolve(process.env.QD_DATA_DIR) : path.resolve(process.cwd(), '.qoder2api-data');
  const cacheFile = options.cacheFile ?? path.join(dataDir, 'external-catalog.json');
  const fetchCatalog = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = options.now ?? Date.now;
  let cache = emptyCache();
  try {
    if (fs.statSync(cacheFile).size > 32 * 1024 * 1024) throw new Error('Cache excede o limite.');
    const parsed = record(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
    if (parsed.version === 1) {
      const providers = record(parsed.providers);
      for (const provider of ['openrouter', 'github'] as const) {
        const saved = record(providers[provider]);
        const status = record(saved.status);
        cache.providers[provider] = {
          models: deduplicateExternalModels(restoreModels(saved.models, provider)),
          status: {
            updatedAt: finiteNonNegative(status.updatedAt),
            attemptedAt: finiteNonNegative(status.attemptedAt),
            error: text(status.error, 1024),
          },
        };
      }
      cache.manual = deduplicateExternalModels(restoreModels(parsed.manual));
    }
  } catch {
    // Missing or invalid catalog cache never affects Qoder or saved credentials.
  }

  function persist(next: CatalogCache) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const temporary = `${cacheFile}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(next), 'utf8');
      fs.renameSync(temporary, cacheFile);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    cache = next;
  }

  function snapshot() {
    return {
      models: deduplicateExternalModels([...cache.providers.openrouter.models, ...cache.providers.github.models, ...cache.manual]),
      statuses: { openrouter: { ...cache.providers.openrouter.status }, github: { ...cache.providers.github.status } },
      ttlMs: CATALOG_TTL_MS,
      retryMs: CATALOG_RETRY_MS,
    };
  }

  const inFlight = new Map<CatalogProvider, Promise<ReturnType<typeof snapshot> & { ok: boolean; cached: boolean; message: string }>>();
  async function sync(provider: CatalogProvider) {
    const previous = cache.providers[provider];
    const attemptedAt = now();
    let models = previous.models;
    let error: string | undefined;
    try {
      if (provider === 'github') throw new Error(GITHUB_UNAVAILABLE);
      const signal = AbortSignal.timeout(30_000);
      let url: string | undefined = OPENROUTER_URL;
      const visited = new Set<string>();
      const collected: QoderModel[] = [];
      while (url) {
        if (visited.size >= 20 || visited.has(url)) throw new Error('Paginação OpenRouter inválida ou excessiva.');
        visited.add(url);
        const response = await fetchCatalog(url, { headers: { Accept: 'application/json' }, signal, redirect: 'error' });
        const payload = await readJsonResponse(response);
        collected.push(...normalizeOpenRouterModels(payload, attemptedAt));
        if (collected.length > MAX_MODELS) throw new Error('Catálogo excede o limite de modelos.');
        const next = record(record(payload).links).next;
        url = undefined;
        if (next !== null && next !== undefined) {
          const href = typeof next === 'string' ? next : record(next).href;
          if (typeof href !== 'string' || !href.trim()) throw new Error('Link de paginação OpenRouter inválido.');
          const nextUrl = new URL(href, response.url || [...visited].at(-1));
          if (nextUrl.origin !== 'https://openrouter.ai' || nextUrl.pathname !== '/api/v1/models' || nextUrl.username || nextUrl.password || nextUrl.hash) {
            throw new Error('Link de paginação OpenRouter fora do catálogo.');
          }
          url = nextUrl.toString();
        }
      }
      if (!collected.length) throw new Error('OpenRouter retornou catálogo vazio ou sem modelos válidos.');
      models = deduplicateExternalModels(collected);
    } catch (err) {
      error = provider === 'github' ? GITHUB_UNAVAILABLE :
        `Falha ao atualizar OpenRouter: ${err instanceof Error ? err.message : 'resposta inválida'}. Cache anterior preservado.`;
    }
    const status: CatalogStatus = { attemptedAt, updatedAt: error ? previous.status.updatedAt : attemptedAt, error };
    const next: CatalogCache = { ...cache, providers: { ...cache.providers, [provider]: { models, status } } };
    try {
      persist(next);
    } catch {
      error = 'Não foi possível persistir o catálogo. Cache anterior preservado.';
      cache = { ...cache, providers: { ...cache.providers, [provider]: { ...previous, status: { ...previous.status, attemptedAt, error } } } };
    }
    return { ...snapshot(), ok: !error, cached: false, message: error || `OpenRouter atualizado: ${models.length} modelos.` };
  }

  function refresh(provider: CatalogProvider) {
    if (provider !== 'openrouter' && provider !== 'github') throw new Error('Provedor de catálogo inválido.');
    const running = inFlight.get(provider);
    if (running) return running;
    const status = cache.providers[provider].status;
    const stamp = status.error ? status.attemptedAt : cache.providers[provider].models.length ? status.updatedAt : undefined;
    const ttl = status.error ? CATALOG_RETRY_MS : CATALOG_TTL_MS;
    if ((provider !== 'github' || status.error) && stamp !== undefined && now() >= stamp && now() - stamp < ttl) {
      return Promise.resolve({ ...snapshot(), ok: !status.error, cached: true, message: status.error || 'Catálogo em cache (TTL ativo).' });
    }
    const promise = sync(provider).finally(() => inFlight.delete(provider));
    inFlight.set(provider, promise);
    return promise;
  }

  function addManual(payload: unknown) {
    const model = normalizeManualModel(payload, now());
    const previous = cache.manual.filter((entry) => identity(entry) !== identity(model));
    if (previous.length >= MAX_MANUAL) throw new Error(`Limite de ${MAX_MANUAL} entradas manuais atingido.`);
    persist({ ...cache, manual: [...previous, model] });
    return { ...snapshot(), model };
  }

  return { snapshot, refresh, addManual };
}

let defaultCatalog: ReturnType<typeof createExternalCatalog> | undefined;
export function getExternalCatalog() {
  return defaultCatalog ??= createExternalCatalog();
}
