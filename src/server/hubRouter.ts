import express from 'express';
import type { ProviderPresetId } from '../types/hub.ts';
import { PROVIDER_PRESETS } from './providerPresets.ts';
import { getExternalCatalog } from './externalCatalog.ts';
import { createProjectBuildRouter } from './projectBuild.ts';
import { createDesktopUpdateRouter } from './desktopUpdates.ts';
import { handleChatCompletions } from './multiAiProxy.ts';
import {
  addDiscoveredProvider,
  addProviderAccount,
  addProviderAccountsBatch,
  deleteProviderAccount,
  discoverCodingProviders,
  getAllRawProviders,
  getOverview,
  getSettings,
  moveProviderPriority,
  testProviderAccount,
  toggleProviderAccount,
  updateProviderAccount,
  updateSettings,
} from './qoderStore.ts';

export function createAssistantRouter(): express.Router {
  const router = express.Router();

  // A random web page must not be able to alter the local key store.
  router.use('/api/app', (req, res, next) => {
    const origin = req.header('origin');
    if ((origin && origin !== `${req.protocol}://${req.get('host')}`) || req.header('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ error: { message: 'Gerenciamento permitido apenas pela interface local.' } });
      return;
    }
    next();
  });

  router.use('/api/app/project-build', createProjectBuildRouter());
  // Atualizador do aplicativo Windows: consulta os releases públicos e troca o
  // .exe em uso. No APK quem responde esse caminho é o motor Java.
  router.use(createDesktopUpdateRouter());

  // Old state stays on disk; public gateway and account routes are not mounted.
  router.use(["/v1", "/credits", "/ping", "/healthz", "/livez", "/readyz", "/api/hub"], (_req, res) => {
    res.status(404).json({ error: { type: "not_found", message: "Esta edição não oferece gateway. Use as assistentes dentro do aplicativo." } });
  });
  router.get("/health", (_req, res) => res.json({ ok: true, service: "code-assistants", gateway: false }));
  const appSettings = () => ({ ...getSettings(), autoRealm: false, autoCheckinEnabled: false,
    requireApiKey: false, fallbackToQoderZeroX: false, autoRefreshTokens: false });

  // Hub Management API
  router.get('/api/app/overview', (_req, res) => {
    const overview = getOverview();
    res.json({ ...overview, accounts: [], apiKeys: [], settings: appSettings(),
      totals: { ...overview.totals, accountsTotal: 0, accountsEnabled: 0, accountsInCooldown: 0,
        creditsRemain: 0, creditsUsed: 0, creditsSize: 0 },
      recentLogs: overview.recentLogs.filter((log) => !log.accountUid) });
  });

  router.get('/api/app/catalog', (req, res) => {
    res.json(getExternalCatalog().snapshot());
  });

  router.get('/api/app/catalog/providers', (_req, res) => {
    res.json(getExternalCatalog().snapshot());
  });

  router.post('/api/app/catalog/providers/refresh', async (req, res) => {
    const provider = req.body?.provider;
    if (provider !== 'openrouter' && provider !== 'github') {
      res.status(400).json({ ok: false, error: 'provider deve ser openrouter ou github.' });
      return;
    }
    try {
      const result = await getExternalCatalog().refresh(provider);
      res.status(result.ok ? 200 : 503).json(result);
    } catch (err) {
      res.status(503).json({ ok: false, error: err instanceof Error ? err.message : 'Catálogo indisponível.' });
    }
  });

  router.post('/api/app/catalog/manual', (req, res) => {
    try {
      const result = getExternalCatalog().addManual(req.body);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Entrada manual inválida.' });
    }
  });

  router.post('/api/app/settings', (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)
      || Object.keys(req.body).some((key) => key !== "autoFailoverEnabled") || typeof req.body.autoFailoverEnabled !== "boolean") {
      res.status(400).json({ error: { message: "Somente a troca automática entre APIs pode ser configurada nesta edição." } }); return;
    }
    updateSettings({ autoFailoverEnabled: req.body.autoFailoverEnabled });
    res.json({ ok: true, settings: appSettings() });
  });

  router.post("/api/app/assistant/complete", (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: { message: "Pedido de assistente inválido." } }); return;
    }
    const providers = getAllRawProviders();
    const known = new Set(providers.map((provider) => provider.id));
    const scope: unknown = body.assistant_provider_ids;
    if (scope !== undefined && (!Array.isArray(scope) || !scope.length || scope.length > 100
      || scope.some((id) => typeof id !== "string" || !known.has(id)) || new Set(scope).size !== scope.length)) {
      res.status(400).json({ error: { message: "Selecione uma fila válida de APIs cadastradas." } }); return;
    }
    const model = String(body.model || "auto-failover");
    if (model !== "auto-failover" && !(model.startsWith("provider:") && known.has(model.slice(9)))
      && !providers.some((provider) => provider.defaultModel.toLowerCase() === model.toLowerCase())) {
      res.status(400).json({ error: { message: "O modelo precisa estar configurado em uma das suas APIs." } }); return;
    }
    if (!providers.some((provider) => provider.enabled)) {
      res.status(503).json({ error: { message: "Nenhuma API habilitada. Cadastre suas assistentes na aba APIs IA." } }); return;
    }
    const selected = scope as string[] | undefined;
    if (selected && model.startsWith("provider:") && !selected.includes(model.slice(9))) {
      res.status(400).json({ error: { message: "A assistente selecionada não pertence à fila deste projeto." } }); return;
    }
    // Always scope chat/blueprints to external APIs. Project turns pass one ID;
    // the runner owns handoff and checkpoint continuity, never this transport.
    req.body = { ...body, model, assistant_provider_ids: selected ?? providers.map((provider) => provider.id) };
    void handleChatCompletions(req, res, "android-chat");
  });

  router.get('/api/app/settings', (_req, res) => {
    res.json(appSettings());
  });

  // Multi-Provider AI Code Assistant Failover Pool
  router.get('/api/app/providers/presets', (_req, res) => {
    res.json({ presets: PROVIDER_PRESETS });
  });

  router.post('/api/app/providers', (req, res) => {
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

  router.post('/api/app/providers/batch', (req, res) => {
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

  router.patch('/api/app/providers/:id', (req, res) => {
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

  router.post('/api/app/providers/:id/toggle', (req, res) => {
    const updated = toggleProviderAccount(req.params.id);
    if (!updated) {
      res.status(404).json({ ok: false, error: 'Provedor não encontrado.' });
      return;
    }
    res.json({ ok: true, provider: updated });
  });

  router.post('/api/app/providers/:id/priority', (req, res) => {
    const dir = req.body?.direction === 'up' ? 'up' : 'down';
    const providers = moveProviderPriority(req.params.id, dir);
    res.json({ ok: true, providers });
  });

  router.post('/api/app/providers/:id/test', async (req, res) => {
    try {
      const result = await testProviderAccount(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(400).json({ ok: false, message: err instanceof Error ? err.message : 'Erro ao testar API' });
    }
  });

  router.post('/api/app/providers/discover', async (_req, res) => {
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

  router.post('/api/app/providers/discover/add', (req, res) => {
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

  router.delete('/api/app/providers/:id', (req, res) => {
    res.json({ ok: deleteProviderAccount(req.params.id) });
  });

  router.use((err: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) { next(err); return; }
    res.status(400).json({ error: { type: 'invalid_request_error', message: err.message } });
  });
  return router;
}
