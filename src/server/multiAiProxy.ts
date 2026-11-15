import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { ExternalProviderAccount, RealmId, RequestLogEntry } from '../types/hub.ts';
import { resolveModel } from './qoderCatalog.ts';
import { tryQoderModel, iterateUpstreamAsOpenAiChunks, type OpenAiMessage } from './qoderProxy.ts';
import { getAllRawAccounts, getOrderedActiveProviders, getSettings, markProviderCooldown,
  markAccountCooldown, recordProviderSuccess, recordRequestLog } from './qoderStore.ts';
import { AnthropicChunkConverter, fromAnthropicRequest, fromResponsesRequest,
  toAnthropicRequest, toAnthropicResponse, toResponsesResponse,
  type BridgeMessage, type BridgeOptions, type ChatCompletion } from './protocolBridge.ts';
import { CompletionAccumulator, AnthropicStreamWriter, startSse, event, writeResponsesSse } from './completionStream.ts';
import { cooldownSeconds, retryAfterSeconds, readSse, safeError, timeoutMs, UpstreamFailure, withDeadline } from './failoverTransport.ts';

type Obj = Record<string, any>;
type Protocol = RequestLogEntry['protocol'];
type Options = BridgeOptions & { signal: AbortSignal; bufferResponse: boolean; assistantProviderIds?: string[] };
interface Upstream {
  providerName: string;
  accountUid?: string;
  accountNickname: string;
  realm: RealmId;
  displayName: string;
  externalProvider?: ExternalProviderAccount;
  failoverFrom?: string;
  failoverChain: string[];
  chunks: AsyncIterable<Obj>;
  cancel: () => void;
  contentType?: string;
}

function meaningful(chunk: Obj): boolean {
  return (chunk.choices ?? []).some((c: Obj) => c.finish_reason || c.delta?.content || c.delta?.reasoning_content || c.delta?.tool_calls?.length);
}
function validateMessages(messages: BridgeMessage[], body: Obj): void {
  if (!messages.length) throw new UpstreamFailure('Campo messages/input é obrigatório.', 400);
  if (body.n && body.n !== 1) throw new UpstreamFailure('Use n=1 no gateway.', 400);
  for (const m of messages) {
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role)) throw new UpstreamFailure('Role inválida.', 400);
    if (m.role === 'tool' && !m.tool_call_id) throw new UpstreamFailure('tool_call_id é obrigatório para resultados de ferramentas.', 400);
  }
}

async function openExternal(prv: ExternalProviderAccount, messages: BridgeMessage[], options: Options): Promise<Upstream> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const signal = AbortSignal.any([controller.signal, options.signal]);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const body: Obj = prv.protocol === 'anthropic' ? toAnthropicRequest(messages, options, prv.defaultModel) : {
    model: prv.defaultModel, messages, stream: true, stream_options: { include_usage: true },
    max_tokens: options.maxTokens ?? 8192,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.tools?.length ? { tools: options.tools } : {}),
    ...(options.toolChoice !== undefined ? { tool_choice: options.toolChoice } : {}),
    ...(options.parallelToolCalls !== undefined ? { parallel_tool_calls: options.parallelToolCalls } : {}),
    ...(options.responseFormat !== undefined ? { response_format: options.responseFormat } : {}),
    ...(options.thinkingEffort ? { reasoning_effort: options.thinkingEffort } : {}),
  };
  body.stream = true;
  if (prv.protocol === 'anthropic') {
    headers['x-api-key'] = prv.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (prv.apiKey && prv.apiKey !== 'local-no-key') headers.Authorization = `Bearer ${prv.apiKey}`;
  if (prv.provider === 'openrouter') { headers['HTTP-Referer'] = 'https://qoder2api-hub.local'; headers['X-Title'] = 'Qoder2API-Hub'; }
  const url = `${prv.baseUrl.replace(/\/+$/, '')}/${prv.protocol === 'anthropic' ? 'messages' : 'chat/completions'}`;
  try {
    const response = await withDeadline(fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal }),
      timeoutMs('QD_UPSTREAM_TIMEOUT_MS', 20000), cancel);
    if (!response.ok || !response.body) {
      const text = await withDeadline(response.text(), 3000, cancel).catch(() => '');
      throw new UpstreamFailure(`${prv.name}: HTTP ${response.status} ${text.slice(0, 300)}`, response.status,
        retryAfterSeconds(response.headers.get('retry-after')));
    }
    const totalTimer = setTimeout(cancel, timeoutMs('QD_UPSTREAM_TOTAL_TIMEOUT_MS', 180000));
    const stop = () => { clearTimeout(totalTimer); cancel(); };
    const contentType = response.headers.get('content-type') ?? '';
    return {
      providerName: prv.name, accountUid: prv.id, accountNickname: prv.name, realm: 'intl',
      displayName: prv.defaultModel, externalProvider: prv, failoverChain: [], contentType, cancel: stop,
      chunks: normalizeExternal(response, prv.protocol, stop),
    };
  } catch (e) { cancel(); throw e; }
}

