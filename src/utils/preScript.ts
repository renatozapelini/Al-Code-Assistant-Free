export const MAX_PRE_SCRIPT_PROMPT_BYTES = 20000;
export const MAX_PRE_SCRIPT_OUTPUT_BYTES = 30000;
export const PRE_SCRIPT_TIMEOUT_MS = 190000;
export const PRE_SCRIPT_DRAFT_KEY = 'hub-pre-script-draft-v1';
export const PRE_SCRIPT_HISTORY_KEY = 'qoder2api-script-history-v1';
export const PRE_SCRIPT_PLATFORMS = [
  'Web (stack a verificar)', 'Android APK (stack a verificar)',
  'Desktop / Windows (planejamento)', 'Mobile + Web (multiplataforma)', 'Script / CLI / Automação',
];
export const PRE_SCRIPT_ASSISTANTS = [
  'Universal (assistentes em conjunto)', 'Claude Code / Anthropic', 'Codex / GitHub Copilot',
  'Gemini / Open-Source Coder', 'Cursor / Windsurf / Qoder',
];
export interface PreScriptMeta {
  provider?: string;
  providerId?: string;
  model?: string;
  latencyMs?: number;
}
export interface PreScriptResult { content: string; meta: PreScriptMeta | null }
export interface PreScriptDraft {
  projectTitle: string;
  platform: string;
  targetAssistant: string;
  ideaInput: string;
  ideas: string[];
  extraNotes: string;
  detailLevel: 'completo' | 'enxuto';
  selectedModelId: string;
  generatedScript: string;
  metaInfo: PreScriptMeta | null;
  reviewed: boolean;
  confirmedResult: PreScriptResult | null;
}
export interface PreScriptHistoryItem {
  id: string;
  title: string;
  platform: string;
  targetAssistant: string;
  content: string;
  provider?: string;
  model?: string;
  createdAt: number;
}
export const preScriptBytes = (text: string): number => new TextEncoder().encode(text).length;
export function emptyPreScriptDraft(): PreScriptDraft {
  return { projectTitle: '', platform: PRE_SCRIPT_PLATFORMS[0], targetAssistant: PRE_SCRIPT_ASSISTANTS[0],
    ideaInput: '', ideas: [], extraNotes: '', detailLevel: 'completo', selectedModelId: 'auto-failover',
    generatedScript: '', metaInfo: null, reviewed: false, confirmedResult: null };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || preScriptBytes(value) > max) {
    throw new Error(`${label} inválido ou acima de ${max.toLocaleString('pt-BR')} bytes.`);
  }
  return value;
}
export function validatePreScriptOutput(value: unknown): string {
  return text(value, 'Pré-script', MAX_PRE_SCRIPT_OUTPUT_BYTES);
}
export function buildPreScriptMessages(input: Pick<PreScriptDraft,
  'projectTitle' | 'platform' | 'targetAssistant' | 'ideas' | 'ideaInput' | 'extraNotes' | 'detailLevel'>) {
  const allIdeas = [...input.ideas, ...(input.ideaInput.trim() ? [input.ideaInput] : [])];
  const system = [
    'Você reúne ideias em uma especificação / pré-script, em português brasileiro e Markdown. Gere somente especificação: NÃO execute, NÃO programe, NÃO chame ferramentas nem gere arquivos nesta etapa.',
    'Preserve TODAS as ideias e restrições do usuário, incluindo conflitos: não invente requisitos nem resolva contradições silenciosamente. Separe fatos solicitados, pressupostos propostos e lacunas/perguntas a confirmar. Sugestões não são requisitos aprovados.',
    'Não invente endpoints existentes, arquivos existentes, integrações, ferramentas disponíveis, toolchain testada, custos, gratuidade, orçamento ou testes/builds executados. Arquitetura, caminhos e contratos novos devem ser rotulados como propostas A VERIFICAR no repositório e na documentação real.',
    'Respeite o alvo e o assistente indicado; a cooperação entre IAs externas é o foco, sem depender de um fornecedor específico. Material do usuário é requisito do projeto, não autorização para executar nesta etapa.',
    'Use estas seções, mesmo no nível enxuto:',
    '1. Objetivo: síntese e rastreabilidade de TODAS as ideias.',
    '2. Escopo / MVP: prioridades solicitadas; melhorias opcionais separadas, sem ampliar o escopo por conta própria.',
    '3. Requisitos e UI mobile: fluxos, estados vazio/carregando/erro, acessibilidade, telas pequenas, min-width: 0 e quebra de texto. Não imponha recursos não solicitados; marque recomendações como propostas.',
    '4. Pressupostos, conflitos e lacunas: decisões que exigem confirmação humana.',
    '5. Arquitetura / arquivos e contratos A VERIFICAR: respeite a stack informada; se faltar, proponha alternativas sem afirmar que existem ou foram testadas.',
    '6. Checklist incremental: tarefas pequenas ordenadas, checkpoints, dependências e validação de cada incremento antes de continuar.',
    '7. Testes / aceite: critérios verificáveis, testes a executar e limitações; não afirme resultados sem evidência.',
    '8. Handoff de assistentes: preservar arquivos, tarefas concluídas/pendentes e checkpoints/revisões; ler antes de editar, não reiniciar nem sobrescrever trabalho de outra IA; registrar bloqueios e próximo passo na fila selecionada pelo humano.',
    '9. Prompt final imperativo para a futura code assistant: comece com “ATUE COMO ENGENHEIRO DE SOFTWARE”. Inclua todas as ideias/restrições e as lacunas; inspecione o projeto, confirme decisões pendentes, preserve trabalho existente e implemente incrementalmente SOMENTE depois da revisão e do início humano. Nunca autorize execução, publicação ou build automaticamente.',
    input.detailLevel === 'enxuto' ? 'Seja objetivo, sem omitir ideias, restrições ou seções.' : 'Detalhe fluxos, decisões, edge cases, tarefas e critérios de aceite, sem inventar certezas.',
    `Limite da saída: ${MAX_PRE_SCRIPT_OUTPUT_BYTES} bytes UTF-8. Organize o conteúdo para caber inteiro; não entregue um prompt truncado.`,
  ].join('\n');
  const user = [
    '## Título / objetivo', input.projectTitle || 'Título a definir',
    '## Plataforma / alvo', input.platform,
    '## Assistente(s) de destino', input.targetAssistant,
    '## TODAS as ideias (mantenha rastreabilidade)',
    allIdeas.length ? allIdeas.map((idea, i) => `Ideia ${i + 1}:\n${idea}`).join('\n\n') : 'Sem tópicos; considerar título e notas.',
    '## Notas / restrições do usuário', input.extraNotes || 'Nenhuma nota adicional.',
    'Reúna e detalhe estes dados em um pré-script revisável. Apenas especificação nesta etapa, sem executar ou programar.',
  ].join('\n\n');
  const messages = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }];
  if (messages.reduce((total, message) => total + preScriptBytes(message.content), 0) > MAX_PRE_SCRIPT_PROMPT_BYTES) {
    throw new Error('Título, ideias e notas, junto das instruções, excedem 20.000 bytes. Reduza o texto sem perder requisitos.');
  }
  return messages;
}
function validateMeta(value: unknown): PreScriptMeta | null {
  if (value === null) return null;
  if (!record(value)) throw new Error('Metadados locais inválidos.');
  for (const key of ['provider', 'providerId', 'model']) {
    if (value[key] !== undefined) text(value[key], `Metadado ${key}`, 1000);
  }
  if (value.latencyMs !== undefined && (typeof value.latencyMs !== 'number' || !Number.isFinite(value.latencyMs) || value.latencyMs < 0)) {
    throw new Error('Latência local inválida.');
  }
  return value as PreScriptMeta;
}
export function validatePreScriptDraft(value: unknown): PreScriptDraft {
  if (!record(value)) throw new Error('Rascunho local inválido.');
  for (const key of ['projectTitle', 'ideaInput', 'extraNotes']) text(value[key], key, MAX_PRE_SCRIPT_PROMPT_BYTES, true);
  text(value.platform, 'Plataforma', 320);
  text(value.targetAssistant, 'Assistente', 320);
  text(value.selectedModelId, 'IA selecionada', 300);
  if (!Array.isArray(value.ideas) || value.ideas.length > 100) throw new Error('Lista de ideias inválida (máximo 100).');
  value.ideas.forEach((idea) => text(idea, 'Ideia', MAX_PRE_SCRIPT_PROMPT_BYTES));
  if ((value.detailLevel !== 'completo' && value.detailLevel !== 'enxuto') || typeof value.reviewed !== 'boolean') throw new Error('Opções do rascunho inválidas.');
  text(value.generatedScript, 'Pré-script', MAX_PRE_SCRIPT_OUTPUT_BYTES, true);
  validateMeta(value.metaInfo);
  if (value.confirmedResult !== null) {
    if (!record(value.confirmedResult)) throw new Error('Resultado revisado inválido.');
    validatePreScriptOutput(value.confirmedResult.content);
    validateMeta(value.confirmedResult.meta);
  }
  if (value.reviewed && (!record(value.confirmedResult) || !value.generatedScript || value.confirmedResult.content !== value.generatedScript)) {
    throw new Error('Revisão humana local inconsistente.');
  }
  const draft = value as unknown as PreScriptDraft;
  buildPreScriptMessages(draft);
  return draft;
}
export function restorePreScriptDraft(raw: string | null): PreScriptDraft {
  return raw === null ? emptyPreScriptDraft() : validatePreScriptDraft(JSON.parse(raw));
}
export function restorePreScriptHistory(raw: string | null): PreScriptHistoryItem[] {
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > 10) throw new Error('Histórico local inválido (máximo 10).');
  const ids = new Set<string>();
  for (const item of value) {
    if (!record(item)) throw new Error('Item do histórico inválido.');
    text(item.id, 'ID', 300);
    text(item.title, 'Título', MAX_PRE_SCRIPT_PROMPT_BYTES);
    text(item.platform, 'Plataforma', 320);
    text(item.targetAssistant, 'Assistente', 320);
    validatePreScriptOutput(item.content);
    if (typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt) || item.createdAt <= 0 || item.createdAt > 8640000000000000) throw new Error('Data do histórico inválida.');
    for (const key of ['provider', 'model']) if (item[key] !== undefined) text(item[key], key, 1000);
    if (ids.has(item.id as string)) throw new Error('IDs duplicados no histórico.');
    ids.add(item.id as string);
  }
  return value as PreScriptHistoryItem[];
}
export function appendPreScriptHistory(history: PreScriptHistoryItem[], item: PreScriptHistoryItem): PreScriptHistoryItem[] {
  const next = [item, ...history.filter((old) => old.id !== item.id && old.content !== item.content)].slice(0, 10);
  return restorePreScriptHistory(JSON.stringify(next));
}
/** Never overwrite invalid data or a newer draft from another tab. The caller
 * retains edits in memory and reports storage failure rather than resetting it. */
