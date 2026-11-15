import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  CATALOG_RETRY_MS,
  CATALOG_TTL_MS,
  createExternalCatalog,
  deduplicateExternalModels,
  normalizeCatalogBaseUrl,
  normalizeManualModel,
  normalizeOpenRouterModels,
} from './externalCatalog.ts';
import { getCatalog, resolveModel } from './qoderCatalog.ts';
import { isCatalogModelFree } from '../components/ModelsPanel.tsx';

const rawModel = {
  id: 'vendor/coder:free', name: 'Vendor Coder', context_length: 128_000,
  architecture: { input_modalities: ['text', 'image'] },
  top_provider: { max_completion_tokens: 8192 },
  supported_parameters: ['tools', 'reasoning'],
  pricing: { prompt: '0', completion: '0' },
};
const json = (data: unknown) => Response.json(data);
function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'external-catalog-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, cacheFile: path.join(directory, 'external-catalog.json') };
}

// All fetches below are controlled mocks. No provider keys or inference are used.
test('OpenRouter normalizes observed fields and deduplicates exact IDs', () => {
  const models = normalizeOpenRouterModels({ data: [rawModel, rawModel, { id: ' bad id ' }, null] }, 123);
  assert.equal(models.length, 1);
  assert.equal(models[0].modelName, rawModel.id);
  assert.equal(models[0].displayName, rawModel.name);
  assert.equal(models[0].source, 'openrouter');
  assert.equal(models[0].maxInputTokens, 128_000);
  assert.equal(models[0].maxOutputTokens, 8192);
  assert.equal(models[0].isVl, true);
  assert.equal(models[0].isReasoning, true);
  assert.equal(models[0].supportsTools, true);
  assert.equal(models[0].updatedAt, 123);
  assert.deepEqual(models[0].pricing, { prompt: 0, completion: 0, currency: 'USD', unit: 'token' });
  assert.deepEqual(models[0].availableRealms, []);
  assert.equal(isCatalogModelFree(models[0]), true);
  assert.throws(() => normalizeOpenRouterModels({ data: 'OK' }, 0), /JSON inválido/);
});

test('invalid numeric fields are not coerced into free pricing or invented context', () => {
  for (const value of [null, undefined, '', ' ', false, -1, '-1', 'NaN', 'Infinity', Infinity, {}, []]) {
    const [model] = normalizeOpenRouterModels({ data: [{ ...rawModel, context_length: value, top_provider: { max_completion_tokens: value }, pricing: { prompt: value, completion: value } }] }, 0);
    assert.equal(model.maxInputTokens, 0);
    assert.equal(model.maxOutputTokens, 0);
    assert.equal(model.pricing?.prompt, undefined);
    assert.equal(model.pricing?.completion, undefined);
    assert.equal(isCatalogModelFree(model), false);
  }
  const [fractional] = normalizeOpenRouterModels({ data: [{ id: 'coder', context_length: 1.5 }] }, 0);
  assert.equal(fractional.maxInputTokens, 0);
  assert.equal(fractional.supportsTools, undefined);
  const [paid] = normalizeOpenRouterModels({ data: [{ ...rawModel, pricing: { prompt: '0.000001', completion: '0.000002' } }] }, 0);
  assert.equal(isCatalogModelFree(paid), false);
  // A legacy credit multiplier is not evidence of free external API pricing.
  assert.equal(isCatalogModelFree({ ...paid, source: 'qoder', priceFactor: 0 }), false);
  assert.equal(isCatalogModelFree({ ...paid, source: undefined, priceFactor: 1 }), false);
  assert.equal(isCatalogModelFree({ ...paid, pricing: { prompt: 0, currency: 'USD', unit: 'token' } }), false);
});

test('manual entries validate provider, model ID, endpoint and protocol without accepting extra fields', () => {
  const model = normalizeManualModel({ provider: 'custom', modelId: 'org/model:tag', baseUrl: 'HTTP://LOCALHOST:1234/v1/', protocol: 'anthropic', apiKey: 'dummy-not-a-credential' }, 10);
  assert.equal(model.baseUrl, 'http://localhost:1234/v1');
  assert.equal(model.protocol, 'anthropic');
  assert.equal(model.source, 'manual');
  assert.equal(model.pricing, undefined);
  assert.equal(isCatalogModelFree(model), false);
  assert.equal('apiKey' in model, false);
  assert.throws(() => normalizeManualModel({ provider: 'invalid', modelName: 'x' }, 0), /Provedor/);
  assert.throws(() => normalizeManualModel({ provider: 'custom', modelName: 'x' }, 0), /baseUrl/);
  assert.throws(() => normalizeManualModel({ provider: 'openrouter', modelName: 'x', protocol: 'ftp' }, 0), /Protocolo/);
  for (const id of ['', ' ', 'model name', 'x\ny', 'x'.repeat(257), {}, false]) {
    assert.throws(() => normalizeManualModel({ provider: 'openrouter', modelName: id }, 0), /ID do modelo/);
  }
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@example.com/v1', 'https://example.com/v1?apiKey=dummy', 'https://example.com/v1#secret', 'not-a-url']) {
    assert.throws(() => normalizeCatalogBaseUrl(url));
  }
});

