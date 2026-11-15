import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { ExternalProviderAccount, QoderAccount, RealmId } from '../types/hub.ts';
import { resolveModel } from './qoderCatalog.ts';
import { COSY_SESSIONS, generateRequestId, qoderEncode } from './qoderSign.ts';
import {
  addProviderUsage,
  getAllRawAccounts,
  getOrderedActiveProviders,
  getSettings,
  markAccountCooldown,
  markProviderCooldown,
  REALM_CONFIGS,
  recordProviderSuccess,
  recordRequestLog,
  recordRiskSignal,
  selectAccountForRequest,
} from './qoderStore.ts';

const CHAT_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';

export interface OpenAiMessage {
  role: string;
  content: string | Array<{ type?: string; text?: string }>;
  reasoning_content?: string;
}

function extractTextContent(content: OpenAiMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function estimatePromptChars(messages: OpenAiMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += extractTextContent(m.content).length;
  }
  return total;
}

function extractChunkTextAndUsage(chunk: Record<string, unknown>): {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
} {
  let text = '';
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  for (const ch of choices) {
    const delta = (ch as Record<string, unknown>)?.delta as Record<string, unknown> | undefined;
    if (delta?.content) text += String(delta.content);
    if (delta?.reasoning_content) text += String(delta.reasoning_content);
  }
  const usageObj =
    chunk.usage && typeof chunk.usage === 'object' ? (chunk.usage as Record<string, unknown>) : undefined;
  const promptTokens = usageObj ? Number(usageObj.prompt_tokens || usageObj.input_tokens || 0) || undefined : undefined;
  const completionTokens = usageObj
    ? Number(usageObj.completion_tokens || usageObj.output_tokens || 0) || undefined
    : undefined;
  return { text, promptTokens, completionTokens };
}

function buildQoderPayload(
  messages: OpenAiMessage[],
  modelKey: string,
  displayName: string,
  account: QoderAccount,
  options: { maxTokens?: number; temperature?: number; thinkingEffort?: string; stream?: boolean }
): Record<string, unknown> {
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const systemText = systemMsgs.map((m) => extractTextContent(m.content)).join('\n\n') || 'You are a helpful assistant.';
  const convoMsgs = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'developer' ? 'user' : m.role,
      content: extractTextContent(m.content),
    }));

  const lastUser = [...convoMsgs].reverse().find((m) => m.role === 'user');
  const promptText = lastUser?.content || 'hi';

  const requestId = generateRequestId();
  const sessionId = crypto.randomUUID();

  return {
    request_id: requestId,
    request_set_id: crypto.randomUUID(),
    chat_record_id: crypto.randomUUID(),
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      chatPrompt: '',
      extra: {
        context: [],
        modelConfig: {
          is_reasoning: Boolean(options.thinkingEffort),
          key: modelKey,
        },
        originalContent: {
          type: 'text',
          text: promptText.slice(0, 4000),
        },
      },
      features: [],
      imageUrls: null,
      text: {
        type: 'text',
        text: promptText.slice(0, 4000),
      },
    },
    image_urls: null,
    is_reply: true,
    is_retry: false,
    session_id: sessionId,
    code_language: '',
    source: 1,
    version: '3',
    chat_prompt: '',
    parameters: {
      max_tokens: Math.min(options.maxTokens || 32768, 65536),
      ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
    },
    aliyun_user_type: account.userType || 'personal_standard',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    model_config: {
      key: modelKey,
      display_name: displayName,
      model: '',
      format: 'openai',
      is_vl: true,
      is_reasoning: Boolean(options.thinkingEffort),
      api_key: '',
      url: '',
      source: 'system',
      max_input_tokens: 180000,
    },
    messages: [{ role: 'system', content: systemText }, ...convoMsgs],
    tools: [],
    business: {
      product: 'cli',
      version: '0.1.43',
      type: 'agent',
      id: crypto.randomUUID(),
      name: promptText.slice(0, 60) || 'chat',
      begin_at: Date.now(),
      stage: 'start',
    },
  };
}

