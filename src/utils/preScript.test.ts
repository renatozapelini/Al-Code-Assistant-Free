import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScriptGeneratorPanel } from '../components/ScriptGeneratorPanel';
import type { SafeProviderSummary } from '../types/hub';
import { buildZipBlob } from './androidProjectZip';
import { createCodeProject } from './codeAssistant';
import {
  appendPreScriptHistory, buildPreScriptMessages, emptyPreScriptDraft, MAX_PRE_SCRIPT_OUTPUT_BYTES,
  MAX_PRE_SCRIPT_PROMPT_BYTES, normalizePreScriptResponse, persistPreScriptStorage, preScriptBytes,
  PRE_SCRIPT_DRAFT_KEY, PRE_SCRIPT_TIMEOUT_MS, requestPreScript, restorePreScriptDraft,
  restorePreScriptHistory, validatePreScriptDraft, validatePreScriptOutput, type PreScriptHistoryItem,
} from './preScript';

const completion = (content: unknown = '# Especificação\nConteúdo integral.', finish: unknown = 'stop') => ({
  model: 'modelo-real', choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
  qoder_meta: { provider: 'IA externa', provider_id: 'a', model: 'modelo-meta', latency_ms: 125 },
});
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});
const draft = () => ({ ...emptyPreScriptDraft(), projectTitle: 'Estoque', ideas: ['Scanner offline', 'Exportação CSV'],
  ideaInput: 'Sincronizar só com autorização', extraNotes: 'Não criar conta. Preservar src/App.tsx.' });
const historyItem = (n: number): PreScriptHistoryItem => ({ id: `id-${n}`, title: `Projeto ${n}`,
  platform: 'Android', targetAssistant: 'Universal', content: `Pré-script ${n}`, createdAt: Date.now() });
const memoryStorage = (initial: string | null = null) => {
  let raw = initial, writes = 0;
  return { getItem: (_key: string) => raw, setItem: (_key: string, value: string) => { raw = value; writes++; },
    get raw() { return raw; }, get writes() { return writes; } };
};

describe('pré-script: prompt, limites e revisão', () => {
  test('preserva todas as ideias, inclusive pendente, alvo e restrições sem autorizar execução', () => {
    const input = draft(), messages = buildPreScriptMessages(input);
    for (const idea of [...input.ideas, input.ideaInput, input.extraNotes, input.platform, input.targetAssistant]) expect(messages[1].content).toContain(idea);
    for (const requirement of ['NÃO execute', 'NÃO programe', 'não invente requisitos', 'lacunas', 'UI mobile',
      'A VERIFICAR', 'Checklist incremental', 'Testes / aceite', 'Handoff', 'checkpoints', 'Prompt final imperativo', 'início humano']) {
      expect(messages[0].content).toContain(requirement);
    }
    expect(buildPreScriptMessages({ ...input, detailLevel: 'enxuto' })[0].content).toContain('sem omitir');
  });
  test('20.000 bytes incluem as instruções e TODOS os campos, medidos em UTF-8', () => {
    const input = { ...emptyPreScriptDraft(), ideas: ['x'], extraNotes: 'x' };
    const baseline = buildPreScriptMessages(input).reduce((n, message) => n + preScriptBytes(message.content), 0);
    const exact = { ...input, extraNotes: 'x'.repeat(MAX_PRE_SCRIPT_PROMPT_BYTES - baseline + 1) };
    expect(buildPreScriptMessages(exact).reduce((n, message) => n + preScriptBytes(message.content), 0)).toBe(20000);
    expect(() => buildPreScriptMessages({ ...exact, ideaInput: 'mais uma ideia' })).toThrow('20.000 bytes');
    expect(() => validatePreScriptDraft({ ...input, extraNotes: 'á'.repeat(10000) })).toThrow();
  });
  test('saída até 30.000 bytes é integral e compatível com goal/blueprint do projeto', () => {
    const content = 'á'.repeat(15000);
    expect(validatePreScriptOutput(content)).toBe(content);
    expect(preScriptBytes(content)).toBe(MAX_PRE_SCRIPT_OUTPUT_BYTES);
    const project = createCodeProject({ name: 'Pré-script', goal: content, blueprint: content, providerIds: ['a'] });
    expect(project.blueprint).toBe(content);
    expect(project.status).toBe('idle');
    expect(() => validatePreScriptOutput(content + 'á')).toThrow('30.000');
    expect(() => validatePreScriptOutput(' \n\t')).toThrow();
  });
  test('rascunho e resultado revisado separado sobrevivem à navegação e edição', () => {
    const original = { ...draft(), generatedScript: 'Resultado revisado', reviewed: true,
      confirmedResult: { content: 'Resultado revisado', meta: { provider: 'IA A', model: 'real' } } };
    const edited = { ...original, generatedScript: 'Resultado editado', reviewed: false };
    const restored = restorePreScriptDraft(JSON.stringify(edited));
    expect(restored.ideas).toEqual(original.ideas);
    expect(restored.ideaInput).toBe(original.ideaInput);
    expect(restored.generatedScript).toBe('Resultado editado');
    expect(restored.confirmedResult?.content).toBe('Resultado revisado');
    expect(restored.reviewed).toBe(false);
    expect(() => validatePreScriptDraft({ ...edited, reviewed: true })).toThrow('inconsistente');
  });
});