test('dedup keeps manual provenance and live metadata without merging distinct providers/endpoints/protocols', () => {
  const [live] = normalizeOpenRouterModels({ data: [rawModel] }, 1);
  const manual = normalizeManualModel({ provider: 'openrouter', modelName: rawModel.id, baseUrl: 'https://OPENROUTER.ai/api/v1/' }, 2);
  const alternate = normalizeManualModel({ provider: 'openrouter', modelName: rawModel.id, baseUrl: 'https://example.com/v1' }, 2);
  const github = normalizeManualModel({ provider: 'github', modelName: rawModel.id }, 2);
  const anthropic = { ...manual, protocol: 'anthropic' as const };
  const models = deduplicateExternalModels([live, live, manual, manual, alternate, github, anthropic]);
  assert.equal(models.length, 4);
  assert.equal(models[0].source, 'manual');
  assert.equal(models[0].maxInputTokens, 128_000);
  assert.equal(models[0].supportsTools, true);
  assert.equal(isCatalogModelFree(models[0]), true);
});

test('refresh follows controlled pagination, uses no Authorization and persists a TTL cache', async (t) => {
  const { cacheFile } = fixture(t);
  let clock = 1_000_000;
  const urls: string[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    assert.equal(new Headers(init?.headers).get('accept'), 'application/json');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    return url.includes('page=2')
      ? json({ data: [{ ...rawModel, id: 'vendor/paid', pricing: { prompt: '0.000001', completion: '0.000002' } }, rawModel], links: { next: null } })
      : json({ data: [rawModel], total_count: 2, links: { next: { href: '/api/v1/models?page=2' } } });
  };
  const catalog = createExternalCatalog({ cacheFile, fetch: fetchMock, now: () => clock });
  assert.equal(urls.length, 0);
  assert.equal(catalog.snapshot().models.length, 0);
  const result = await catalog.refresh('openrouter');
  assert.equal(result.ok, true);
  assert.equal(result.models.length, 2);
  assert.deepEqual(urls, ['https://openrouter.ai/api/v1/models', 'https://openrouter.ai/api/v1/models?page=2']);
  assert.equal(result.statuses.openrouter.updatedAt, clock);
  assert.equal((await catalog.refresh('openrouter')).cached, true);
  assert.equal(urls.length, 2);
  const restored = createExternalCatalog({ cacheFile, fetch: fetchMock, now: () => clock });
  assert.equal((await restored.refresh('openrouter')).cached, true);
  assert.deepEqual(restored.snapshot().models, result.models);
  clock += CATALOG_TTL_MS;
  assert.equal((await restored.refresh('openrouter')).cached, false);
  assert.equal(urls.length, 4);
});

test('partial page failures, non-JSON OK, HTTP outages and empty catalogs preserve cache and retry TTL', async (t) => {
  const { cacheFile } = fixture(t);
  let clock = 1_000_000;
  let mode = 'valid';
  let calls = 0;
  const catalog = createExternalCatalog({ cacheFile, now: () => clock, fetch: async (input) => {
    calls++;
    if (mode === 'non-json') return new Response('OK', { headers: { 'Content-Type': 'text/plain' } });
    if (mode === 'http') return new Response('unavailable', { status: 503 });
    if (mode === 'malformed') return new Response('{', { headers: { 'Content-Type': 'application/json' } });
    if (mode === 'empty') return json({ data: [] });
    if (mode === 'invalid') return json({ data: [{ id: false }] });
    if (mode === 'network' || String(input).includes('page=2')) throw new Error('controlled network failure');
    return json({ data: [mode === 'partial' ? { ...rawModel, id: 'vendor/replacement' } : rawModel], links: { next: mode === 'partial' ? '?page=2' : null } });
  } });
  const initial = await catalog.refresh('openrouter');
  for (const failure of ['non-json', 'http', 'malformed', 'empty', 'invalid', 'network', 'partial']) {
    mode = failure;
    clock += CATALOG_TTL_MS;
    const result = await catalog.refresh('openrouter');
    assert.equal(result.ok, false, failure);
    assert.deepEqual(result.models, initial.models, failure);
    assert.equal(result.statuses.openrouter.updatedAt, initial.statuses.openrouter.updatedAt);
    assert.match(result.message, /Cache anterior preservado/);
    const count = calls;
    assert.equal((await catalog.refresh('openrouter')).cached, true);
    assert.equal(calls, count);
    const restored = createExternalCatalog({ cacheFile, fetch: async () => { throw new Error('must not fetch during retry TTL'); }, now: () => clock });
    assert.equal((await restored.refresh('openrouter')).cached, true);
  }
  mode = 'valid';
  clock += CATALOG_RETRY_MS;
  const recovered = await catalog.refresh('openrouter');
  assert.equal(recovered.ok, true);
  assert.equal(recovered.statuses.openrouter.error, undefined);
});

