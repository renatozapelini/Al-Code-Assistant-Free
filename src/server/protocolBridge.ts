/** Stateless function-tool bridge, not full SDK compatibility. Hosted/server tools,
 * audio/documents, encrypted reasoning and stateful Responses continuations are unsupported.
 * Signed Anthropic thinking stays in content blocks; unsigned chat reasoning cannot be replayed.
 * Tool errors use content: [{type:'tool_result', tool_use_id, content, is_error}] so IDs/errors survive.
 */
type Obj = Record<string, any>;
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export interface BridgeMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | null | Obj[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
}
export interface BridgeOptions {
  maxTokens?: number;
  temperature?: number;
  tools?: Obj[];
  toolChoice?: unknown;
  parallelToolCalls?: boolean;
  responseFormat?: unknown;
  thinkingEffort?: string;
  sessionKey?: string;
}
export interface ChatCompletion {
  id: string;
  model?: string;
  created?: number;
  choices: { index?: number; message: BridgeMessage; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: Obj; completion_tokens_details?: Obj };
}
function fail(message: string): never { throw new Error(`Protocol bridge: ${message}`); }
function object(value: unknown, label: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Obj;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  return value;
}
function identifier(value: unknown, label: string): string {
  const result = string(value, label);
  if (!result.trim()) fail(`${label} must not be empty`);
  return result;
}
function list(value: unknown, label: string): any[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}
function parameters(value: unknown): Obj {
  const raw = string(value, 'function arguments');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail('function arguments must be valid JSON'); }
  return object(parsed, 'function arguments JSON');
}
function call(value: unknown): ToolCall {
  const c = object(value, 'tool call'), f = object(c.function, 'tool call function');
  if (c.type !== 'function') fail('only function tool calls are supported; hosted/server tools are unsupported');
  parameters(f.arguments);
  return { id: identifier(c.id, 'tool call id'), type: 'function', function: {
    name: identifier(f.name, 'function name'), arguments: f.arguments,
  } };
}
function tools(value: unknown, flat = false): Obj[] {
  return list(value, 'tools').map((value) => {
    const t = object(value, 'tool');
    if (t.type !== 'function') fail('only function tools are supported; hosted/server tools are unsupported');
    const f = flat && !t.function ? t : object(t.function, 'function definition');
    if (f.strict !== undefined && typeof f.strict !== 'boolean') fail('function strict must be boolean');
    return { type: 'function', function: { name: identifier(f.name, 'function name'),
      ...(f.description !== undefined ? { description: string(f.description, 'description') } : {}),
      parameters: f.parameters === undefined ? { type: 'object', properties: {} } : object(f.parameters, 'parameters'),
      ...(f.strict !== undefined ? { strict: f.strict } : {}),
    } };
  });
}
function choice(value: unknown, anthropic: boolean): Obj | string {
  if (typeof value === 'string') {
    if (!['auto', 'none', 'required'].includes(value)) fail(`unsupported tool_choice: ${value}`);
    return anthropic ? { type: value === 'required' ? 'any' : value } : value;
  }
  const c = object(value, 'tool_choice');
  if (c.type !== 'function') fail('unsupported tool_choice; only named functions are supported');
  const name = identifier(c.function ? object(c.function, 'tool_choice function').name : c.name, 'tool_choice name');
  return anthropic ? { type: 'tool', name } : { type: 'function', function: { name } };
}
function image(url: unknown): Obj {
  const u = string(url, 'image URL');
  if (/^https?:\/\//i.test(u)) return { type: 'image', source: { type: 'url', url: u } };
  const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(u);
  if (!data) fail('image must be an HTTP(S) URL or a supported base64 image data URL');
  return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } };
}
function block(value: unknown, thinking = false): Obj {
  const b = object(value, 'content block');
  if (['text', 'input_text', 'output_text'].includes(b.type)) return {
    type: 'text', text: string(b.text, 'text'), ...(b.cache_control ? { cache_control: b.cache_control } : {}),
  };
  if (b.type === 'image_url' || b.type === 'input_image') {
    const source = b.type === 'image_url' ? object(b.image_url, 'image_url') : b;
    if (source.detail && source.detail !== 'auto') fail('image detail selection has no Anthropic equivalent');
    return image(source.url ?? source.image_url);
  }
  if (b.type === 'image') {
    const s = object(b.source, 'image source');
    return s.type === 'url' ? image(s.url) : s.type === 'base64'
      ? image(`data:${s.media_type};base64,${s.data}`) : fail('unsupported image source');
  }
  if (thinking && b.type === 'thinking') {
    string(b.thinking, 'thinking');
    if (!string(b.signature, 'thinking signature')) fail('unsigned thinking cannot be replayed');
    return { ...b };
  }
  if (thinking && b.type === 'redacted_thinking') { string(b.data, 'redacted thinking data'); return { ...b }; }
  fail(`unsupported content block ${String(b.type)}; executable/hosted content cannot be flattened`);
}
function blocks(content: unknown, thinking = false): Obj[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return list(content, 'content').map((b) => block(b, thinking));
}
function chatBlock(b: Obj): Obj {
  const native = block(b, true);
  if (native.type !== 'image') return native;
  const s = native.source;
  return { type: 'image_url', image_url: { url: s.type === 'url' ? s.url : `data:${s.media_type};base64,${s.data}` } };
}
function toolResult(m: BridgeMessage): Obj {
  const id = identifier(m.tool_call_id, 'tool_call_id');
  if (Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')) {
    if (m.content.length !== 1) fail('tool_result wrapper cannot be mixed with other content');
    const b = m.content[0];
    if (b.tool_use_id !== id) fail('tool_result ID does not match tool_call_id');
    if (b.is_error !== undefined && typeof b.is_error !== 'boolean') fail('is_error must be boolean');
    return { type: 'tool_result', tool_use_id: id, content: blocks(b.content),
      ...(b.is_error !== undefined ? { is_error: b.is_error } : {}) };
  }
  return { type: 'tool_result', tool_use_id: id, content: blocks(m.content) };
}
export function toAnthropicRequest(messages: BridgeMessage[], options: BridgeOptions, model: string): Obj {
  const body: Obj = { model, max_tokens: options.maxTokens ?? 4096, messages: [] };
  const system: Obj[] = [];
  for (const m of messages) {
    if (m.name !== undefined) fail('named messages have no Anthropic equivalent');
    if (m.reasoning_content) fail('unsigned reasoning_content cannot be replayed as signed Anthropic thinking');
    if (m.tool_calls !== undefined && m.role !== 'assistant') fail('tool_calls require assistant role');
    if (m.tool_call_id !== undefined && m.role !== 'tool') fail('tool_call_id requires tool role');
    if (m.role === 'system' || m.role === 'developer') {
      const content = blocks(m.content);
      if (content.some((b) => b.type !== 'text')) fail('system/developer content must be text');
      system.push(...content); continue;
    }
    if (!['assistant', 'user', 'tool'].includes(m.role)) fail(`unsupported role ${m.role}`);
    const role = m.role === 'tool' ? 'user' : m.role;
    const content = m.role === 'tool' ? [toolResult(m)] : blocks(m.content, m.role === 'assistant');
    for (const raw of m.tool_calls ?? []) {
      const c = call(raw);
      content.push({ type: 'tool_use', id: c.id, name: c.function.name, input: parameters(c.function.arguments) });
    }
    const last = body.messages.at(-1);
    if (last?.role === role) last.content.push(...content);
    else body.messages.push({ role, content });
  }
  if (system.length) body.system = system;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.tools !== undefined) body.tools = tools(options.tools).map(({ function: f }) => {
    if (f.strict === true) fail('strict function schemas have no equivalent in this Anthropic bridge');
    return { name: f.name, ...(f.description !== undefined ? { description: f.description } : {}), input_schema: f.parameters };
  });
  if (options.toolChoice !== undefined) body.tool_choice = choice(options.toolChoice, true);
  if (options.parallelToolCalls !== undefined) body.tool_choice = {
    ...(body.tool_choice ?? { type: 'auto' }), disable_parallel_tool_use: !options.parallelToolCalls,
  };
  if (options.responseFormat !== undefined) {
    const f = object(options.responseFormat, 'responseFormat');
    if (f.type !== 'text') {
      if (f.type !== 'json_schema') fail('only text/json_schema response formats are supported for Anthropic');
      body.output_config = { format: { type: 'json_schema', schema: object(object(f.json_schema, 'json_schema').schema, 'schema') } };
    }
  }
  if (options.thinkingEffort !== undefined) {
    if (!['low', 'medium', 'high', 'max'].includes(options.thinkingEffort)) fail('unsupported thinking effort');
    body.thinking = { type: 'adaptive' };
    body.output_config = { ...body.output_config, effort: options.thinkingEffort };
  }
  if (options.sessionKey !== undefined) body.metadata = { user_id: options.sessionKey };
  return body;
}
export function fromAnthropicRequest(body: Obj): { messages: BridgeMessage[]; options: BridgeOptions } {
  const messages: BridgeMessage[] = [], options: BridgeOptions = {};
  if (body.system !== undefined) {
    const system = blocks(body.system);
    if (system.some((b) => b.type !== 'text')) fail('system content must be text');
    messages.push({ role: 'system', content: system });
  }
  for (const raw of list(body.messages, 'messages')) {
    const m = object(raw, 'message');
    if (!['user', 'assistant'].includes(m.role)) fail(`unsupported Anthropic role ${m.role}`);
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : list(m.content, 'content');
    let current: BridgeMessage | undefined;
    const ensure = (): BridgeMessage => current ??= { role: m.role, content: [] };
    const flush = () => { if (current) messages.push(current); current = undefined; };
    for (const rawBlock of content) {
      const b = object(rawBlock, 'content block');
      if (b.type === 'tool_use') {
        if (m.role !== 'assistant') fail('tool_use requires assistant role');
        (ensure().tool_calls ??= []).push(call({ id: b.id, type: 'function', function: {
          name: b.name, arguments: JSON.stringify(object(b.input, 'tool_use input')),
        } }));
        flush(); // Preserve text/thinking/tool ordering when same-role messages are merged again.
      } else if (b.type === 'tool_result') {
        if (m.role !== 'user') fail('tool_result requires user role');
        flush();
        const id = string(b.tool_use_id, 'tool_use_id');
        if (b.is_error !== undefined && typeof b.is_error !== 'boolean') fail('is_error must be boolean');
        const output = typeof b.content === 'string' ? b.content : blocks(b.content).map(chatBlock);
        messages.push({ role: 'tool', tool_call_id: id, content: b.is_error === undefined ? output : [{
          type: 'tool_result', tool_use_id: id, content: output, is_error: b.is_error,
        }] });
      } else {
        if (m.role !== 'assistant' && ['thinking', 'redacted_thinking'].includes(b.type)) fail('thinking requires assistant role');
        (ensure().content as Obj[]).push(chatBlock(b));
      }
    }
    if (!content.length) ensure();
    flush();
  }
  if (body.max_tokens !== undefined) options.maxTokens = body.max_tokens;
  if (body.temperature !== undefined) options.temperature = body.temperature;
  if (body.tools !== undefined) options.tools = list(body.tools, 'tools').map((raw) => {
    const t = object(raw, 'tool');
    if (t.type && t.type !== 'custom') fail('hosted/server Anthropic tools are unsupported');
    if (t.strict === true) fail('strict Anthropic tool schemas are unsupported by this bridge');
    return tools([{ type: 'function', function: { name: t.name, description: t.description, parameters: object(t.input_schema, 'input_schema') } }])[0];
  });
  if (body.tool_choice !== undefined) {
    const c = object(body.tool_choice, 'tool_choice');
    options.toolChoice = c.type === 'tool' ? { type: 'function', function: { name: string(c.name, 'tool name') } }
      : c.type === 'any' ? 'required' : ['auto', 'none'].includes(c.type) ? c.type : fail('unsupported Anthropic tool_choice');
    if (c.disable_parallel_tool_use !== undefined) {
      if (typeof c.disable_parallel_tool_use !== 'boolean') fail('disable_parallel_tool_use must be boolean');
      options.parallelToolCalls = !c.disable_parallel_tool_use;
    }
  }
  if (body.thinking && !['adaptive', 'disabled'].includes(body.thinking.type)) fail('budgeted thinking is unsupported; use adaptive thinking');
  if (body.thinking?.type === 'adaptive') options.thinkingEffort = body.output_config?.effort ?? 'high';
  if (body.output_config?.format) {
    const f = body.output_config.format;
    if (f.type !== 'json_schema') fail('unsupported Anthropic output format');
    options.responseFormat = { type: 'json_schema', json_schema: { name: 'response', schema: object(f.schema, 'schema') } };
  }
  if (body.metadata?.user_id !== undefined) options.sessionKey = string(body.metadata.user_id, 'user_id');
  return { messages, options };
}
export function fromResponsesRequest(body: Obj): { messages: BridgeMessage[]; options: BridgeOptions } {
  if (body.previous_response_id != null || body.store === true || body.conversation != null)
    fail('stateless gateway cannot use previous_response_id, conversation or store=true; send full input history with store=false');
  const messages: BridgeMessage[] = [], options: BridgeOptions = {};
  if (body.instructions != null) messages.push({ role: 'system', content: string(body.instructions, 'instructions') });
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : list(body.input ?? [], 'input');
  for (const raw of input) {
    const item = object(raw, 'input item');
    if (item.type === 'function_call') {
      messages.push({ role: 'assistant', content: null, tool_calls: [call({ id: item.call_id, type: 'function',
        function: { name: item.name, arguments: item.arguments } })] });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: string(item.call_id, 'call_id'),
        content: typeof item.output === 'string' ? item.output : blocks(item.output).map(chatBlock) });
    } else if (item.type === undefined || item.type === 'message') {
      if (!['system', 'developer', 'user', 'assistant'].includes(item.role)) fail(`unsupported Responses role ${item.role}`);
      if (item.tool_calls !== undefined) fail('Responses message tool_calls are unsupported; use function_call items');
      messages.push({ role: item.role, content: typeof item.content === 'string' ? item.content : blocks(item.content).map(chatBlock) });
    } else fail(`unsupported Responses input item ${item.type}; hosted tools and encrypted reasoning cannot be discarded`);
  }
  if (body.tools !== undefined) options.tools = tools(body.tools, true);
  if (body.max_output_tokens !== undefined) options.maxTokens = body.max_output_tokens;
  if (body.temperature !== undefined) options.temperature = body.temperature;
  if (body.tool_choice !== undefined) options.toolChoice = choice(body.tool_choice, false);
  if (body.parallel_tool_calls !== undefined) options.parallelToolCalls = body.parallel_tool_calls;
  if (body.text?.format !== undefined) {
    const f = object(body.text.format, 'text.format');
    if (!['text', 'json_object', 'json_schema'].includes(f.type)) fail('unsupported Responses text format');
    options.responseFormat = f.type === 'json_schema' ? { type: 'json_schema', json_schema: {
      name: f.name, schema: object(f.schema, 'schema'), ...(f.strict !== undefined ? { strict: f.strict } : {}),
    } } : { type: f.type };
  }
  if (body.reasoning?.effort !== undefined) options.thinkingEffort = string(body.reasoning.effort, 'reasoning effort');
  return { messages, options };
}
function completionParts(completion: ChatCompletion): { message: BridgeMessage; calls: ToolCall[]; finish?: string | null } {
  if (completion.choices.length !== 1) fail('exactly one completion choice is required');
  const c = completion.choices[0];
  if (c.message.role !== 'assistant') fail('completion message must be assistant');
  if (c.message.reasoning_content) fail('unsigned completion reasoning cannot be faithfully exported to this protocol');
  if (c.finish_reason && !['stop', 'length', 'tool_calls'].includes(c.finish_reason)) fail(`unsupported finish_reason ${c.finish_reason}`);
  return { message: c.message, calls: (c.message.tool_calls ?? []).map(call), finish: c.finish_reason };
}
export function toAnthropicResponse(completion: ChatCompletion): Obj {
  const { message, calls, finish } = completionParts(completion);
  const details = completion.usage?.prompt_tokens_details ?? {};
  return { id: completion.id, type: 'message', role: 'assistant', model: completion.model ?? '',
    content: [...blocks(message.content, true), ...calls.map((c) => ({
      type: 'tool_use', id: c.id, name: c.function.name, input: parameters(c.function.arguments),
    }))], stop_reason: finish === 'length' ? 'max_tokens' : calls.length ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: Math.max(0, (completion.usage?.prompt_tokens ?? 0) - (details.cached_tokens ?? 0) - (details.cache_creation_tokens ?? 0)),
      output_tokens: completion.usage?.completion_tokens ?? 0,
      ...(details.cached_tokens !== undefined ? { cache_read_input_tokens: details.cached_tokens } : {}),
      ...(details.cache_creation_tokens !== undefined ? { cache_creation_input_tokens: details.cache_creation_tokens } : {}),
    } };
}
export function toResponsesResponse(completion: ChatCompletion): Obj {
  const { message, calls, finish } = completionParts(completion);
  const status = finish === 'length' ? 'incomplete' : 'completed';
  const output: Obj[] = [];
  const content = blocks(message.content).map((b) => {
    if (b.type !== 'text') fail('Responses output messages only support text in this bridge');
    return { type: 'output_text', text: b.text, annotations: [] };
  });
  if (content.length || !calls.length) output.push({ id: `msg_${completion.id}`, type: 'message', role: 'assistant', status, content });
  output.push(...calls.map((c) => ({ id: `fc_${c.id}`, type: 'function_call', call_id: c.id,
    name: c.function.name, arguments: c.function.arguments, status })));
  const input = completion.usage?.prompt_tokens ?? 0, generated = completion.usage?.completion_tokens ?? 0;
  return { id: `resp_${completion.id}`, object: 'response', created_at: completion.created ?? 0,
    model: completion.model ?? '', status, error: null,
    incomplete_details: finish === 'length' ? { reason: 'max_output_tokens' } : null, output,
    usage: { input_tokens: input, output_tokens: generated, total_tokens: input + generated,
      input_tokens_details: { cached_tokens: completion.usage?.prompt_tokens_details?.cached_tokens ?? 0 },
      output_tokens_details: { reasoning_tokens: completion.usage?.completion_tokens_details?.reasoning_tokens ?? 0 } }, store: false };
}
function tokenUsage(usage: Obj): Obj {
  const cached = usage.cache_read_input_tokens ?? 0, written = usage.cache_creation_input_tokens ?? 0;
  const prompt = (usage.input_tokens ?? 0) + cached + written, output = usage.output_tokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output,
    ...(cached || written ? { prompt_tokens_details: { cached_tokens: cached, cache_creation_tokens: written } } : {}) };
}
/** Returns chat chunk objects only. message_stop closes the converter and returns []; no SSE/[DONE] emitter. */
export class AnthropicChunkConverter {
  private id = '';
  private model = '';
  private created = 0;
  private ended = false;
  private usage: Obj = {};
  private toolCount = 0;
  private active = new Map<number, { type: string; index?: number; arguments: string; initial?: boolean }>();
  private chunk(delta: Obj, finish: string | null = null, usage?: Obj): Obj {
    return { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage: tokenUsage(usage) } : {}) };
  }
  convert(event: Record<string, any>): Array<Record<string, any>> {
    if (event.type === 'error') fail(`Anthropic stream error: ${event.error?.message ?? JSON.stringify(event.error)}`);
    if (this.ended) fail('Anthropic stream is already closed');
    if (event.type === 'ping') return [];
    if (event.type === 'message_start') {
      if (this.id) fail('duplicate message_start');
      const m = object(event.message, 'stream message');
      if (m.content?.length) fail('message_start content must be streamed as content blocks');
      this.id = string(m.id, 'stream message id');
      if (!this.id) fail('stream message id must not be empty');
      this.model = string(m.model, 'stream model');
      this.created = Math.floor(Date.now() / 1000);
      this.usage = { ...m.usage };
      return [this.chunk({ role: 'assistant', content: '' }, null, this.usage)];
    }
    if (!this.id) fail('Anthropic stream requires message_start first');
    if (event.type === 'content_block_start') {
      if (!Number.isInteger(event.index) || event.index < 0 || this.active.has(event.index)) fail('invalid/duplicate content block index');
      const b = object(event.content_block, 'stream content block');
      if (!['text', 'thinking', 'tool_use'].includes(b.type)) fail(`unsupported streamed content ${b.type}; hosted tools cannot be flattened`);
      if (b.type === 'thinking' && b.signature) fail('streamed thinking signatures cannot be represented by chat reasoning_content');
      const state = { type: b.type, arguments: '', index: undefined as number | undefined, initial: false };
      this.active.set(event.index, state);
      if (b.type === 'tool_use') {
        state.index = this.toolCount++;
        const input = object(b.input, 'stream tool input');
        state.initial = Object.keys(input).length > 0;
        state.arguments = state.initial ? JSON.stringify(input) : '';
        return [this.chunk({ tool_calls: [{ index: state.index, id: identifier(b.id, 'tool id'), type: 'function',
          function: { name: identifier(b.name, 'tool name'), arguments: state.arguments } }] })];
      }
      const text = string(b.type === 'text' ? b.text : b.thinking, b.type);
      return text ? [this.chunk({ [b.type === 'text' ? 'content' : 'reasoning_content']: text })] : [];
    }
    if (event.type === 'content_block_delta') {
      const state = this.active.get(event.index), d = object(event.delta, 'stream delta');
      if (!state) fail('delta references an unknown content block');
      if (d.type === 'input_json_delta' && state.type === 'tool_use') {
        if (state.initial) fail('tool JSON deltas cannot follow a nonempty initial input');
        const fragment = string(d.partial_json, 'partial_json');
        state.arguments += fragment;
        return [this.chunk({ tool_calls: [{ index: state.index, function: { arguments: fragment } }] })];
      }
      if (d.type === 'text_delta' && state.type === 'text') return [this.chunk({ content: string(d.text, 'text delta') })];
      if (d.type === 'thinking_delta' && state.type === 'thinking') return [this.chunk({ reasoning_content: string(d.thinking, 'thinking delta') })];
      fail(`unsupported stream delta ${d.type}; signatures cannot be represented by chat reasoning_content`);
    }
    if (event.type === 'content_block_stop') {
      const state = this.active.get(event.index);
      if (!state) fail('stop references an unknown content block');
      const result = state.type === 'tool_use' && !state.arguments
        ? [this.chunk({ tool_calls: [{ index: state.index, function: { arguments: '{}' } }] })] : [];
      if (state.type === 'tool_use') parameters(state.arguments || '{}');
      this.active.delete(event.index);
      return result;
    }
    if (event.type === 'message_delta') {
      const reason = event.delta?.stop_reason;
      const finish = reason == null ? null : reason === 'end_turn' || reason === 'stop_sequence' ? 'stop'
        : reason === 'max_tokens' ? 'length' : reason === 'tool_use' ? 'tool_calls' : fail(`unsupported Anthropic stop_reason ${reason}`);
      this.usage = { ...this.usage, ...event.usage };
      return [this.chunk({}, finish, this.usage)];
    }
    if (event.type === 'message_stop') {
      if (this.active.size) fail('message_stop received before content_block_stop');
      this.ended = true; return [];
    }
    fail(`unsupported Anthropic stream event ${event.type}`);
  }
}