async function* normalizeExternal(response: globalThis.Response, protocol: string, cancel: () => void): AsyncGenerator<Obj> {
  const converter = new AnthropicChunkConverter();
  let finished = false;
  try {
    if ((response.headers.get('content-type') ?? '').includes('application/json')) {
      const data = await withDeadline(response.json(), timeoutMs('QD_STREAM_IDLE_TIMEOUT_MS', 30000), cancel) as Obj;
      if (data.error) throw new UpstreamFailure(JSON.stringify(data.error));
      if (protocol === 'anthropic') {
        for (const chunk of converter.convert({ type: 'message_start', message: { ...data, content: [] } })) yield chunk;
        for (let i = 0; i < (data.content ?? []).length; i++) {
          const block = data.content[i];
          for (const chunk of converter.convert({ type: 'content_block_start', index: i, content_block: block })) yield chunk;
          for (const chunk of converter.convert({ type: 'content_block_stop', index: i })) yield chunk;
        }
        for (const chunk of converter.convert({ type: 'message_delta', delta: { stop_reason: data.stop_reason }, usage: data.usage })) yield chunk;
      } else {
        if (!Array.isArray(data.choices)) throw new UpstreamFailure('Resposta do provedor não contém choices.');
        yield { ...data, choices: data.choices.map((c: Obj) => ({ ...c, delta: c.message,
          ...(c.message?.tool_calls ? { delta: { ...c.message, tool_calls: c.message.tool_calls.map((t: Obj, i: number) => ({ ...t, index: i })) } } : {}) })) };
      }
      finished = true;
      return;
    }
    for await (const payload of readSse(response.body!, cancel)) {
      if (payload === '[DONE]') { finished = true; break; }
      let data: Obj;
      try { data = JSON.parse(payload); } catch { throw new UpstreamFailure('JSON inválido no stream do provedor.'); }
      if (data.error || data.type === 'error') throw new UpstreamFailure(JSON.stringify(data.error ?? data));
      if (protocol === 'anthropic') {
        if (data.type === 'message_stop') finished = true;
        for (const chunk of converter.convert(data)) {
          if ((chunk.choices ?? []).some((c: Obj) => c.finish_reason)) finished = true;
          yield chunk;
        }
      } else {
        if ((data.choices ?? []).some((c: Obj) => c.finish_reason)) finished = true;
        yield data;
      }
    }
  } finally { cancel(); }
  if (!finished) throw new UpstreamFailure('Conexão encerrada antes de concluir a resposta.', 502);
}

async function prepare(upstream: Upstream, options: Options): Promise<Upstream> {
  const iterator = upstream.chunks[Symbol.asyncIterator]();
  const buffered: Obj[] = [];
  let size = 0;
  try {
    const firstDeadline = Date.now() + timeoutMs('QD_FIRST_TOKEN_TIMEOUT_MS', 20000);
    while (true) {
      const step = await withDeadline(iterator.next(), options.bufferResponse ? timeoutMs('QD_STREAM_IDLE_TIMEOUT_MS', 30000) : Math.max(1, firstDeadline - Date.now()), upstream.cancel);
      if (step.done) {
        if (!buffered.some(meaningful)) throw new UpstreamFailure('Provedor encerrou sem resposta utilizável.');
        if (options.bufferResponse) {
          const acc = new CompletionAccumulator();
          for (const chunk of buffered) acc.add(chunk);
          validateCompletion(acc);
        }
        break;
      }
      buffered.push(step.value);
      size += JSON.stringify(step.value).length;
      if (size > (options.bufferResponse ? 64 : 8) * 1024 * 1024) throw new UpstreamFailure('Resposta excede limite de memória.');
      if (!options.bufferResponse && meaningful(step.value)) break;
    }
    upstream.chunks = (async function* () {
      try {
        for (const chunk of buffered) yield chunk;
        if (!options.bufferResponse) {
          while (true) {
            const step = await iterator.next();
            if (step.done) break;
            yield step.value;
          }
        }
      } finally { await iterator.return?.(); upstream.cancel(); }
    })();
    return upstream;
  } catch (e) { upstream.cancel(); await iterator.return?.().catch(() => undefined); throw e; }
}