test('pagination rejects off-catalog links, loops and excessive pages without committing partial results', async (t) => {
  const { cacheFile } = fixture(t);
  for (const next of ['https://example.com/api/v1/models', 'https://openrouter.ai/api/v1/other', 'https://user:pass@openrouter.ai/api/v1/models', '/api/v1/models', { bad: 'link' }]) {
    const catalog = createExternalCatalog({ cacheFile, fetch: async () => json({ data: [rawModel], links: { next } }) });
    const result = await catalog.refresh('openrouter');
    assert.equal(result.ok, false);
    assert.equal(result.models.length, 0);
    fs.rmSync(cacheFile);
  }
  let calls = 0;
  const catalog = createExternalCatalog({ cacheFile, fetch: async () => json({ data: [rawModel], links: { next: `?page=${++calls}` } }) });
  assert.equal((await catalog.refresh('openrouter')).ok, false);
  assert.equal(calls, 20);
  assert.equal(catalog.snapshot().models.length, 0);
});

test('GitHub retirement always reports unavailable and preserves even a recently saved previous cache', async (t) => {
  const { cacheFile } = fixture(t);
  const old = { ...normalizeManualModel({ provider: 'github', modelName: 'previous/github-model' }, 1), source: 'github', maxInputTokens: 4096 };
  fs.writeFileSync(cacheFile, JSON.stringify({ version: 1, providers: { github: { models: [old], status: { updatedAt: 1 } } }, manual: [] }));
  let calls = 0;
  const catalog = createExternalCatalog({ cacheFile, now: () => 2, fetch: async () => { calls++; return new Response('OK', { headers: { 'Content-Type': 'text/plain' } }); } });
  const result = await catalog.refresh('github');
  assert.equal(result.ok, false);
  assert.match(result.message, /descontinuado.*indisponível/);
  assert.equal(result.models[0].modelName, 'previous/github-model');
  assert.equal(result.models[0].maxInputTokens, 4096);
  assert.equal(result.statuses.github.updatedAt, 1);
  assert.equal((await catalog.refresh('github')).cached, true);
  assert.equal(calls, 0, 'retired GitHub endpoint is deliberately not queried');
  assert.equal(createExternalCatalog({ cacheFile }).snapshot().models[0].modelName, 'previous/github-model');
});

test('concurrent refresh is shared and does not drop manual entries or another provider failure', async (t) => {
  const { cacheFile } = fixture(t);
  let release!: (response: Response) => void;
  let calls = 0;
  const catalog = createExternalCatalog({ cacheFile, fetch: async () => { calls++; return new Promise<Response>((resolve) => { release = resolve; }); } });
  const first = catalog.refresh('openrouter');
  assert.equal(catalog.refresh('openrouter'), first);
  catalog.addManual({ provider: 'openai', modelName: 'manual/coder' });
  assert.equal((await catalog.refresh('github')).ok, false);
  release(json({ data: [rawModel] }));
  const result = await first;
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.models.length, 2);
  assert.match(result.statuses.github.error!, /descontinuado/);
  const restored = createExternalCatalog({ cacheFile });
  assert.equal(restored.snapshot().models.length, 2);
});

