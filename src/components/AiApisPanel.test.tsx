import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AiApisPanel,
  buildProviderPatch,
  focusKeyForm,
  getEndpointPreset,
  isProviderSaved,
  readProviderResponse,
  selectDraftRow,
} from './AiApisPanel';
import { PROVIDER_PRESETS } from '../data/providerPresets';
import type { DiscoveredAiProvider, SafeProviderSummary } from '../types/hub';

const saved: SafeProviderSummary = {
  id: 'saved-router', provider: 'openrouter', name: 'Modelo salvo',
  baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'qwen/qwen3-coder:free',
  protocol: 'openai', keyPrefix: 'sk-or-***', enabled: true, priority: 1,
  requestCount: 0, errorCount: 0, failoverCount: 0, promptTokens: 0,
  completionTokens: 0, totalLatencyMs: 0, createdAt: 1,
};
const discovered: DiscoveredAiProvider = {
  id: 'discovered-qwen', provider: 'qwen', name: 'Qwen via OpenRouter',
  baseUrl: saved.baseUrl, defaultModel: saved.defaultModel, protocol: 'openai',
  source: 'openrouter-free', requiresKey: true, canAutoAdd: false,
  alreadyConfigured: true, description: 'Modelo do catálogo',
};
function draft(localId: string, apiKey = '', provider: 'gemini' | 'openrouter' = 'gemini') {
  const preset = PROVIDER_PRESETS.find((item) => item.id === provider)!;
  return {
    localId, apiKey, provider, name: preset.name, baseUrl: preset.baseUrl,
    defaultModel: preset.defaultModel, protocol: preset.protocol, showKey: false,
  };
}

describe('AiApisPanel: endpoint e rascunhos', () => {
  test('OpenRouter usa seu registro, nunca o publisher do modelo', () => {
    for (const provider of ['qwen', 'deepseek', 'gemini', 'custom'] as const) {
      const preset = getEndpointPreset(provider, 'https://OPENROUTER.AI/api/v1/');
      expect(preset?.id).toBe('openrouter');
      expect(preset?.signupUrl).toBe('https://openrouter.ai/keys');
      expect(preset?.requiresKey).toBe(true);
    }
    expect(getEndpointPreset('qwen', 'https://openrouter.ai.evil.example/v1')?.id).toBe('qwen');
    expect(getEndpointPreset('qwen', 'https://openrouter.ai@evil.example/v1')?.id).toBe('qwen');
    expect(getEndpointPreset('qwen', 'URL incompleta')?.id).toBe('qwen');
  });

  test('seleção acrescenta campo sem apagar chave digitada', () => {
    const original = draft('original', 'segredo-digitado');
    const next = draft('descoberta', '', 'openrouter');
    const selection = selectDraftRow([original], next);
    expect(selection.rows).toEqual([original, next]);
    expect(selection.rows[0]).toBe(original);
    expect(selection.localId).toBe('descoberta');
    expect(original.apiKey).toBe('segredo-digitado');
  });

  test('substitui somente o último campo sem chave, preservando anteriores', () => {
    const original = draft('com-chave', 'segredo-digitado');
    const blank = draft('vazio');
    const next = draft('descoberta', '', 'openrouter');
    const selection = selectDraftRow([original, blank], next);
    expect(selection.rows).toEqual([original, next]);
    expect(selection.localId).toBe(next.localId);
    expect(blank.provider).toBe('gemini');
  });

  test('seleção repetida mantém chave e ID do input correto', () => {
    const original = draft('input-existente', 'segredo-digitado', 'openrouter');
    const next = { ...draft('novo', '', 'openrouter'), baseUrl: `${original.baseUrl}/` };
    const rows = [original];
    const selection = selectDraftRow(rows, next);
    expect(selection.rows).toBe(rows);
    expect(selection.localId).toBe('input-existente');
    expect(selection.rows[0].apiKey).toBe('segredo-digitado');
    expect(selectDraftRow([], next).rows).toEqual([next]);
  });

  test('configured deriva de providers salvos, inclusive após remoção', () => {
    expect(isProviderSaved([], discovered)).toBe(false); // Flag obsoleta true.
    const staleUnconfigured = { ...discovered, alreadyConfigured: false };
    expect(isProviderSaved([saved], staleUnconfigured)).toBe(true);
    expect(isProviderSaved([{ ...saved, enabled: false }], discovered)).toBe(true);
    expect(isProviderSaved([saved], { ...discovered, defaultModel: 'outro-modelo' })).toBe(false);
    expect(isProviderSaved([saved], { ...discovered, baseUrl: `${saved.baseUrl}/` })).toBe(true);
    expect(isProviderSaved([], discovered)).toBe(false);
  });
});