async function selectUpstream(model: string, messages: BridgeMessage[], realm: RealmId | undefined,
  options: Options, protocol: Protocol): Promise<Upstream> {
  const settings = getSettings();
  const chain: string[] = [];
  let lastError: unknown;
  // Project orchestration owns its selected assistant queue and handoff checkpoints.
  // Never silently execute a project turn through a provider outside that queue.
  const external = getOrderedActiveProviders().filter((p) => !options.assistantProviderIds || options.assistantProviderIds.includes(p.id));
  const explicit = model.startsWith('provider:') ? model.slice(9) : undefined;
  let providers = external;
  if (explicit) {
    const target = external.find((p) => p.id === explicit);
    providers = target ? [target, ...external.filter((p) => p.id !== explicit)] : external;
    if (!target && !settings.autoFailoverEnabled) throw new UpstreamFailure('Provedor selecionado está pausado, em cooldown ou foi removido.', 503);
  }
  // An external model name selects its configured provider rather than entering Qoder's resolver.
  const matching = providers.find((p) => p.defaultModel.toLowerCase() === model.toLowerCase());
  if (!explicit && matching) providers = [matching, ...providers.filter((p) => p.id !== matching.id)];
  const usesTools = !!options.tools?.length || messages.some((m) => m.role === 'tool' || m.tool_calls?.length);
  const plainText = messages.every((m) => typeof m.content === 'string' || m.content == null);
  const canUseQoder = !options.assistantProviderIds && !explicit && !matching && !usesTools && plainText && !options.responseFormat;
  const qoderAccounts = getAllRawAccounts().filter((a) => a.enabled);
  if (canUseQoder && qoderAccounts.length) {
    const resolved = resolveModel(model === 'auto-failover' ? 'Auto' : model, realm ?? settings.defaultRealm);
    const actualRealm = settings.autoRealm ? resolved.realm : realm ?? settings.defaultRealm;
    const targets = [{ key: resolved.modelKey, name: resolved.displayName }];
    if (settings.autoFailoverEnabled && settings.fallbackToQoderZeroX && !['qfmodel', 'lmodel'].includes(resolved.modelKey)) targets.push({ key: 'qfmodel', name: 'Qwen3.8-Flash' });
    for (const target of targets) {
      for (let i = 0; i < qoderAccounts.length; i++) {
        if (options.signal.aborted) throw options.signal.reason;
        const start = Date.now();
        const result = await tryQoderModel(target.key, target.name, actualRealm, messages as OpenAiMessage[], options, chain.at(-1));
        if (!result.result) { lastError = new UpstreamFailure(result.error); chain.push(`Qoder (${target.name})`); break; }
        const old = result.result;
        try {
          const prepared = await prepare({ providerName: old.providerName, accountUid: old.accountUid,
            accountNickname: old.accountNickname, realm: old.realm, displayName: old.displayName,
            failoverFrom: chain.at(-1), failoverChain: [...chain], cancel: () => { void old.stream.cancel().catch(() => undefined); },
            chunks: iterateUpstreamAsOpenAiChunks(old) }, options);
          return prepared;
        } catch (e) {
          lastError = e;
          if (old.accountUid) markAccountCooldown(old.accountUid, cooldownSeconds(e), safeError(e));
          chain.push(`${old.accountNickname} (${target.name})`);
          recordRequestLog({ protocol, model: target.name, realm: actualRealm, provider: old.accountNickname,
            accountUid: old.accountUid, status: 502, latencyMs: Date.now() - start, stream: !options.bufferResponse, error: safeError(e) });
          if (!settings.autoFailoverEnabled) throw e;
        }
      }
    }
    if (!settings.autoFailoverEnabled) throw lastError ?? new UpstreamFailure('Qoder indisponível.', 503);
  }
  // Qoder's undocumented native agent transport is text-only here. Do not silently
  // drop executable tool calls or images; structured agent requests use external APIs.
  if (!settings.autoFailoverEnabled) providers = providers.slice(0, 1);
  for (const prv of providers) {
    if (options.signal.aborted) throw options.signal.reason;
    const start = Date.now();
    try {
      const upstream = await openExternal(prv, messages, options);
      upstream.failoverFrom = chain.at(-1);
      upstream.failoverChain = [...chain];
      return await prepare(upstream, options);
    } catch (e) {
      if (options.signal.aborted) throw options.signal.reason;
      lastError = e;
      const message = safeError(e, prv);
      markProviderCooldown(prv.id, cooldownSeconds(e), message);
      recordRequestLog({ protocol, model: prv.defaultModel, realm: 'intl', provider: prv.name,
        accountUid: prv.id, accountNickname: prv.name, failoverFrom: chain.at(-1), status: (e as UpstreamFailure).status ?? 502,
        latencyMs: Date.now() - start, stream: !options.bufferResponse, error: message });
      chain.push(prv.name);
    }
  }
  throw new UpstreamFailure(lastError ? safeError(lastError, providers.at(-1)) : 'Nenhuma IA disponível. Adicione chaves válidas em APIs IA ou aguarde a liberação do cooldown.', 503);
}