test('manual writes deduplicate, survive restart and never touch the isolated Qoder resolver', async (t) => {
  const { cacheFile } = fixture(t);
  const before = structuredClone(getCatalog());
  let calls = 0;
  const catalog = createExternalCatalog({ cacheFile, fetch: async () => { calls++; return json({ data: [rawModel] }); } });
  const entry = { provider: 'openrouter', modelName: 'isolated/external-coder' };
  catalog.addManual(entry);
  catalog.addManual({ ...entry, baseUrl: 'https://OPENROUTER.ai/api/v1/' });
  assert.equal(catalog.snapshot().models.length, 1);
  assert.equal(calls, 0, 'manual save does not enroll or probe providers');
  assert.equal(createExternalCatalog({ cacheFile }).snapshot().models.length, 1);
  assert.deepEqual(getCatalog(), before);
  assert.equal(resolveModel('isolated/external-coder', 'cn').catalogEntry, undefined);
  assert.equal(resolveModel('isolated/external-coder', 'cn').modelKey, 'isolated/external-coder');
  assert.equal(resolveModel('qfmodel', 'intl').catalogEntry?.key, 'qfmodel');
});

test('malformed caches are ignored and invalid stored numbers are re-normalized', async (t) => {
  const { cacheFile } = fixture(t);
  fs.writeFileSync(cacheFile, '{broken');
  assert.equal(createExternalCatalog({ cacheFile }).snapshot().models.length, 0);
  const [old] = normalizeOpenRouterModels({ data: [rawModel] }, 1);
  fs.writeFileSync(cacheFile, JSON.stringify({ version: 1, providers: { openrouter: { models: [{ ...old, maxInputTokens: 'Infinity', pricing: { prompt: 'NaN', completion: '' }, apiKey: 'dummy' }, { provider: 'invalid' }], status: {} } }, manual: [] }));
  const restored = createExternalCatalog({ cacheFile }).snapshot().models;
  assert.equal(restored.length, 1);
  assert.equal(restored[0].maxInputTokens, 0);
  assert.equal(isCatalogModelFree(restored[0]), false);
  assert.equal('apiKey' in restored[0], false);
});

test('catalog response size, model count and manual entry count are bounded', async (t) => {
  const { cacheFile } = fixture(t);
  assert.throws(() => normalizeOpenRouterModels({ data: Array(10_001).fill(rawModel) }, 0), /limite/);
  const tooLarge = createExternalCatalog({ cacheFile, fetch: async () => new Response(' '.repeat(8 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }) });
  const result = await tooLarge.refresh('openrouter');
  assert.equal(result.ok, false);
  assert.match(result.message, /limite de tamanho/);
  assert.equal(result.models.length, 0);
  const manual = Array.from({ length: 500 }, (_, i) => normalizeManualModel({ provider: 'openai', modelName: `manual/${i}` }, 1));
  fs.writeFileSync(cacheFile, JSON.stringify({ version: 1, providers: {}, manual }));
  const catalog = createExternalCatalog({ cacheFile });
  assert.equal(catalog.snapshot().models.length, 500);
  assert.throws(() => catalog.addManual({ provider: 'openai', modelName: 'manual/overflow' }), /Limite de 500/);
  catalog.addManual({ provider: 'openai', modelName: 'manual/0' });
  assert.equal(catalog.snapshot().models.length, 500);
});

test('an empty cached success does not suppress the automatic refresh', async (t) => {
  const { cacheFile } = fixture(t);
  fs.writeFileSync(cacheFile, JSON.stringify({ version: 1, providers: { openrouter: { models: [], status: { updatedAt: 10 } } }, manual: [] }));
  let calls = 0;
  const catalog = createExternalCatalog({ cacheFile, now: () => 11, fetch: async () => { calls++; return json({ data: [rawModel] }); } });
  assert.equal((await catalog.refresh('openrouter')).ok, true);
  assert.equal(calls, 1);
});

test('persistence failure keeps the previous in-memory catalog', async (t) => {
  const { directory, cacheFile } = fixture(t);
  let clock = 1_000_000;
  let replacement = false;
  const catalog = createExternalCatalog({ cacheFile, now: () => clock, fetch: async () => json({ data: [{ ...rawModel, id: replacement ? 'new/model' : rawModel.id }] }) });
  const initial = await catalog.refresh('openrouter');
  fs.renameSync(cacheFile, path.join(directory, 'backup.json'));
  fs.mkdirSync(cacheFile);
  clock += CATALOG_TTL_MS;
  replacement = true;
  const result = await catalog.refresh('openrouter');
  assert.equal(result.ok, false);
  assert.match(result.message, /persistir/);
  assert.deepEqual(result.models, initial.models);
  assert.equal(fs.existsSync(`${cacheFile}.tmp`), false);
  assert.throws(() => catalog.addManual({ provider: 'openai', modelName: 'manual/new' }));
  assert.deepEqual(catalog.snapshot().models, initial.models);
});