describe('AiApisPanel: foco após renderização', () => {
  function elements(top: number, bottom: number) {
    const events: unknown[] = [];
    const section = {
      style: { scrollMarginTop: '' },
      scrollIntoView: (options: ScrollIntoViewOptions) => events.push(['section', options]),
    };
    const input = {
      style: { scrollMarginTop: '' },
      focus: (options: FocusOptions) => events.push(['focus', options]),
      getBoundingClientRect: () => ({ top, bottom }),
      scrollIntoView: (options: ScrollIntoViewOptions) => events.push(['input', options]),
    };
    return { section, input, events };
  }
  test('compensa header alto e foca sem desfazer a rolagem da seção', () => {
    const { section, input, events } = elements(160, 204);
    focusKeyForm(section as unknown as HTMLDivElement, input as unknown as HTMLInputElement, 112, 800);
    expect(section.style.scrollMarginTop).toBe('128px');
    expect(events).toEqual([
      ['section', { behavior: 'auto', block: 'start' }],
      ['focus', { preventScroll: true }],
    ]);
  });
  test('campo distante ou coberto pelo header também entra em visão', () => {
    for (const [top, bottom] of [[950, 994], [40, 84]]) {
      const { section, input, events } = elements(top, bottom);
      focusKeyForm(section as unknown as HTMLDivElement, input as unknown as HTMLTextAreaElement, 112, 800);
      expect(input.style.scrollMarginTop).toBe('128px');
      expect(events.at(-1)).toEqual(['input', { behavior: 'auto', block: 'start' }]);
    }
  });
});

describe('AiApisPanel: respostas e PATCH', () => {
  test('exige HTTP bem-sucedido e ok explicitamente true', async () => {
    expect(await readProviderResponse(Response.json({ ok: true, count: 2 }))).toEqual({ ok: true, count: 2 });
    await expect(readProviderResponse(Response.json({ ok: true }, { status: 500 }))).rejects.toThrow('HTTP 500');
    await expect(readProviderResponse(Response.json({ ok: false, error: 'Não salvou' }))).rejects.toThrow('Não salvou');
    await expect(readProviderResponse(Response.json({ ok: false, error: { message: 'Campo inválido' } }))).rejects.toThrow('Campo inválido');
    await expect(readProviderResponse(Response.json({ message: 'Faltou confirmação' }))).rejects.toThrow('Faltou confirmação');
    await expect(readProviderResponse(Response.json({ ok: 'true' }))).rejects.toThrow();
    await expect(readProviderResponse(new Response('não é JSON', { status: 502 }))).rejects.toThrow('HTTP 502');
    await expect(readProviderResponse(new Response(null, { status: 204 }))).rejects.toThrow('HTTP 204');
  });
  test('PATCH respeita whitelist e chave vazia mantém a credencial salva', () => {
    const edit = { name: ' Nome ', baseUrl: ` ${saved.baseUrl} `, defaultModel: ' modelo ', protocol: 'openai' as const, apiKey: '  ' };
    expect(buildProviderPatch(edit)).toEqual({ name: 'Nome', baseUrl: saved.baseUrl, defaultModel: 'modelo', protocol: 'openai' });
    expect(buildProviderPatch({ ...edit, apiKey: ' nova-chave ' }).apiKey).toBe('nova-chave');
    expect(buildProviderPatch(edit)).not.toHaveProperty('provider');
    expect(buildProviderPatch(edit)).not.toHaveProperty('apiKey');
  });
});

describe('AiApisPanel: apresentação segura', () => {
  function render(providers: SafeProviderSummary[] = []) {
    let requests = 0;
    const html = renderToStaticMarkup(<AiApisPanel providers={providers}
      apiFetch={async () => { requests++; return Response.json({ ok: true }); }}
      onProvidersChanged={() => {}} />);
    expect(requests).toBe(0);
    return html;
  }
  test('formulário identificável, chave mascarada e descoberta opcional', () => {
    const html = render();
    expect(html).toContain('id="ai-api-key-form"');
    expect(html).toContain('aria-label="Adicionar chaves de APIs"');
    expect(html).toMatch(/<input[^>]*type="password"/);
    expect(html).toMatch(/<label for="api-key-[^"]+"/);
    expect(html).toMatch(/<details class="[^"]+"><summary/);
    expect(html).not.toMatch(/<details[^>]*\bopen(?:=|>| )/);
    expect(html).not.toContain('Sem Chave / 1 Clique');
    expect(html).not.toContain('APIs Prontas');
    expect(html).not.toContain('backup grátis sem chave');
    expect(html).not.toContain('LM Studio / Pollinations');
  });
  test('links oficiais navegam na mesma janela e Qoder é separado do formulário', () => {
    const html = render();
    const links = [...html.matchAll(/<a href="([^"]+)"[^>]*target="([^"]+)"/g)];
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const [, href, target] of links) {
      expect(href.startsWith('https://')).toBe(true);
      expect(target).toBe('_self');
    }
    expect(html).toContain('Registrar / obter chave (OpenAI)');
    expect(html).toContain('Mostrar opções com cota grátis');
    expect(html).not.toContain('Registrar / obter chave (Google Gemini)');
    expect(html).toContain('Qoder · assistente usado no desenvolvimento');
    expect(html).toContain('não é tratado aqui como API de inferência');
    expect(html).toContain('href="https://qoder.com"');
    expect(html.slice(html.indexOf('<form'), html.indexOf('</form>'))).not.toContain('qoder.com');
    expect(PROVIDER_PRESETS.some((preset) => String(preset.id) === 'qoder')).toBe(false);
  });
  test('API habilitada não alega conexão testada e preserva prefixo mascarado', () => {
    const html = render([saved]);
    expect(html).toContain('habilitadas (não comprova conexão)');
    expect(html).toContain('Ainda não testada');
    expect(html).not.toContain('Funcionando');
    expect(html).toContain('sk-or-***');
    expect(html).toContain('Testar APIs habilitadas');
    expect(html).toContain('em Projetos, escolha quais APIs compõem a fila');
  });
});