function headers(res: Response, upstream: Upstream, internalApp = false): void {
  // Header encoding cannot contain Unicode/newlines; JSON metadata retains full names.
  const encode = (s: string) => encodeURIComponent(s);
  if (internalApp) {
    res.setHeader('X-App-Provider', encode(upstream.providerName));
    if (upstream.failoverFrom) res.setHeader('X-App-Failover-From', encode(upstream.failoverFrom));
    return;
  }
  res.setHeader('X-Qoder-Provider', encode(upstream.providerName));
  res.setHeader('X-Qoder-Account', encode(upstream.accountNickname));
  res.setHeader('X-Qoder-Realm', upstream.realm);
  if (upstream.failoverFrom) res.setHeader('X-Qoder-Failover-From', encode(upstream.failoverFrom));
  res.setHeader('X-Hub-Failover-Chain', encode(JSON.stringify(upstream.failoverChain)));
}
function metadata(upstream: Upstream, latency: number): Obj {
  return { provider: upstream.providerName, provider_id: upstream.externalProvider?.id, failover_from: upstream.failoverFrom,
    failover_chain: upstream.failoverChain, realm: upstream.realm, account: upstream.accountNickname, latency_ms: latency };
}
function success(upstream: Upstream, acc: CompletionAccumulator, started: number, protocol: Protocol, stream: boolean): void {
  const latencyMs = Date.now() - started;
  if (upstream.externalProvider) recordProviderSuccess(upstream.externalProvider.id, !!upstream.failoverChain.length,
    { promptTokens: acc.promptTokens, completionTokens: acc.completionTokens, latencyMs });
  recordRequestLog({ protocol, model: upstream.displayName, realm: upstream.realm, provider: upstream.providerName,
    failoverFrom: upstream.failoverFrom, accountUid: upstream.accountUid, accountNickname: upstream.accountNickname,
    status: 200, latencyMs, stream, promptTokens: acc.promptTokens, completionTokens: acc.completionTokens });
}
function validateCompletion(acc: CompletionAccumulator): void {
  for (const t of acc.tools.values()) {
    if (!t.id || !t.function.name) throw new UpstreamFailure('Ferramenta recebida sem ID ou nome.');
    try { JSON.parse(t.function.arguments || '{}'); } catch { throw new UpstreamFailure('Argumentos de ferramenta incompletos.'); }
  }
}