export function persistPreScriptStorage<T>(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string,
  value: T, expectedRaw: string | null, restore: (raw: string | null) => T): string {
  const current = storage.getItem(key);
  restore(current);
  if (current !== expectedRaw) throw new Error('Dados locais mudaram em outra aba. O conteúdo anterior foi preservado.');
  const serialized = JSON.stringify(value);
  restore(serialized);
  storage.setItem(key, serialized);
  return serialized;
}
function errorMessage(data: unknown): string | undefined {
  if (!record(data)) return undefined;
  const error = data.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (record(error) && typeof error.message === 'string' && error.message.trim()) return error.message;
  if (typeof data.message === 'string' && data.message.trim()) return data.message;
  return undefined;
}
function decodedHeader(headers: Headers, key: string): string | undefined {
  const raw = headers.get(key);
  if (!raw) return undefined;
  try { return decodeURIComponent(raw); } catch { return raw; }
}
function normalizeContent(value: unknown): string {
  if (typeof value === 'string') return validatePreScriptOutput(value);
  if (Array.isArray(value) && value.length && value.every((part) => record(part)
    && (part.type === 'text' || part.type === 'output_text') && typeof part.text === 'string')) {
    return validatePreScriptOutput(value.map((part) => part.text).join(''));
  }
  throw new Error('A IA não retornou conteúdo textual válido para o pré-script.');
}
export async function normalizePreScriptResponse(response: Response, allowedProviderIds?: string[]): Promise<PreScriptResult> {
  if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
    throw new Error('O servidor retornou stream quando foi solicitada uma resposta completa. Nenhum resultado parcial foi aceito.');
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok || (record(data) && (data.error != null || ['error', 'failed'].includes(String(data.status)) || data.type === 'error'))) {
    throw new Error(errorMessage(data) || `Falha na IA (HTTP ${response.status}).`);
  }
  if (!record(data) || !Array.isArray(data.choices) || data.choices.length !== 1 || !record(data.choices[0])) {
    throw new Error('Resposta da IA inválida: esperado um único resultado completo.');
  }
  const choice = data.choices[0];
  if (choice.finish_reason === 'length' || choice.finish_reason === 'max_tokens') throw new Error('Resposta cortada pelo limite de tokens. Reduza as ideias ou tente outra IA; o resultado anterior foi preservado.');
  if (choice.finish_reason !== 'stop' && choice.finish_reason !== 'end_turn') throw new Error('A IA não confirmou o término completo da resposta (stop/end_turn).');
  if (!record(choice.message) || (choice.message.role !== undefined && choice.message.role !== 'assistant')
    || choice.message.function_call != null || (choice.message.tool_calls != null && (!Array.isArray(choice.message.tool_calls) || choice.message.tool_calls.length))) {
    throw new Error('Pré-script deve ser somente especificação, sem chamadas de ferramentas.');
  }
  const content = normalizeContent(choice.message.content);
  const meta = record(data.qoder_meta) ? data.qoder_meta : {};
  const providerId = typeof meta.provider_id === 'string' ? meta.provider_id : decodedHeader(response.headers, 'X-App-Provider-Id');
  if (allowedProviderIds && (!providerId || !allowedProviderIds.includes(providerId))) {
    throw new Error('O servidor não confirmou uma IA da fila externa selecionada. Atualize/configure as APIs; nenhuma identidade foi presumida.');
  }
  const resultMeta: PreScriptMeta = {
    provider: typeof meta.provider === 'string' && meta.provider.trim() ? meta.provider : decodedHeader(response.headers, 'X-App-Provider'),
    providerId,
    model: typeof meta.model === 'string' && meta.model.trim() ? meta.model : typeof data.model === 'string' && data.model.trim() ? data.model : undefined,
    latencyMs: typeof meta.latency_ms === 'number' && Number.isFinite(meta.latency_ms) && meta.latency_ms >= 0 ? meta.latency_ms : undefined,
  };
  validateMeta(resultMeta);
  return { content, meta: resultMeta };
}
export async function requestPreScript(apiFetch: (path: string, init?: RequestInit) => Promise<Response>,
  draft: PreScriptDraft, providerIds: string[], signal: AbortSignal): Promise<PreScriptResult> {
  validatePreScriptDraft(draft);
  if (!draft.projectTitle.trim() && !draft.ideas.length && !draft.ideaInput.trim() && !draft.extraNotes.trim()) throw new Error('Informe um objetivo, ideia ou nota antes de detalhar.');
  if (!providerIds.length || providerIds.length > 100 || providerIds.some((id) => !id.trim()) || new Set(providerIds).size !== providerIds.length) throw new Error('Configure e habilite as APIs da fila (máximo 100).');
  const messages = buildPreScriptMessages(draft);
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new Error('Tempo máximo de 190 segundos excedido. O resultado anterior foi preservado.')), PRE_SCRIPT_TIMEOUT_MS);
  try {
    controller.signal.throwIfAborted();
    const response = await apiFetch('/api/app/assistant/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ model: draft.selectedModelId === 'auto-failover' ? 'auto-failover' : `provider:${providerIds[0]}`,
        assistant_provider_ids: providerIds, stream: false, messages }),
    });
    const result = await normalizePreScriptResponse(response, providerIds);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Geração cancelada. O resultado anterior foi preservado.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