interface UpstreamCallResult {
  kind: 'qoder' | 'openai-provider' | 'anthropic-provider';
  stream: ReadableStream<Uint8Array>;
  providerName: string;
  failoverFrom?: string;
  accountUid?: string;
  accountNickname: string;
  realm: RealmId;
  modelKey: string;
  displayName: string;
  externalProvider?: ExternalProviderAccount;
}

async function tryQoderModel(
  modelKey: string,
  displayName: string,
  realm: RealmId,
  messages: OpenAiMessage[],
  options: { maxTokens?: number; temperature?: number; thinkingEffort?: string; sessionKey?: string },
  failoverFrom?: string
): Promise<{ result?: UpstreamCallResult; error: string }> {
  const allInRealm = getAllRawAccounts().filter((a) => a.enabled && a.realm === realm);
  if (allInRealm.length === 0) {
    return { error: `Sem conta Qoder (${realm.toUpperCase()}) ativa.` };
  }

  let lastError = 'Falha no gateway Qoder.';
  const triedUids = new Set<string>();

  for (let attempt = 0; attempt < Math.min(4, allInRealm.length); attempt++) {
    const account = selectAccountForRequest(realm, options.sessionKey);
    if (!account || triedUids.has(account.uid)) break;
    triedUids.add(account.uid);

    const cfg = REALM_CONFIGS[realm];
    const hosts = [cfg.gateway, ...cfg.gatewayFallbacks];
    const bodyObj = buildQoderPayload(messages, modelKey, displayName, account, options);
    const encodedBody = qoderEncode(JSON.stringify(bodyObj));

    for (const host of hosts) {
      const rawUrl = `${host}${CHAT_PATH}`;
      const session = COSY_SESSIONS.get(account);
      const headers = session.headers(encodedBody, rawUrl, modelKey, true);

      try {
        const upstreamRes = await fetch(rawUrl, {
          method: 'POST',
          headers,
          body: encodedBody,
          signal: AbortSignal.timeout(120000),
        });

        if (upstreamRes.ok && upstreamRes.body) {
          return {
            result: {
              kind: 'qoder',
              stream: upstreamRes.body,
              providerName: 'Qoder',
              failoverFrom,
              accountUid: account.uid,
              accountNickname: account.nickname,
              realm,
              modelKey,
              displayName,
            },
            error: '',
          };
        }

        const errText = await upstreamRes.text().catch(() => '');
        lastError = `HTTP ${upstreamRes.status}: ${errText.slice(0, 220)}`;

        if (upstreamRes.status === 429 || errText.includes('10605') || errText.includes('isQueued')) {
          recordRiskSignal(errText.includes('10605') ? 'queue' : 'rate', lastError);
          markAccountCooldown(account.uid, 45, lastError);
          break;
        }
        if (upstreamRes.status === 401 || upstreamRes.status === 402 || upstreamRes.status === 403) {
          recordRiskSignal('rejected', lastError);
          markAccountCooldown(account.uid, 120, lastError);
          break;
        }
        if (upstreamRes.status === 430) {
          recordRiskSignal('version', lastError);
          break;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'Erro de conexão com upstream Qoder';
      }
    }
  }

  return { error: lastError };
}

async function tryExternalProvider(
  prv: ExternalProviderAccount,
  messages: OpenAiMessage[],
  options: { maxTokens?: number; temperature?: number },
  failoverFrom?: string
): Promise<{ result?: UpstreamCallResult; error: string }> {
  const startedAt = Date.now();
  const cleanMsgs = messages.map((m) => ({
    role: m.role === 'developer' ? 'user' : m.role,
    content: extractTextContent(m.content),
  }));

  try {
    if (prv.protocol === 'anthropic') {
      const systemText = cleanMsgs
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const anthropicMsgs = cleanMsgs
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        }));

      const upstreamRes = await fetch(`${prv.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': prv.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: prv.defaultModel,
          max_tokens: Math.min(options.maxTokens || 8192, 16384),
          stream: true,
          ...(systemText ? { system: systemText } : {}),
          messages: anthropicMsgs,
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (upstreamRes.ok && upstreamRes.body) {
        recordProviderSuccess(prv.id, Boolean(failoverFrom));
        return {
          result: {
            kind: 'anthropic-provider',
            stream: upstreamRes.body,
            providerName: prv.name,
            failoverFrom,
            accountUid: prv.id,
            accountNickname: prv.name,
            realm: 'intl',
            modelKey: prv.defaultModel,
            displayName: prv.defaultModel,
            externalProvider: prv,
          },
          error: '',
        };
      }

      const errText = await upstreamRes.text().catch(() => '');
      const msg = `${prv.name} HTTP ${upstreamRes.status}: ${errText.slice(0, 180)}`;
      const cooldownSec = upstreamRes.status === 401 || upstreamRes.status === 402 ? 300 : 60;
      markProviderCooldown(prv.id, cooldownSec, msg);
      recordRequestLog({
        protocol: 'anthropic-messages',
        model: prv.defaultModel,
        realm: 'intl',
        provider: prv.name,
        failoverFrom,
        accountUid: prv.id,
        accountNickname: prv.name,
        status: upstreamRes.status,
        latencyMs: Date.now() - startedAt,
        stream: true,
        error: msg,
      });
      return { error: msg };
    }

    const upstreamRes = await fetch(`${prv.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${prv.apiKey}`,
        'HTTP-Referer': 'https://qoder2api-hub.local',
        'X-Title': 'Qoder2API-Hub',
      },
      body: JSON.stringify({
        model: prv.defaultModel,
        stream: true,
        max_tokens: Math.min(options.maxTokens || 8192, 32768),
        ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
        messages: cleanMsgs,
      }),
      signal: AbortSignal.timeout(120000),
    });

    if (upstreamRes.ok && upstreamRes.body) {
      recordProviderSuccess(prv.id, Boolean(failoverFrom));
      return {
        result: {
          kind: 'openai-provider',
          stream: upstreamRes.body,
          providerName: prv.name,
          failoverFrom,
          accountUid: prv.id,
          accountNickname: prv.name,
          realm: 'intl',
          modelKey: prv.defaultModel,
          displayName: prv.defaultModel,
          externalProvider: prv,
        },
        error: '',
      };
    }

    const errText = await upstreamRes.text().catch(() => '');
    const msg = `${prv.name} HTTP ${upstreamRes.status}: ${errText.slice(0, 180)}`;
    const cooldownSec = upstreamRes.status === 401 || upstreamRes.status === 402 ? 300 : 60;
    markProviderCooldown(prv.id, cooldownSec, msg);
    recordRequestLog({
      protocol: 'openai-chat',
      model: prv.defaultModel,
      realm: 'intl',
      provider: prv.name,
      failoverFrom,
      accountUid: prv.id,
      accountNickname: prv.name,
      status: upstreamRes.status,
      latencyMs: Date.now() - startedAt,
      stream: true,
      error: msg,
    });
    return { error: msg };
  } catch (err) {
    const msg = err instanceof Error ? err.message : `Erro de rede em ${prv.name}`;
    markProviderCooldown(prv.id, 45, msg);
    recordRequestLog({
      protocol: prv.protocol === 'anthropic' ? 'anthropic-messages' : 'openai-chat',
      model: prv.defaultModel,
      realm: 'intl',
      provider: prv.name,
      failoverFrom,
      accountUid: prv.id,
      accountNickname: prv.name,
      status: 503,
      latencyMs: Date.now() - startedAt,
      stream: true,
      error: msg,
    });
    return { error: msg };
  }
}

async function callUpstreamWithFailover(
  requestedModel: string,
  messages: OpenAiMessage[],
  realmHint: RealmId | undefined,
  options: { maxTokens?: number; temperature?: number; thinkingEffort?: string; sessionKey?: string }
): Promise<UpstreamCallResult> {
  const settings = getSettings();
  const preferredRealm = realmHint || settings.defaultRealm;

  // Explicit provider route: "provider:<id>"
  if (requestedModel.startsWith('provider:')) {
    const targetId = requestedModel.slice('provider:'.length);
    const activeProviders = getOrderedActiveProviders();
    const target = activeProviders.find((p) => p.id === targetId);
    if (target) {
      const res = await tryExternalProvider(target, messages, options);
      if (res.result) return res.result;
      if (!settings.autoFailoverEnabled) throw new Error(res.error);
      // Otherwise continue down failover chain
      for (const fallbackPrv of activeProviders) {
        if (fallbackPrv.id === targetId) continue;
        const fb = await tryExternalProvider(fallbackPrv, messages, options, target.name);
        if (fb.result) return fb.result;
      }
      throw new Error(res.error);
    }
  }

  const effectiveModel = requestedModel === 'auto-failover' ? 'Auto' : requestedModel;
  const resolved = resolveModel(effectiveModel, preferredRealm);
  const realm = settings.autoRealm ? resolved.realm : preferredRealm;

  const errors: string[] = [];
  const hasEnabledQoder = getAllRawAccounts().some((a) => a.enabled);
  let lastFailedSource: string | undefined;

  if (hasEnabledQoder) {
    // Stage 1: Try Qoder pool with requested model
    const stage1 = await tryQoderModel(resolved.modelKey, resolved.displayName, realm, messages, options);
    if (stage1.result) return stage1.result;
    if (stage1.error) {
      errors.push(stage1.error);
      lastFailedSource = `Qoder (${resolved.displayName})`;
    }

    // Stage 2: If Qoder paid model failed/out of credits, try Qoder 0x Free model (Qwen3.8-Flash)
    if (settings.fallbackToQoderZeroX && resolved.modelKey !== 'qfmodel' && resolved.modelKey !== 'lmodel') {
      const stage2 = await tryQoderModel(
        'qfmodel',
        'Qwen3.8-Flash',
        realm,
        messages,
        options,
        lastFailedSource
      );
      if (stage2.result) return stage2.result;
      if (stage2.error) {
        errors.push(stage2.error);
        lastFailedSource = 'Qoder 0x (Qwen3.8-Flash)';
      }
    }
  }

  // Stage 3: Cascade across Free & External AI Coding Assistant Providers (Pollinations, OpenRouter :free, Gemini, Groq, GitHub, Ollama, etc.)
  if (settings.autoFailoverEnabled || requestedModel === 'auto-failover' || !hasEnabledQoder) {
    const activeProviders = getOrderedActiveProviders();
    for (const prv of activeProviders) {
      const stage3 = await tryExternalProvider(prv, messages, options, lastFailedSource);
      if (stage3.result) return stage3.result;
      if (stage3.error) {
        errors.push(stage3.error);
        lastFailedSource = prv.name;
      }
    }
  }

  throw new Error(
    errors[errors.length - 1] ||
      'Nenhuma IA de código ativa. Abra a aba "APIs IA" e clique em "Procurar Novas IAs Grátis" ou adicione uma chave de API.'
  );
}

async function* iterateUpstreamAsOpenAiChunks(
  upstream: UpstreamCallResult
): AsyncGenerator<Record<string, unknown>> {
  const reader = upstream.stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      let outer: Record<string, unknown>;
      try {
        outer = JSON.parse(jsonStr) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (upstream.kind === 'qoder') {
        const status = outer.statusCodeValue;
        if (status !== undefined && status !== null && status !== 200 && status !== '200') {
          const detail = typeof outer.body === 'string' ? outer.body : JSON.stringify(outer);
          throw new Error(`Upstream status ${status}: ${detail.slice(0, 220)}`);
        }
        const body = outer.body;
        if (typeof body !== 'string') continue;
        if (body === '[DONE]') return;
        try {
          const inner = JSON.parse(body) as Record<string, unknown>;
          yield inner;
        } catch {
          // ignore non-json inner body
        }
      } else if (upstream.kind === 'anthropic-provider') {
        if (outer.type === 'message_start') {
          const msgObj = outer.message as Record<string, unknown> | undefined;
          const msgUsage = msgObj?.usage as Record<string, unknown> | undefined;
          if (msgUsage && typeof msgUsage.input_tokens === 'number') {
            yield {
              id: `chatcmpl-${generateRequestId().slice(0, 20)}`,
              object: 'chat.completion.chunk',
              choices: [],
              usage: { prompt_tokens: msgUsage.input_tokens, completion_tokens: 0 },
            };
          }
        } else if (outer.type === 'message_delta') {
          const msgUsage = outer.usage as Record<string, unknown> | undefined;
          if (msgUsage && typeof msgUsage.output_tokens === 'number') {
            yield {
              id: `chatcmpl-${generateRequestId().slice(0, 20)}`,
              object: 'chat.completion.chunk',
              choices: [],
              usage: { prompt_tokens: 0, completion_tokens: msgUsage.output_tokens },
            };
          }
        } else if (outer.type === 'content_block_delta') {
          const delta = outer.delta as Record<string, unknown> | undefined;
          if (delta?.type === 'text_delta' && delta.text) {
            yield {
              id: `chatcmpl-${generateRequestId().slice(0, 20)}`,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { content: String(delta.text) } }],
            };
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            yield {
              id: `chatcmpl-${generateRequestId().slice(0, 20)}`,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { reasoning_content: String(delta.thinking) } }],
            };
          }
        }
      } else {
        // Standard OpenAI-compatible chunk
        yield outer;
      }
    }
  }
}

export async function handleChatCompletions(
  req: Request,
  res: Response,
  protocol: 'openai-chat' | 'android-chat' = 'openai-chat'
): Promise<void> {
  const startedAt = Date.now();
  const body = (req.body || {}) as Record<string, unknown>;
  const model = String(body.model || 'auto-failover');
  const messages = Array.isArray(body.messages) ? (body.messages as OpenAiMessage[]) : [];
  const wantStream = Boolean(body.stream);
  const realmHeader = (req.header('x-realm') || req.query.realm || '') as RealmId | '';
  const realmHint = realmHeader === 'cn' || realmHeader === 'intl' ? realmHeader : undefined;

  if (messages.length === 0) {
    res.status(400).json({ error: { message: 'Campo "messages" é obrigatório.', type: 'invalid_request_error' } });
    return;
  }

  let upstream: UpstreamCallResult;
  try {
    upstream = await callUpstreamWithFailover(model, messages, realmHint, {
      maxTokens: Number(body.max_tokens || body.max_completion_tokens || 32768),
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      thinkingEffort: body.reasoning_effort ? String(body.reasoning_effort) : undefined,
      sessionKey: req.header('x-session-id') || undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erro no gateway Multi-IA';
    recordRequestLog({
      protocol,
      model,
      realm: realmHint || getSettings().defaultRealm,
      status: 503,
      latencyMs: Date.now() - startedAt,
      stream: wantStream,
      error: msg,
    });
    res.status(503).json({ error: { message: msg, type: 'gateway_unavailable' } });
    return;
  }

  res.setHeader('X-Qoder-Realm', upstream.realm);
  res.setHeader('X-Qoder-Account', upstream.accountNickname);
  res.setHeader('X-Qoder-Provider', upstream.providerName);
  if (upstream.failoverFrom) {
    res.setHeader('X-Qoder-Failover-From', upstream.failoverFrom);
  }

  const promptChars = estimatePromptChars(messages);

  if (wantStream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
      let outputChars = 0;
      let reportedPromptTokens = 0;
      let reportedCompletionTokens = 0;

      for await (const chunk of iterateUpstreamAsOpenAiChunks(upstream)) {
        const extracted = extractChunkTextAndUsage(chunk);
        outputChars += extracted.text.length;
        if (extracted.promptTokens) reportedPromptTokens = Math.max(reportedPromptTokens, extracted.promptTokens);
        if (extracted.completionTokens) {
          reportedCompletionTokens = Math.max(reportedCompletionTokens, extracted.completionTokens);
        }
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();

      const latencyMs = Date.now() - startedAt;
      const promptTokens = reportedPromptTokens || Math.max(1, Math.ceil(promptChars / 4));
      const completionTokens = reportedCompletionTokens || Math.max(1, Math.ceil(outputChars / 4));

      if (upstream.externalProvider) {
        addProviderUsage(upstream.externalProvider.id, {
          promptTokens,
          completionTokens,
          latencyMs,
        });
      }

      recordRequestLog({
        protocol,
        model: upstream.displayName,
        realm: upstream.realm,
        provider: upstream.providerName,
        failoverFrom: upstream.failoverFrom,
        accountUid: upstream.accountUid,
        accountNickname: upstream.accountNickname,
        status: 200,
        latencyMs,
        stream: true,
        promptTokens,
        completionTokens,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro de streaming';
      if (upstream.externalProvider) {
        markProviderCooldown(upstream.externalProvider.id, 30, msg);
      }
      recordRequestLog({
        protocol,
        model: upstream.displayName,
        realm: upstream.realm,
        provider: upstream.providerName,
        failoverFrom: upstream.failoverFrom,
        accountUid: upstream.accountUid,
        accountNickname: upstream.accountNickname,
        status: 502,
        latencyMs: Date.now() - startedAt,
        stream: true,
        error: msg,
      });
      res.write(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return;
  }

  // Non-streaming aggregation
  try {
    let fullContent = '';
    let fullReasoning = '';
    let respId = `chatcmpl-${generateRequestId().slice(0, 24)}`;
    let reportedPromptTokens = 0;
    let reportedCompletionTokens = 0;

    for await (const chunk of iterateUpstreamAsOpenAiChunks(upstream)) {
      if (chunk.id) respId = String(chunk.id);
      const extracted = extractChunkTextAndUsage(chunk);
      if (extracted.promptTokens) reportedPromptTokens = Math.max(reportedPromptTokens, extracted.promptTokens);
      if (extracted.completionTokens) {
        reportedCompletionTokens = Math.max(reportedCompletionTokens, extracted.completionTokens);
      }
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      for (const ch of choices) {
        const delta = (ch as Record<string, unknown>)?.delta as Record<string, unknown> | undefined;
        if (delta?.content) fullContent += String(delta.content);
        if (delta?.reasoning_content) fullReasoning += String(delta.reasoning_content);
      }
    }

    const latencyMs = Date.now() - startedAt;
    const promptTokens = reportedPromptTokens || Math.max(1, Math.ceil(promptChars / 4));
    const completionTokens =
      reportedCompletionTokens || Math.max(1, Math.ceil((fullContent.length + fullReasoning.length) / 4));

    if (upstream.externalProvider) {
      addProviderUsage(upstream.externalProvider.id, {
        promptTokens,
        completionTokens,
        latencyMs,
      });
    }

    recordRequestLog({
      protocol,
      model: upstream.displayName,
      realm: upstream.realm,
      provider: upstream.providerName,
      failoverFrom: upstream.failoverFrom,
      accountUid: upstream.accountUid,
      accountNickname: upstream.accountNickname,
      status: 200,
      latencyMs,
      stream: false,
      promptTokens,
      completionTokens,
    });

    res.json({
      id: respId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: upstream.displayName,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: fullContent,
            ...(fullReasoning ? { reasoning_content: fullReasoning } : {}),
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      qoder_meta: {
        provider: upstream.providerName,
        failover_from: upstream.failoverFrom,
        realm: upstream.realm,
        account: upstream.accountNickname,
        latency_ms: latencyMs,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erro ao agregar resposta';
    if (upstream.externalProvider) {
      markProviderCooldown(upstream.externalProvider.id, 30, msg);
    }
    recordRequestLog({
      protocol,
      model: upstream.displayName,
      realm: upstream.realm,
      provider: upstream.providerName,
      failoverFrom: upstream.failoverFrom,
      accountUid: upstream.accountUid,
      accountNickname: upstream.accountNickname,
      status: 502,
      latencyMs: Date.now() - startedAt,
      stream: false,
      error: msg,
    });
    res.status(502).json({ error: { message: msg, type: 'upstream_error' } });
  }
}

export async function handleResponsesApi(req: Request, res: Response): Promise<void> {
  const body = (req.body || {}) as Record<string, unknown>;
  const input = body.input;
  const messages: OpenAiMessage[] = [];
  if (body.instructions) {
    messages.push({ role: 'system', content: String(body.instructions) });
  }
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
      } else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        messages.push({
          role: String(obj.role || 'user'),
          content: (obj.content as OpenAiMessage['content']) || String(obj.text || ''),
        });
      }
    }
  }

  const startedAt = Date.now();
  const model = String(body.model || 'auto-failover');
  const promptChars = estimatePromptChars(messages);

  try {
    const upstream = await callUpstreamWithFailover(model, messages, undefined, {
      maxTokens: Number(body.max_output_tokens || 32768),
    });

    let fullContent = '';
    let reportedPromptTokens = 0;
    let reportedCompletionTokens = 0;
    for await (const chunk of iterateUpstreamAsOpenAiChunks(upstream)) {
      const extracted = extractChunkTextAndUsage(chunk);
      if (extracted.promptTokens) reportedPromptTokens = Math.max(reportedPromptTokens, extracted.promptTokens);
      if (extracted.completionTokens) {
        reportedCompletionTokens = Math.max(reportedCompletionTokens, extracted.completionTokens);
      }
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      for (const ch of choices) {
        const delta = (ch as Record<string, unknown>)?.delta as Record<string, unknown> | undefined;
        if (delta?.content) fullContent += String(delta.content);
      }
    }

    const latencyMs = Date.now() - startedAt;
    const promptTokens = reportedPromptTokens || Math.max(1, Math.ceil(promptChars / 4));
    const completionTokens = reportedCompletionTokens || Math.max(1, Math.ceil(fullContent.length / 4));

    if (upstream.externalProvider) {
      addProviderUsage(upstream.externalProvider.id, { promptTokens, completionTokens, latencyMs });
    }

    recordRequestLog({
      protocol: 'openai-responses',
      model: upstream.displayName,
      realm: upstream.realm,
      provider: upstream.providerName,
      failoverFrom: upstream.failoverFrom,
      accountUid: upstream.accountUid,
      accountNickname: upstream.accountNickname,
      status: 200,
      latencyMs,
      stream: false,
      promptTokens,
      completionTokens,
    });

    res.json({
      id: `resp_${generateRequestId().slice(0, 20)}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model: upstream.displayName,
      output: [
        {
          type: 'message',
          id: `msg_${generateRequestId().slice(0, 16)}`,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: fullContent, annotations: [] }],
        },
      ],
      usage: {
        input_tokens: promptTokens,
        output_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erro na Responses API';
    recordRequestLog({
      protocol: 'openai-responses',
      model,
      realm: getSettings().defaultRealm,
      status: 503,
      latencyMs: Date.now() - startedAt,
      stream: false,
      error: msg,
    });
    res.status(503).json({ error: { message: msg } });
  }
}