describe('resposta completa, erros reais e metadados', () => {
  test('normaliza stop/end_turn, mantém espaços e usa provider/model reais de qoder_meta', async () => {
    const content = ' \n# Prompt completo\n ';
    const result = await normalizePreScriptResponse(json(completion(content, 'end_turn'), 200, { 'X-App-Provider': 'Nome%20do%20header' }), ['a']);
    expect(result.content).toBe(content);
    expect(result.meta).toEqual({ provider: 'IA externa', providerId: 'a', model: 'modelo-meta', latencyMs: 125 });
  });
  test('decodifica X-App-Provider sem inventar modelo e tolera percent-encoding malformado', async () => {
    const data = { choices: completion().choices };
    const response = json(data, 200, { 'X-App-Provider': encodeURIComponent('IA São Paulo'), 'X-App-Provider-Id': 'a' });
    expect((await normalizePreScriptResponse(response, ['a'])).meta).toEqual({ provider: 'IA São Paulo', providerId: 'a', model: undefined, latencyMs: undefined });
    expect((await normalizePreScriptResponse(json(data, 200, { 'X-App-Provider': 'IA%ZZ' }))).meta?.provider).toBe('IA%ZZ');
  });
  test('não aceita identidade fora da fila nem presume Qoder ou IA selecionada', async () => {
    await expect(normalizePreScriptResponse(json(completion()), ['b'])).rejects.toThrow('fila externa');
    await expect(normalizePreScriptResponse(json({ choices: completion().choices }), ['a'])).rejects.toThrow('fila externa');
  });
  test('normaliza partes textuais sem descartar partes desconhecidas', async () => {
    const data = completion([{ type: 'text', text: '# Pré-script\n' }, { type: 'output_text', text: 'Fim.' }]);
    expect((await normalizePreScriptResponse(json(data))).content).toBe('# Pré-script\nFim.');
    await expect(normalizePreScriptResponse(json(completion([{ type: 'image', text: 'oculto' }])))).rejects.toThrow('textual');
  });
  test('erro HTTP e erros 200 em error/status/type nunca são sucesso', async () => {
    for (const [data, status, message] of [
      [{ error: { message: 'Sem créditos' } }, 402, 'Sem créditos'],
      [{ ...completion(), error: { message: 'Falha upstream' } }, 200, 'Falha upstream'],
      [{ ...completion(), error: 'Cota atingida' }, 200, 'Cota atingida'],
      [{ ...completion(), status: 'error', message: 'Status de erro' }, 200, 'Status de erro'],
      [{ ...completion(), type: 'error', message: 'Evento de erro' }, 200, 'Evento de erro'],
      [{ error: {} }, 200, 'HTTP 200'],
    ] as const) await expect(normalizePreScriptResponse(json(data, status))).rejects.toThrow(message);
    await expect(normalizePreScriptResponse(new Response('Indisponível', { status: 503 }))).rejects.toThrow('HTTP 503');
  });
  test('reject length/max_tokens, falta de término e término não textual', async () => {
    for (const finish of ['length', 'max_tokens']) await expect(normalizePreScriptResponse(json(completion('parcial', finish)))).rejects.toThrow('cortada');
    for (const finish of [null, undefined, 'content_filter', 'tool_calls', ['stop']]) {
      const data = completion('parcial');
      data.choices[0].finish_reason = finish;
      await expect(normalizePreScriptResponse(json(data))).rejects.toThrow('término');
    }
  });
  test('conteúdo vazio, inválido, grande, múltiplas escolhas e ferramentas são rejeitados', async () => {
    for (const content of ['', ' \n ', null, { text: 'não é texto' }, 'á'.repeat(15001)]) await expect(normalizePreScriptResponse(json(completion(content)))).rejects.toThrow();
    for (const choices of [[], [...completion().choices, ...completion().choices]]) await expect(normalizePreScriptResponse(json({ choices }))).rejects.toThrow('único');
    const data = completion();
    await expect(normalizePreScriptResponse(json({ ...data, choices: [{ ...data.choices[0], message: { ...data.choices[0].message, tool_calls: [{}] } }] }))).rejects.toThrow('ferramentas');
  });
  test('JSON inválido ou SSE inesperado não entrega resultado parcial', async () => {
    await expect(normalizePreScriptResponse(new Response('{', { headers: { 'Content-Type': 'application/json' } }))).rejects.toThrow('inválida');
    await expect(normalizePreScriptResponse(new Response('data: {"error":"falha"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))).rejects.toThrow('stream');
  });
});

describe('pipeline externo com cancelamento', () => {
  test('envia stream:false, escopo externo e mensagens sem tools/budgets nem truncamento', async () => {
    const input = draft(), original = JSON.stringify(input);
    const result = await requestPreScript(async (path, init) => {
      expect(path).toBe('/api/app/assistant/complete');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(String(init?.body));
      expect(body.stream).toBe(false);
      expect(body.assistant_provider_ids).toEqual(['a', 'b']);
      expect(body.model).toBe('auto-failover');
      expect(body.messages).toEqual(buildPreScriptMessages(input));
      expect(body.tools).toBeUndefined();
      expect(body.max_tokens).toBeUndefined();
      return json(completion());
    }, input, ['a', 'b'], new AbortController().signal);
    expect(result.content).toBe(completion().choices[0].message.content);
    expect(JSON.stringify(input)).toBe(original);
  });
  test('seleção explícita usa provider:id', async () => {
    await requestPreScript(async (_path, init) => {
      expect(JSON.parse(String(init?.body)).model).toBe('provider:a');
      return json(completion());
    }, { ...draft(), selectedModelId: 'provider:a' }, ['a'], new AbortController().signal);
  });
  test('fila vazia/duplicada ou ideias vazias não chamam API', async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return json(completion()); };
    for (const ids of [[], ['a', 'a']]) await expect(requestPreScript(fetcher, draft(), ids, new AbortController().signal)).rejects.toThrow('Configure');
    await expect(requestPreScript(fetcher, emptyPreScriptDraft(), ['a'], new AbortController().signal)).rejects.toThrow('Informe');
    expect(calls).toBe(0);
  });
  test('cancelamento aborta fetch e não muda o último resultado revisado', async () => {
    const input = { ...draft(), generatedScript: 'Último resultado', reviewed: true,
      confirmedResult: { content: 'Último resultado', meta: null } };
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const pending = requestPreScript(async (_path, init) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal as AbortSignal;
      requestSignal.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
    }), input, ['a'], controller.signal);
    controller.abort(new Error('Cancelado pelo usuário'));
    await expect(pending).rejects.toThrow('Cancelado pelo usuário');
    expect(requestSignal?.aborted).toBe(true);
    expect(input.generatedScript).toBe('Último resultado');
    expect(input.confirmedResult.content).toBe('Último resultado');
    expect(input.reviewed).toBe(true);
  });
  test('sinal previamente cancelado não envia a requisição', async () => {
    const controller = new AbortController(); controller.abort();
    let calls = 0;
    await expect(requestPreScript(async () => { calls++; return json(completion()); }, draft(), ['a'], controller.signal)).rejects.toThrow();
    expect(calls).toBe(0);
  });
  test('timeout de 190 segundos aborta a chamada e reporta o motivo real', async () => {
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void, ms: number) => {
      expect(ms).toBe(PRE_SCRIPT_TIMEOUT_MS);
      queueMicrotask(callback);
      return 0;
    }) as unknown as typeof setTimeout;
    try {
      await expect(requestPreScript(async (_path, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }), draft(), ['a'], new AbortController().signal)).rejects.toThrow('190 segundos');
    } finally { globalThis.setTimeout = realTimeout; }
  });
});

