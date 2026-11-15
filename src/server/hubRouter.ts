import express from 'express';
import type { ProviderPresetId, RealmId } from '../types/hub.ts';
import { PROVIDER_PRESETS } from './providerPresets.ts';
import { getCatalog } from './qoderCatalog.ts';
import {
  handleAnthropicMessages,
  handleChatCompletions,
  handleResponsesApi,
} from './qoderProxy.ts';
import {
  addDiscoveredProvider,
  addProviderAccount,
  addProviderAccountsBatch,
  claimDailyCheckin,
  createApiKey,
  deleteAccount,
  deleteApiKey,
  deleteProviderAccount,
  discoverCodingProviders,
  getAllRawAccounts,
  getAllRawProviders,
  getOverview,
  getSettings,
  importAccountsJson,
  importPatAccount,
  moveProviderPriority,
  pollOAuthLogin,
  refreshAccountToken,
  refreshCatalogFromUpstream,
  startOAuthLogin,
  syncAccountQuota,
  testProviderAccount,
  toggleAccount,
  toggleProviderAccount,
  updateProviderAccount,
  updateSettings,
  validateBearerKey,
} from './qoderStore.ts';

export function createHubRouter(): express.Router {
  const router = express.Router();

  // CORS for OpenAI / Anthropic / Responses protocol routes
  router.use(['/v1', '/health', '/ping', '/credits'], (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, X-Api-Key, X-Realm, X-Session-Id, Anthropic-Version'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Public Health & Protocol Endpoints
  router.get(['/ping', '/healthz', '/livez', '/readyz'], (_req, res) => {
    res.type('text/plain').send('pong');
  });

  router.get('/health', (_req, res) => {
    const overview = getOverview();
    res.json({
      ok: true,
      service: 'qoder2api-hub-android',
      version: overview.version,
      uptime_sec: overview.uptimeSec,
      realm: overview.defaultRealm,
      auto_realm: overview.autoRealm,
      accounts: overview.totals.accountsTotal,
      accounts_enabled: overview.totals.accountsEnabled,
      credits_remain: overview.totals.creditsRemain,
      risk: overview.risk,
    });
  });

  router.get('/credits/summary', (req, res) => {
    const auth = validateBearerKey(req.header('authorization'), req.header('x-api-key'));
    if (!auth.ok) {
      res.status(401).json({ error: auth.error });
      return;
    }
    const overview = getOverview();
    res.json({
      totals: {
        remain: overview.totals.creditsRemain,
        used: overview.totals.creditsUsed,
        size: overview.totals.creditsSize,
        accounts: overview.totals.accountsTotal,
      },
      accounts: overview.accounts.map((a) => ({
        uid: a.uid,
        nickname: a.nickname,
        realm: a.realm,
        credits_remain: a.creditsRemain,
        credits_used: a.creditsUsed,
        credits_size: a.creditsSize,
      })),
    });
  });

  router.get('/v1/models', (req, res) => {
    const realmParam = String(req.query.realm || '').toLowerCase();
    const realm = realmParam === 'cn' || realmParam === 'intl' ? (realmParam as RealmId) : undefined;
    const models = getCatalog(realm);
    const externalProviders = getAllRawProviders().filter((p) => p.enabled);

    res.json({
      object: 'list',
      data: [
        {
          id: 'auto-failover',
          object: 'model',
          created: 1735689600,
          owned_by: 'qoder2api-hub',
          qoder_key: 'auto-failover',
          realms: ['intl', 'cn'],
          price_factor: 0,
          context_length: 200000,
          max_output_tokens: 32768,
          supports_vision: true,
          supports_reasoning: true,
        },
        ...models.map((m) => ({
          id: m.id,
          object: 'model',
          created: 1735689600,
          owned_by: 'qoder',
          qoder_key: m.key,
          realms: m.availableRealms,
          price_factor: m.priceFactor,
          context_length: m.maxInputTokens,
          max_output_tokens: m.maxOutputTokens,
          supports_vision: m.isVl,
          supports_reasoning: m.isReasoning,
        })),
        ...externalProviders.map((p) => ({
          id: `provider:${p.id}`,
          object: 'model',
          created: 1735689600,
          owned_by: p.provider,
          qoder_key: p.defaultModel,
          realms: ['intl'],
          price_factor: 0,
          context_length: 128000,
          max_output_tokens: 16384,
          supports_vision: false,
          supports_reasoning: true,
        })),
      ],
    });
  });

  router.post('/v1/chat/completions', (req, res) => {
    const auth = validateBearerKey(req.header('authorization'), req.header('x-api-key'));
    if (!auth.ok) {
      res.status(401).json({ error: { message: auth.error, type: 'authentication_error' } });
      return;
    }
    void handleChatCompletions(req, res, 'openai-chat');
  });

  router.post('/v1/responses', (req, res) => {
    const auth = validateBearerKey(req.header('authorization'), req.header('x-api-key'));
    if (!auth.ok) {
      res.status(401).json({ error: { message: auth.error, type: 'authentication_error' } });
      return;
    }
    void handleResponsesApi(req, res);
  });

  router.post('/v1/messages', (req, res) => {
    const auth = validateBearerKey(req.header('authorization'), req.header('x-api-key'));
    if (!auth.ok) {
      res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: auth.error } });
      return;
    }
    void handleAnthropicMessages(req, res);
  });

  // Hub Management API
  router.get('/api/hub/overview', (_req, res) => {
    res.json(getOverview());
  });

  router.get('/api/hub/catalog', (req, res) => {
    const r = String(req.query.realm || '').toLowerCase();
    const realm = r === 'cn' || r === 'intl' ? (r as RealmId) : undefined;
    res.json({ models: getCatalog(realm) });
  });

  router.post('/api/hub/catalog/refresh', async (req, res) => {
    const realm: RealmId = req.body?.realm === 'cn' ? 'cn' : 'intl';
    const result = await refreshCatalogFromUpstream(realm);
    res.json({ ...result, models: getCatalog() });
  });

  router.post('/api/hub/oauth/start', (req, res) => {
    const realm: RealmId = req.body?.realm === 'cn' ? 'cn' : 'intl';
    const session = startOAuthLogin(realm);
    res.json(session);
  });

  router.get('/api/hub/oauth/poll', async (req, res) => {
    const state = String(req.query.state || '');
    const result = await pollOAuthLogin(state);
    res.json(result);
  });

  router.post('/api/hub/accounts/pat', async (req, res) => {
    try {
      const pat = String(req.body?.pat || '');
      const realm: RealmId = req.body?.realm === 'cn' ? 'cn' : 'intl';
      const account = await importPatAccount(pat, realm);
      res.json({ ok: true, account });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'PAT inválido' });
    }
  });

  router.post('/api/hub/accounts/import', (req, res) => {
    const items = Array.isArray(req.body?.accounts)
      ? req.body.accounts
      : Array.isArray(req.body)
        ? req.body
        : [];
    if (items.length === 0) {
      res.status(400).json({ ok: false, error: 'Envie um array JSON válido de contas.' });
      return;
    }
    const result = importAccountsJson(items);
    res.json({ ok: true, ...result });
  });

  router.get('/api/hub/accounts/export', (_req, res) => {
    const accounts = getAllRawAccounts();
    res.setHeader('Content-Disposition', 'attachment; filename="qoder2api-accounts.json"');
    res.json(accounts);
  });

  router.post('/api/hub/accounts/:uid/refresh', async (req, res) => {
    try {
      const account = await refreshAccountToken(req.params.uid);
      res.json({ ok: true, account });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Erro ao atualizar conta' });
    }
  });

  router.post('/api/hub/accounts/:uid/quota', async (req, res) => {
    try {
      const account = await syncAccountQuota(req.params.uid);
      res.json({ ok: true, account });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Erro ao consultar créditos' });
    }
  });

  router.post('/api/hub/accounts/:uid/checkin', async (req, res) => {
    try {
      const result = await claimDailyCheckin(req.params.uid);
      res.json(result);
    } catch (err) {
      res.status(400).json({ ok: false, message: err instanceof Error ? err.message : 'Erro no check-in' });
    }
  });

  router.post('/api/hub/accounts/:uid/toggle', (req, res) => {
    const account = toggleAccount(req.params.uid);
    if (!account) {
      res.status(404).json({ ok: false, error: 'Conta não encontrada.' });
      return;
    }
    res.json({ ok: true, account });
  });

  router.delete('/api/hub/accounts/:uid', (req, res) => {
    const removed = deleteAccount(req.params.uid);
    res.json({ ok: removed });
  });

  router.post('/api/hub/settings', (req, res) => {
    const next = updateSettings(req.body || {});
    res.json({ ok: true, settings: next });
  });

  router.post('/api/hub/keys', (req, res) => {
    const name = String(req.body?.name || 'Chave Android');
    const realmLock = req.body?.realmLock === 'cn' || req.body?.realmLock === 'intl' ? req.body.realmLock : 'auto';
    const entry = createApiKey(name, realmLock);
    res.json({ ok: true, key: entry });
  });

  router.delete('/api/hub/keys/:id', (req, res) => {
    res.json({ ok: deleteApiKey(req.params.id) });
  });

  router.post('/api/hub/chat', (req, res) => {
    void handleChatCompletions(req, res, 'android-chat');
  });

  router.get('/api/hub/settings', (_req, res) => {
    res.json(getSettings());
  });

  // Multi-Provider AI Code Assistant Failover Pool
  router.get('/api/hub/providers/presets', (_req, res) => {
    res.json({ presets: PROVIDER_PRESETS });
  });

  router.post('/api/hub/providers', (req, res) => {
    try {
      const provider = String(req.body?.provider || 'custom') as ProviderPresetId;
      const created = addProviderAccount({
        provider,
        name: req.body?.name ? String(req.body.name) : undefined,
        baseUrl: req.body?.baseUrl ? String(req.body.baseUrl) : undefined,
        apiKey: String(req.body?.apiKey || ''),
        defaultModel: req.body?.defaultModel ? String(req.body.defaultModel) : undefined,
        protocol: req.body?.protocol === 'anthropic' ? 'anthropic' : req.body?.protocol === 'openai' ? 'openai' : undefined,
      });
      res.json({ ok: true, provider: created });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Erro ao adicionar API' });
    }
  });

  router.post('/api/hub/providers/batch', (req, res) => {
    try {
      const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
      if (rawItems.length === 0) {
        res.status(400).json({ ok: false, error: 'Envie ao menos uma chave ou provedor.' });
        return;
      }
      const created = addProviderAccountsBatch(
        rawItems.map((item: Record<string, unknown>) => ({
          provider: String(item?.provider || 'custom') as ProviderPresetId,
          name: item?.name ? String(item.name) : undefined,
          baseUrl: item?.baseUrl ? String(item.baseUrl) : undefined,
          apiKey: String(item?.apiKey || ''),
          defaultModel: item?.defaultModel ? String(item.defaultModel) : undefined,
          protocol: item?.protocol === 'anthropic' ? 'anthropic' : item?.protocol === 'openai' ? 'openai' : undefined,
        }))
      );
      res.json({ ok: true, providers: created, count: created.length });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Erro ao salvar lote de APIs' });
    }
  });

  router.patch('/api/hub/providers/:id', (req, res) => {
    const updated = updateProviderAccount(req.params.id, {
      name: typeof req.body?.name === 'string' ? req.body.name : undefined,
      baseUrl: typeof req.body?.baseUrl === 'string' ? req.body.baseUrl : undefined,
      apiKey: typeof req.body?.apiKey === 'string' ? req.body.apiKey : undefined,
      defaultModel: typeof req.body?.defaultModel === 'string' ? req.body.defaultModel : undefined,
      protocol: req.body?.protocol === 'anthropic' ? 'anthropic' : req.body?.protocol === 'openai' ? 'openai' : undefined,
    });
    if (!updated) {
      res.status(404).json({ ok: false, error: 'Provedor não encontrado.' });
      return;
    }
    res.json({ ok: true, provider: updated });
  });

  router.post('/api/hub/providers/:id/toggle', (req, res) => {
    const updated = toggleProviderAccount(req.params.id);
    if (!updated) {
      res.status(404).json({ ok: false, error: 'Provedor não encontrado.' });
      return;
    }
    res.json({ ok: true, provider: updated });
  });

  router.post('/api/hub/providers/:id/priority', (req, res) => {
    const dir = req.body?.direction === 'up' ? 'up' : 'down';
    const providers = moveProviderPriority(req.params.id, dir);
    res.json({ ok: true, providers });
  });

  router.post('/api/hub/providers/:id/test', async (req, res) => {
    try {
      const result = await testProviderAccount(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(400).json({ ok: false, message: err instanceof Error ? err.message : 'Erro ao testar API' });
    }
  });

  router.post('/api/hub/providers/discover', async (_req, res) => {
    try {
      const result = await discoverCodingProviders();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Erro ao procurar novas IAs de código',
      });
    }
  });

  router.post('/api/hub/providers/discover/add', (req, res) => {
    try {
      const rawItems = Array.isArray(req.body?.items)
        ? req.body.items
        : req.body?.defaultModel
          ? [req.body]
          : [];
      if (rawItems.length === 0) {
        res.status(400).json({ ok: false, error: 'Envie ao menos uma IA descoberta para adicionar.' });
        return;
      }
      const added = rawItems.map((item: Record<string, unknown>) =>
        addDiscoveredProvider({
          provider: String(item.provider || 'custom') as ProviderPresetId,
          name: String(item.name || item.defaultModel || 'IA Descoberta'),
          baseUrl: String(item.baseUrl || ''),
          defaultModel: String(item.defaultModel || ''),
          protocol: item.protocol === 'anthropic' ? 'anthropic' : 'openai',
          source: item.source as 'local-scan' | 'openrouter-free' | 'pollinations' | 'endpoint-sync' | undefined,
          apiKey: typeof item.apiKey === 'string' ? item.apiKey : undefined,
        })
      );
      res.json({ ok: true, providers: added, count: added.length });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Erro ao adicionar IA descoberta',
      });
    }
  });

  router.delete('/api/hub/providers/:id', (req, res) => {
    res.json({ ok: deleteProviderAccount(req.params.id) });
  });

  return router;
}
