import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { CodeAssistantRunner, createCodeProject } from '../utils/codeAssistant';
import { createAssistantTransport } from '../utils/assistantTransport';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-failover-test-'));
process.env.QD_DATA_DIR = dataDir;
const store = await import('./qoderStore.ts');
const proxy = await import('./multiAiProxy.ts');
type Obj = Record<string, any>;
const captured: Array<{ name: string; body: Obj }> = [];
const behavior = new Map<string, { status?: number; mode?: string; wait?: number; retryAfter?: string }>();
const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const name = new URL(req.url).pathname.split('/')[1];
  const body = await req.json() as Obj;
  captured.push({ name, body });
  const config = behavior.get(name) ?? {};
  if (config.mode === 'project-a') {
    if (captured.filter((entry) => entry.name === name).length > 1) return Response.json({ error: { message: 'credits depleted' } }, { status: 402 });
    return Response.json({ id: 'chatcmpl-project-a', model: 'project-a-model', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'plan_a', type: 'function', function: { name: 'set_plan', arguments: JSON.stringify({ tasks: ['Página inicial'] }) } },
      { id: 'write_a', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'index.html', content: '<h1>IA A</h1>' }) } },
    ] } }], usage: { prompt_tokens: 8, completion_tokens: 10 } });
  }
  if (config.mode === 'project-b') return Response.json({ id: 'msg_project_b', model: 'project-b-model', type: 'message', role: 'assistant', stop_reason: 'tool_use',
    content: [
      { type: 'tool_use', id: 'replace_b', name: 'replace_in_file', input: { path: 'index.html', old_text: 'IA A', new_text: 'Concluído por B' } },
      { type: 'tool_use', id: 'task_b', name: 'set_task_status', input: { id: 'task-1', status: 'completed' } },
      { type: 'tool_use', id: 'finish_b', name: 'project_complete', input: { summary: 'Página implementada; validação humana pendente.' } },
    ], usage: { input_tokens: 10, output_tokens: 12 } });
  if (config.wait) await new Promise((r) => setTimeout(r, config.wait));
  if (config.status) return Response.json({ error: { message: 'simulated limit' } }, { status: config.status,
    headers: config.retryAfter ? { 'Retry-After': config.retryAfter } : {} });
  if (config.mode === 'json') return Response.json({ id: 'chatcmpl-json', choices: [{ index: 0,
    message: { role: 'assistant', content: 'json answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
  if (config.mode === 'anthropic') {
    const events = [
      { type: 'message_start', message: { id: 'msg_test', model: 'claude-model', usage: { input_tokens: 12 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_abc', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"main.ts"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (config.mode === 'early-error') return new Response('data: {"error":{"message":"quota after HTTP200"}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  const chunk = (delta: Obj, finish_reason: string | null = null) => JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason }] });
  const chunks = config.mode === 'tool' ? [
    chunk({ tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"main.ts"}' } }] }), chunk({}, 'tool_calls'),
  ] : [chunk({ role: 'assistant' }), chunk({ content: 'Project preserved' }), chunk({}, 'stop')];
  if (config.mode === 'truncated') chunks.pop();
  if (config.mode === 'late-error') {
    chunks.splice(2);
    chunks.push(JSON.stringify({ error: { message: 'network failed late' } }));
  }
  const ending = config.mode === 'truncated' || config.mode === 'late-error' ? '' : 'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":8}}\n\ndata: [DONE]\n\n';
  return new Response(chunks.map((c) => `data: ${c}\n\n`).join('') + ending, { headers: { 'Content-Type': 'text/event-stream' } });
} });
let server: ReturnType<express.Express['listen']>;
let base: string;
let applicationServer: ReturnType<express.Express['listen']>;
let applicationBase: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.post('/v1/chat/completions', (req, res) => void proxy.handleChatCompletions(req, res));
  const { createAssistantRouter } = await import('./hubRouter.ts');
  const application = express();
  application.use(express.json());
  application.use(createAssistantRouter());
  application.use((_req, res) => res.status(404).json({ error: { type: 'not_found' } }));
  await new Promise<void>((resolve) => { applicationServer = application.listen(0, '127.0.0.1', resolve); });
  applicationBase = `http://127.0.0.1:${(applicationServer.address() as any).port}`;
  app.post('/v1/messages', (req, res) => void proxy.handleAnthropicMessages(req, res));
  // Legacy protocol adapters are tested only in this fixture, never mounted by the application.
  app.post('/v1/responses', (req, res) => void proxy.handleResponsesApi(req, res));
  app.use(createAssistantRouter());
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
beforeEach(() => {
  for (const p of store.getAllRawProviders()) store.deleteProviderAccount(p.id);
  store.updateSettings({ autoFailoverEnabled: true, requireApiKey: false });
  captured.length = 0;
  behavior.clear();
  delete process.env.QD_UPSTREAM_TIMEOUT_MS;
});
afterAll(async () => {
  upstream.stop(true);
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => applicationServer.close(() => r()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});
function add(name: string, config: Obj = {}, protocol: 'openai' | 'anthropic' = 'openai') {
  behavior.set(name, config);
  return store.addProviderAccount({ provider: 'custom', name, baseUrl: `${upstream.url.origin}/${name}/v1`,
    defaultModel: `${name}-model`, apiKey: 'TEST-NOT-REAL', protocol });
}
const history = [{ role: 'system', content: 'Keep the project files and task plan.' },
  { role: 'user', content: 'Continue project' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'old_call', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/main.ts"}' } }] },
  { role: 'tool', tool_call_id: 'old_call', content: 'Existing file contents' }];
const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
function request(route = '/v1/chat/completions', body: Obj = {}) {
  return fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'auto-failover', messages: history, tools, ...body }) });
}

describe('multi-IA continuity with controlled upstreams (no real credentials)', () => {
  test('production router does not publish gateways, gateway keys or Qoder account APIs', async () => {
    for (const route of ['/v1/models', '/v1/chat/completions', '/v1/messages', '/v1/responses', '/credits/summary', '/api/hub/overview', '/api/hub/chat', '/api/app/keys', '/api/app/accounts/export', '/api/app/oauth/start']) {
      for (const method of ['GET', 'POST', 'OPTIONS']) {
        const response = await fetch(applicationBase + route, { method });
        expect(response.status).toBe(404);
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
      }
    }
  });
  test('internal APIs reject cross-origin calls before reading keys or invoking a provider', async () => {
    const provider = add('working');
    for (const headers of [{ Origin: 'https://unrelated.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      const response = await fetch(applicationBase + '/api/app/assistant/complete', { method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: `provider:${provider.id}`, messages: history }) });
      expect(response.status).toBe(403);
    }
    expect(captured).toHaveLength(0);
  });
  test('overview preserves provider data without exposing or deleting legacy gateway keys', async () => {
    const key = store.createApiKey('test-preserved-key', 'auto');
    const provider = add('working');
    const response = await fetch(applicationBase + '/api/app/overview');
    const data = await response.json() as Obj;
    expect(data.providers.some((p: Obj) => p.id === provider.id)).toBe(true);
    expect(data.apiKeys).toEqual([]); expect(data.accounts).toEqual([]);
    expect(JSON.stringify(data)).not.toContain(key.key);
    expect(JSON.stringify(data)).not.toContain('TEST-NOT-REAL');
    expect(store.getOverview().apiKeys.some((p) => p.id === key.id)).toBe(true);
    store.deleteApiKey(key.id);
  });
  test('only automatic assistant handoff can be changed in application settings', async () => {
    const response = await fetch(applicationBase + '/api/app/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requireApiKey: false, fallbackToQoderZeroX: true }) });
    expect(response.status).toBe(400);
    const valid = await fetch(applicationBase + '/api/app/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoFailoverEnabled: false }) });
    expect(valid.status).toBe(200); expect(store.getSettings().autoFailoverEnabled).toBe(false);
  });
  test('empty assistant pool returns a clear error, not a Qoder fallback', async () => {
    const response = await fetch(applicationBase + '/api/app/assistant/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto-failover', messages: history }) });
    expect(response.status).toBe(503); expect(captured).toHaveLength(0);
  });
  test('unknown or inconsistent assistant identity is rejected without inference', async () => {
    const first = add('first'), second = add('second');
    for (const body of [
      { model: `provider:${first.id}`, assistant_provider_ids: [second.id] },
      { model: 'provider:missing', assistant_provider_ids: [first.id] },
      { model: `provider:${first.id}`, assistant_provider_ids: ['missing'] },
      { model: 'qoder-model' },
    ]) {
      const response = await fetch(applicationBase + '/api/app/assistant/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, messages: history }) });
      expect(response.status).toBe(400);
    }
    expect(captured).toHaveLength(0);
  });
  test('internal chat rotates through external APIs only and keeps the submitted context', async () => {
    add('empty', { status: 402 }); add('working');
    const response = await fetch(applicationBase + '/api/app/assistant/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto-failover', messages: history, tools }) });
    expect(response.status).toBe(200);
    expect(captured.map((entry) => entry.name)).toEqual(['empty', 'working']);
    expect(captured[1].body.messages).toEqual(history);
  });
  test('local health reports the application without gateway telemetry', async () => {
    const response = await fetch(applicationBase + '/health');
    expect(await response.json()).toEqual({ ok: true, service: 'code-assistants', gateway: false });
  });
  test('real HTTP project execution: OpenAI A edits →402→Anthropic B continues the same checkpoint', async () => {
    const a = add('project-a', { mode: 'project-a' }), b = add('project-b', { mode: 'project-b' }, 'anthropic');
    const project = createCodeProject({ name: 'Integração executora', goal: 'Criar página HTML', providerIds: [a.id, b.id] });
    let checkpoint = '';
    const runner = new CodeAssistantRunner(project, createAssistantTransport((url, init) => fetch(base + url, init)), (p) => { checkpoint = JSON.stringify(p); });
    await runner.run();
    expect(captured.map((entry) => entry.name)).toEqual(['project-a', 'project-a', 'project-b']);
    expect(runner.project.status).toBe('review');
    expect(runner.project.files['index.html']).toBe('<h1>Concluído por B</h1>');
    expect(runner.project.revision).toBe(2);
    expect(runner.project.events.some((e) => e.type === 'handoff' && e.providerId === b.id)).toBe(true);
    expect(captured[2].body.system[0].text).toContain('index.html');
    expect(captured[2].body.messages.flatMap((m: Obj) => m.content).some((block: Obj) => block.type === 'tool_result' && JSON.stringify(block.content).includes('saved'))).toBe(true);
    expect(JSON.parse(checkpoint).files).toEqual(runner.project.files);
  });
  test('scoped project turn never falls through to an unselected provider', async () => {
    const bad = add('empty', { status: 402 }); add('working');
    const response = await request('/api/app/assistant/complete', { model: `provider:${bad.id}`, assistant_provider_ids: [bad.id] });
    expect(response.status).toBe(503); expect(captured.map((entry) => entry.name)).toEqual(['empty']);
  });
  test('402 → 429 → 503 → success preserves messages, tools, priority, cooldown and usage', async () => {
    const first = add('empty', { status: 402 }); const second = add('limited', { status: 429, retryAfter: '120' });
    add('down', { status: 503 }); const winner = add('working');
    const res = await request(); expect(res.status).toBe(200);
    const data = await res.json() as Obj;
    expect(data.choices[0].message.content).toBe('Project preserved');
    expect(captured.map((x) => x.name)).toEqual(['empty', 'limited', 'down', 'working']);
    for (const x of captured) { expect(x.body.messages).toEqual(history); expect(x.body.tools).toEqual(tools); }
    expect(data.qoder_meta.failover_chain).toEqual(['empty', 'limited', 'down']);
    expect(data.usage.prompt_tokens).toBe(12);
    const providers = store.getAllRawProviders();
    expect(providers.find((p) => p.id === first.id)?.errorCount).toBe(1);
    expect(providers.find((p) => p.id === second.id)!.cooldownUntil! - Math.floor(Date.now() / 1000)).toBeGreaterThan(110);
    expect(providers.find((p) => p.id === winner.id)?.requestCount).toBe(1);
    captured.length = 0; await request(); expect(captured.map((x) => x.name)).toEqual(['working']);
  });
  test('disabled auto-failover really stops after first provider', async () => {
    add('empty', { status: 402 }); add('working'); store.updateSettings({ autoFailoverEnabled: false });
    expect((await request()).status).toBe(503); expect(captured.map((x) => x.name)).toEqual(['empty']);
  });
  test('explicit provider in cooldown falls back without Qoder rerouting', async () => {
    const bad = add('empty', { status: 429 }); add('working'); store.markProviderCooldown(bad.id, 60, 'limited');
    expect((await request('/v1/chat/completions', { model: `provider:${bad.id}` })).status).toBe(200);
    expect(captured.map((x) => x.name)).toEqual(['working']);
  });
  test('HTTP200 SSE error before first token advances the queue', async () => {
    add('broken', { mode: 'early-error' }); add('working');
    const res = await request('/v1/chat/completions', { stream: true }); const text = await res.text();
    expect(res.status).toBe(200); expect(text).toContain('Project preserved'); expect(text).not.toContain('quota after');
    expect(captured.map((x) => x.name)).toEqual(['broken', 'working']);
  });
  test('truncated nonstream completion is retried, not labelled success', async () => {
    add('cut', { mode: 'truncated' }); add('working');
    expect((await request()).status).toBe(200); expect(captured.map((x) => x.name)).toEqual(['cut', 'working']);
    expect(store.getAllRawProviders()[0].requestCount).toBe(0);
  });
  test('late streaming failure is explicit, never replays delivered operations', async () => {
    add('cut', { mode: 'late-error' }); add('working');
    const text = await (await request('/v1/chat/completions', { stream: true })).text();
    expect(text).toContain('partial_stream_error'); expect(text).not.toContain('[DONE]');
    expect(captured.map((x) => x.name)).toEqual(['cut']);
  });
  test('OpenAI tool calls survive aggregation, including arguments and finish reason', async () => {
    add('working', { mode: 'tool' }); const data = await (await request()).json() as Obj;
    expect(data.choices[0].finish_reason).toBe('tool_calls');
    expect(data.choices[0].message.tool_calls[0]).toEqual({ id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '{"path":"main.ts"}' } });
  });
  test('Anthropic upstream converts tool calls and usage to OpenAI', async () => {
    add('claude', { mode: 'anthropic' }, 'anthropic'); const data = await (await request()).json() as Obj;
    expect(captured[0].body.messages.at(-1).content[0].type).toBe('tool_result');
    expect(data.choices[0].message.tool_calls[0].id).toBe('call_abc');
    expect(data.choices[0].finish_reason).toBe('tool_calls'); expect(data.usage.prompt_tokens).toBe(12);
  });
  test('Anthropic request and output tool_use are correctly structured', async () => {
    add('working', { mode: 'tool' }); const data = await (await request('/v1/messages', {
      system: [{ type: 'text', text: 'Preserve project' }], messages: [{ role: 'user', content: 'Read files' }],
      tools: [{ name: 'read_file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    })).json() as Obj;
    expect(data.type).toBe('message'); expect(data.stop_reason).toBe('tool_use');
    expect(data.content.find((b: Obj) => b.type === 'tool_use').input).toEqual({ path: 'main.ts' });
    expect(captured[0].body.tools[0].function.name).toBe('read_file');
  });
  test('Anthropic SSE tool block lifecycle', async () => {
    add('working', { mode: 'tool' }); const text = await (await request('/v1/messages', {
      messages: [{ role: 'user', content: 'Read files' }], tools: [{ name: 'read_file', input_schema: { type: 'object' } }], stream: true,
    })).text();
    expect(text).toContain('event: message_start'); expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"type":"input_json_delta"'); expect(text).toContain('"stop_reason":"tool_use"');
    expect(text).toContain('event: message_stop');
  });
  test('Responses function calls/output preserve IDs and SSE completion events', async () => {
    add('working', { mode: 'tool' }); const res = await request('/v1/responses', {
      input: [{ type: 'function_call', call_id: 'old_call', name: 'read_file', arguments: '{"path":"old.ts"}' },
        { type: 'function_call_output', call_id: 'old_call', output: 'old content' }],
      tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }], stream: true,
    });
    const text = await res.text(); expect(res.status).toBe(200); expect(text).toContain('response.function_call_arguments.done');
    expect(text).toContain('response.completed'); expect(text).toContain('"call_id":"call_abc"');
    expect(captured[0].body.messages.at(-1).tool_call_id).toBe('old_call');
  });
  test('slow headers time out and next API receives the same project', async () => {
    process.env.QD_UPSTREAM_TIMEOUT_MS = '40'; add('slow', { wait: 200 }); add('working');
    expect((await request()).status).toBe(200); expect(captured.map((x) => x.name)).toEqual(['slow', 'working']);
  });
  test('JSON-only compatible API works and does not need a fake SSE stream', async () => {
    add('working', { mode: 'json' }); const data = await (await request()).json() as Obj;
    expect(data.choices[0].message.content).toBe('json answer');
  });
  test('all exhausted produces a clear unavailable error', async () => {
    add('a', { status: 401 }); add('b', { status: 403 }); const res = await request(); expect(res.status).toBe(503);
    expect(captured.map((x) => x.name)).toEqual(['a', 'b']);
  });
});