async function handle(req: Request, res: Response, protocol: Protocol): Promise<void> {
  const started = Date.now();
  const body = (req.body ?? {}) as Obj;
  const controller = new AbortController();
  const clientClosed = () => { if (!res.writableEnded) controller.abort(new Error('Cliente desconectou.')); };
  res.once('close', clientClosed);
  let upstream: Upstream | undefined;
  let model = String(body.model ?? 'auto-failover');
  const wantStream = !!body.stream;
  try {
    let messages: BridgeMessage[];
    let bridge: BridgeOptions;
    if (protocol === 'anthropic-messages') ({ messages, options: bridge } = fromAnthropicRequest(body));
    else if (protocol === 'openai-responses') ({ messages, options: bridge } = fromResponsesRequest(body));
    else {
      messages = Array.isArray(body.messages) ? body.messages : [];
      bridge = { maxTokens: body.max_completion_tokens ?? body.max_tokens,
        temperature: body.temperature, tools: body.tools, toolChoice: body.tool_choice,
        parallelToolCalls: body.parallel_tool_calls, responseFormat: body.response_format,
        thinkingEffort: body.reasoning_effort };
    }
    validateMessages(messages, body);
    if (bridge.maxTokens !== undefined && (!Number.isFinite(bridge.maxTokens) || bridge.maxTokens < 1)) throw new UpstreamFailure('Limite de tokens inválido.', 400);
    const realm = req.header('x-realm') ?? req.query.realm;
    const scope = body.assistant_provider_ids;
    if (scope !== undefined && (!Array.isArray(scope) || !scope.length || scope.length > 100 || scope.some((id: unknown) => typeof id !== 'string' || !id))) throw new UpstreamFailure('Fila de code assistants inválida.', 400);
    upstream = await selectUpstream(model, messages, realm === 'cn' || realm === 'intl' ? realm : undefined,
      { ...bridge, sessionKey: req.header('x-session-id') ?? undefined, signal: controller.signal,
        assistantProviderIds: scope, bufferResponse: !wantStream || protocol === 'openai-responses' }, protocol);
    headers(res, upstream, protocol === 'android-chat');
    const acc = new CompletionAccumulator();
    let anthropicWriter: AnthropicStreamWriter | undefined;
    if (wantStream && protocol !== 'openai-responses') startSse(res);
    for await (const chunk of upstream.chunks) {
      if (controller.signal.aborted) throw controller.signal.reason;
      acc.add(chunk);
      if (!wantStream || protocol === 'openai-responses') continue;
      if (protocol === 'anthropic-messages') {
        if (!anthropicWriter) anthropicWriter = new AnthropicStreamWriter(res, upstream.displayName, { prompt_tokens: acc.promptTokens });
        anthropicWriter.write(chunk);
      } else res.write(`data: ${JSON.stringify({ ...chunk, model: upstream.displayName })}\n\n`);
    }
    validateCompletion(acc);
    const complete = { ...acc.completion(upstream.displayName), qoder_meta: metadata(upstream, Date.now() - started) } as ChatCompletion & Obj;
    if (protocol === 'openai-responses') {
      const response = { ...toResponsesResponse(complete), qoder_meta: complete.qoder_meta };
      if (wantStream) writeResponsesSse(res, response); else res.json(response);
    } else if (wantStream) {
      if (protocol === 'anthropic-messages') anthropicWriter?.end(complete.usage ?? {});
      else { res.write('data: [DONE]\n\n'); res.end(); }
    } else if (protocol === 'anthropic-messages') res.json({ ...toAnthropicResponse(complete), qoder_meta: complete.qoder_meta });
    else res.json(complete);
    success(upstream, acc, started, protocol, wantStream);
  } catch (e) {
    if (controller.signal.aborted) return;
    const message = safeError(e, upstream?.externalProvider);
    const status = (e as UpstreamFailure).status ?? (upstream ? 502 : 400);
    if (upstream?.externalProvider) markProviderCooldown(upstream.externalProvider.id, cooldownSeconds(e), message);
    if (upstream?.accountUid && !upstream.externalProvider) markAccountCooldown(upstream.accountUid, cooldownSeconds(e), message);
    recordRequestLog({ protocol, model, realm: upstream?.realm ?? getSettings().defaultRealm, provider: upstream?.providerName,
      failoverFrom: upstream?.failoverFrom, status, latencyMs: Date.now() - started, stream: wantStream, error: message });
    const error = { type: res.headersSent ? 'partial_stream_error' : 'gateway_error',
      message: res.headersSent ? `${message} Resposta parcial: o gateway não repetiu ferramentas já enviadas. Reenvie o contexto atualizado para continuar.` : message };
    if (res.headersSent) {
      if (protocol === 'anthropic-messages') event(res, 'error', { type: 'error', error });
      else res.write(`data: ${JSON.stringify({ error })}\n\n`);
      // No [DONE]/message_stop: a partial response must not be labelled successful.
      res.end();
    } else res.status(status).json(protocol === 'anthropic-messages' ? { type: 'error', error } : { error });
  } finally { upstream?.cancel(); res.off('close', clientClosed); }
}

export function handleChatCompletions(req: Request, res: Response, protocol: 'openai-chat' | 'android-chat' = 'openai-chat'): Promise<void> {
  return handle(req, res, protocol);
}
export function handleAnthropicMessages(req: Request, res: Response): Promise<void> { return handle(req, res, 'anthropic-messages'); }
export function handleResponsesApi(req: Request, res: Response): Promise<void> { return handle(req, res, 'openai-responses'); }