describe('armazenamento validado sem perda/corrupt overwrite', () => {
  test('valida tipos, meta, ideias e saída ao restaurar rascunho', () => {
    for (const value of [null, [], {}, { ...draft(), ideas: [12] }, { ...draft(), detailLevel: ['completo'] },
      { ...draft(), metaInfo: { latencyMs: -1 } }, { ...draft(), generatedScript: 'x'.repeat(30001) }]) {
      expect(() => restorePreScriptDraft(JSON.stringify(value))).toThrow();
    }
    expect(restorePreScriptDraft(null)).toEqual(emptyPreScriptDraft());
  });
  test('histórico válido máximo 10, deduplicado; tipos e datas inválidos falham', () => {
    let history: PreScriptHistoryItem[] = [];
    for (let i = 0; i < 12; i++) history = appendPreScriptHistory(history, historyItem(i));
    expect(history.length).toBe(10);
    expect(history[0].id).toBe('id-11');
    history = appendPreScriptHistory(history, { ...historyItem(99), content: history[0].content });
    expect(history.length).toBe(10);
    for (const invalid of [{}, [null], [{ ...historyItem(0), content: '' }], [{ ...historyItem(0), createdAt: 'ontem' }],
      Array.from({ length: 11 }, (_, i) => historyItem(i)), [historyItem(0), historyItem(0)]]) {
      expect(() => restorePreScriptHistory(JSON.stringify(invalid))).toThrow();
    }
  });
  test('dados corrompidos jamais são substituídos por rascunho/histórico vazio', () => {
    const storage = memoryStorage('{corrompido');
    expect(() => persistPreScriptStorage(storage, 'draft', emptyPreScriptDraft(), storage.raw, restorePreScriptDraft)).toThrow();
    expect(() => persistPreScriptStorage(storage, 'history', [], storage.raw, restorePreScriptHistory)).toThrow();
    expect(storage.raw).toBe('{corrompido'); expect(storage.writes).toBe(0);
  });
  test('não sobrescreve edição de outra aba; quota não apaga o valor anterior', () => {
    const storage = memoryStorage(JSON.stringify(draft()));
    expect(() => persistPreScriptStorage(storage, 'draft', emptyPreScriptDraft(), null, restorePreScriptDraft)).toThrow('outra aba');
    const original = storage.raw;
    const fullStorage = { getItem: storage.getItem, setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(() => persistPreScriptStorage(fullStorage, 'draft', emptyPreScriptDraft(), original, restorePreScriptDraft)).toThrow('Quota');
    expect(storage.raw).toBe(original);
    const saved = persistPreScriptStorage(storage, 'draft', draft(), original, restorePreScriptDraft);
    expect(restorePreScriptDraft(saved)).toEqual(draft());
  });
});

describe('layout e exportação do painel', () => {
  test('empty state ignora contas/modelos e mostra APIs; min-w-0, três etapas e textarea', () => {
    const html = renderToStaticMarkup(React.createElement(ScriptGeneratorPanel, { models: [], providers: [], accountsCount: 99,
      apiFetch: async () => json(completion()), onNavigate: () => {}, onSendToChat: () => {}, onSendToProject: () => {}, onScriptCompleted: () => {} }));
    for (const copy of ['Pré-script: ideias → prompt detalhado', '1. Ideias', '2. Detalhamento por IA', '3. Projeto com fila',
      'Configurar APIs', 'min-w-0', 'pre-script-result', 'Exportar pré-script (ZIP)']) expect(html).toContain(copy);
    for (const falsePromise of ['Pollinations', '0x Grátis', 'Todas IAs Grátis', 'pool gratuito']) expect(html).not.toContain(falsePromise);
    expect(html).toContain('disabled=""');
  });
  test('opções usam apenas APIs habilitadas, na ordem de prioridade', () => {
    const provider = (id: string, enabled: boolean, priority: number): SafeProviderSummary => ({ id, enabled, priority,
      name: `IA ${id}`, defaultModel: `model-${id}` } as SafeProviderSummary);
    const html = renderToStaticMarkup(React.createElement(ScriptGeneratorPanel, { models: [], providers: [provider('b', true, 2), provider('off', false, 0), provider('a', true, 1)], accountsCount: 0,
      apiFetch: async () => json(completion()), onNavigate: () => {}, onSendToChat: () => {}, onSendToProject: () => {}, onScriptCompleted: () => {} }));
    expect(html).toContain('provider:a'); expect(html).toContain('provider:b'); expect(html).not.toContain('provider:off');
    expect(html.indexOf('provider:a')).toBeLessThan(html.indexOf('provider:b'));
    expect(html).not.toContain('Configure APIs para');
  });
  test('ZIP inclui pre-script.md e seu texto UTF-8 integral, não exporta MD direto', async () => {
    const content = '# Pré-script\nTodas as ideias sem corte.';
    const blob = buildZipBlob([{ path: 'pre-script.md', content }]);
    const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const pathLength = view.getUint16(26, true), contentLength = view.getUint32(18, true);
    expect(new TextDecoder().decode(bytes.slice(30, 30 + pathLength))).toBe('pre-script.md');
    expect(new TextDecoder().decode(bytes.slice(30 + pathLength, 30 + pathLength + contentLength))).toBe(content);
  });
  test('revisão restaurada libera o handoff, edição/restauração sem revisão mantém bloqueado', () => {
    const original = globalThis.localStorage;
    const props = { models: [], providers: [], accountsCount: 0, apiFetch: async () => json(completion()),
      onNavigate: () => {}, onSendToChat: () => {}, onSendToProject: () => {}, onScriptCompleted: () => {} };
    try {
      for (const reviewed of [true, false]) {
        const savedDraft = { ...draft(), generatedScript: 'Prompt inteiro', reviewed,
          confirmedResult: { content: 'Prompt inteiro', meta: null } };
        globalThis.localStorage = { getItem: (key: string) => key === PRE_SCRIPT_DRAFT_KEY ? JSON.stringify(savedDraft) : null } as Storage;
        const html = renderToStaticMarkup(React.createElement(ScriptGeneratorPanel, props));
        const projectButton = html.match(/<button[^>]*>[^<]*<svg[^]*?Criar projeto com este pré-script<\/button>/)?.[0];
        // Inspect only the last primary button, not preceding form controls.
        const beforeText = html.slice(0, html.indexOf('Criar projeto com este pré-script'));
        const tag = beforeText.slice(beforeText.lastIndexOf('<button'), beforeText.lastIndexOf('<button') + 300);
        expect(tag.includes('disabled=""')).toBe(!reviewed);
        expect(projectButton).toBeDefined();
      }
    } finally { globalThis.localStorage = original; }
  });
});