export async function handleAnthropicMessages(req: Request, res: Response): Promise<void> {
  const body = (req.body || {}) as Record<string, unknown>;
  const model = String(body.model || 'auto-failover');
  const rawMessages = Array.isArray(body.messages) ? (body.messages as OpenAiMessage[]) : [];
  const messages: OpenAiMessage[] = [];
  if (body.system) {
    messages.push({ role: 'system', content: String(body.system) });
  }
  for (const m of rawMessages) {
    messages.push({ role: m.role, content: extractTextContent(m.content) });
  }

  const startedAt = Date.now();
  const wantStream = Boolean(body.stream);
  const promptChars = estimatePromptChars(messages);

  try {
    const upstream = await callUpstreamWithFailover(model, messages, undefined, {
      maxTokens: Number(body.max_tokens || 16384),
    });

    const msgId = `msg_${generateRequestId().slice(0, 20)}`;
    let reportedPromptTokens = 0;
    let reportedCompletionTokens = 0;
    let outputChars = 0;

    if (wantStream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.flushHeaders();

      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            model: upstream.displayName,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })}\n\n`
      );
      res.write(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })}\n\n`
      );

      for await (const chunk of iterateUpstreamAsOpenAiChunks(upstream)) {
        const extracted = extractChunkTextAndUsage(chunk);
        if (extracted.promptTokens) reportedPromptTokens = Math.max(reportedPromptTokens, extracted.promptTokens);
        if (extracted.completionTokens) {
          reportedCompletionTokens = Math.max(reportedCompletionTokens, extracted.completionTokens);
        }
        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        for (const ch of choices) {
          const delta = (ch as Record<string, unknown>)?.delta as Record<string, unknown> | undefined;
          if (delta?.content) {
            const txt = String(delta.content);
            outputChars += txt.length;
            res.write(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: txt },
              })}\n\n`
            );
          }
        }
      }

      const finalOutputTokens = reportedCompletionTokens || Math.max(1, Math.ceil(outputChars / 4));
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: finalOutputTokens },
        })}\n\n`
      );
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();
    } else {
      let fullContent = '';
      for await (const chunk of iterateUpstreamAsOpenAiChunks(upstream)) {
        const extracted = extractChunkTextAndUsage(chunk);
        if (extracted.promptTokens) reportedPromptTokens = Math.max(reportedPromptTokens, extracted.promptTokens);
        if (extracted.completionTokens) {
          reportedCompletionTokens = Math.max(reportedCompletionTokens, extracted.completionTokens);
        }
        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        for (const ch of choices) {
          const delta = (ch as Record<string, unknown>)?.delta as Record<string, unknown> | undefined;
          if (delta?.content) fullContent += String(delta.content);
        }
      }
      outputChars = fullContent.length;

      const finalPromptTokens = reportedPromptTokens || Math.max(1, Math.ceil(promptChars / 4));
      const finalOutputTokens = reportedCompletionTokens || Math.max(1, Math.ceil(outputChars / 4));

      res.json({
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: upstream.displayName,
        content: [{ type: 'text', text: fullContent }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: finalPromptTokens, output_tokens: finalOutputTokens },
      });
    }

    const latencyMs = Date.now() - startedAt;
    const promptTokens = reportedPromptTokens || Math.max(1, Math.ceil(promptChars / 4));
    const completionTokens = reportedCompletionTokens || Math.max(1, Math.ceil(outputChars / 4));

    if (upstream.externalProvider) {
      addProviderUsage(upstream.externalProvider.id, { promptTokens, completionTokens, latencyMs });
    }

    recordRequestLog({
      protocol: 'anthropic-messages',
      model: upstream.displayName,
      realm: upstream.realm,
      provider: upstream.providerName,
      failoverFrom: upstream.failoverFrom,
      accountUid: upstream.accountUid,
      accountNickname: upstream.accountNickname,
      status: 200,
      latencyMs,
      stream: wantStream,
      promptTokens,
      completionTokens,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erro na Anthropic Messages API';
    recordRequestLog({
      protocol: 'anthropic-messages',
      model,
      realm: getSettings().defaultRealm,
      status: 503,
      latencyMs: Date.now() - startedAt,
      stream: wantStream,
      error: msg,
    });
    res.status(503).json({ type: 'error', error: { type: 'api_error', message: msg } });
  }
}
