// @ts-ignore -- bun:test is runtime-provided; this Node/Vite project has no Bun type dependency.
import { describe, expect, test } from 'bun:test';
import { AnthropicChunkConverter, fromAnthropicRequest, fromResponsesRequest, toAnthropicRequest,
  toAnthropicResponse, toResponsesResponse, type BridgeMessage, type ChatCompletion } from './protocolBridge.ts';

const args = { city: 'São Paulo', nested: { flags: [true, false], text: 'quote " and \\ slash' } };
const tool = (id: string, input = args) => ({ id, type: 'function' as const,
  function: { name: `lookup_${id}`, arguments: JSON.stringify(input) } });
const completion = (finish = 'tool_calls'): ChatCompletion => ({ id: 'chatcmpl_test', model: 'test', created: 123,
  choices: [{ message: { role: 'assistant', content: 'Checking.', tool_calls: [tool('a'), tool('b')] }, finish_reason: finish }],
  usage: { prompt_tokens: 20, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 4, cache_creation_tokens: 2 } } });
const start = () => ({ type: 'message_start', message: { id: 'msg_stream', model: 'test', content: [],
  usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 } } });
const blockStart = (index: number, content_block: Record<string, any>) => ({ type: 'content_block_start', index, content_block });
const delta = (index: number, value: Record<string, any>) => ({ type: 'content_block_delta', index, delta: value });
const stop = (index: number) => ({ type: 'content_block_stop', index });

describe('Anthropic requests', () => {
  test('merges roles safely, preserves multi-tool JSON/results, system arrays and options without mutation', () => {
    const messages: BridgeMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'policy', cache_control: { type: 'ephemeral' } }] },
      { role: 'developer', content: 'developer policy' }, { role: 'user', content: 'question' },
      { role: 'user', content: [{ type: 'text', text: 'more' }] },
      { role: 'assistant', content: null, tool_calls: [tool('a'), tool('b')] },
      { role: 'tool', tool_call_id: 'a', content: 'ok' },
      { role: 'tool', tool_call_id: 'b', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'bad', is_error: true }] },
      { role: 'user', content: 'continue' },
    ];
    const before = JSON.stringify(messages);
    const options = { maxTokens: 1024, temperature: 0, tools: [{ type: 'function', function: {
      name: 'lookup', description: 'Find it', parameters: { type: 'object', properties: { city: { type: 'string' } } },
    } }], toolChoice: { type: 'function', function: { name: 'lookup' } }, parallelToolCalls: false,
      sessionKey: 'session', thinkingEffort: 'high', responseFormat: { type: 'json_schema', json_schema: { name: 'response', schema: { type: 'object' } } } };
    const body = toAnthropicRequest(messages, options, 'claude');
    expect(body.system.map((b: any) => b.text)).toEqual(['policy', 'developer policy']);
    expect(body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(body.messages[0].content).toHaveLength(2);
    expect(body.messages[1].content.map((b: any) => b.input)).toEqual([args, args]);
    expect(body.messages[2].content.map((b: any) => b.type)).toEqual(['tool_result', 'tool_result', 'text']);
    expect(body.messages[2].content[1].is_error).toBe(true);
    expect(body.tools[0].input_schema).toEqual(options.tools[0].function.parameters);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'lookup', disable_parallel_tool_use: true });
    const restored = fromAnthropicRequest(body);
    expect(restored.options).toEqual(options);
    expect(restored.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['a', 'b']);
    expect(toAnthropicRequest(restored.messages, restored.options, 'claude')).toEqual(body);
    expect(JSON.stringify(messages)).toBe(before);
  });
  test.each([['auto', 'auto'], ['none', 'none'], ['required', 'any']])('maps tool choice %s', (input: string, output: string) => {
    expect(toAnthropicRequest([], { toolChoice: input }, 'm').tool_choice).toEqual({ type: output });
    expect(fromAnthropicRequest({ messages: [], tool_choice: { type: output } }).options.toolChoice).toBe(input);
  });
  test('images, system string, signed/redacted thinking and structured tool output roundtrip', () => {
    const body = { system: 'policy', messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'plan', signature: 'signed' }, { type: 'redacted_thinking', data: 'opaque' },
      { type: 'tool_use', id: 'a', name: 'lookup_a', input: args },
    ] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', is_error: false, content: [
      { type: 'text', text: 'image result' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
    ] }] }] };
    const restored = fromAnthropicRequest(body), back = toAnthropicRequest(restored.messages, restored.options, 'm');
    expect(back.messages).toEqual(body.messages);
    expect(back.system).toEqual([{ type: 'text', text: 'policy' }]);
    expect((restored.messages[2].content as any[])[0].content[1].image_url.url).toBe('data:image/png;base64,aGVsbG8=');
  });
  test('preserves interleaved assistant text/tool blocks and rejects unsafe IDs/images', () => {
    const body = { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'before' },
      { type: 'tool_use', id: 'a', name: 'f', input: {} }, { type: 'text', text: 'between' },
      { type: 'tool_use', id: 'b', name: 'f', input: args }, { type: 'text', text: 'after' }] }] };
    const restored = fromAnthropicRequest(body);
    expect(toAnthropicRequest(restored.messages, restored.options, 'm').messages).toEqual(body.messages);
    const c = tool('');
    expect(() => toAnthropicRequest([{ role: 'assistant', content: null, tool_calls: [c] }], {}, 'm')).toThrow('must not be empty');
    for (const url of ['file:///tmp/image', 'data:text/plain;base64,aGVsbG8=', 'data:image/png;base64,???'])
      expect(() => toAnthropicRequest([{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }], {}, 'm')).toThrow('image');
    expect(() => fromAnthropicRequest({ messages: [], tools: [{ name: 'f', input_schema: {}, strict: true }] })).toThrow('strict');
  });
  test.each(['server_tool_use', 'web_search_tool_result', 'document', 'audio', 'unknown'])('rejects unsupported %s rather than flattening', (type: string) => {
    expect(() => fromAnthropicRequest({ messages: [{ role: 'assistant', content: [{ type, text: 'unsafe' }] }] })).toThrow('unsupported');
    expect(() => toAnthropicRequest([{ role: 'assistant', content: [{ type, text: 'unsafe' }] }], {}, 'm')).toThrow('unsupported');
  });
  test('explicitly rejects hosted tools, unsigned reasoning, wrong roles and invalid arguments', () => {
    expect(() => fromAnthropicRequest({ messages: [], tools: [{ type: 'web_search_20250305', name: 'web_search' }] })).toThrow('hosted/server');
    expect(() => toAnthropicRequest([], { tools: [{ type: 'web_search' }] }, 'm')).toThrow('hosted/server');
    expect(() => toAnthropicRequest([{ role: 'assistant', content: null, reasoning_content: 'plan' }], {}, 'm')).toThrow('unsigned');
    expect(() => fromAnthropicRequest({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'plan', signature: '' }] }] })).toThrow('unsigned');
    expect(() => fromAnthropicRequest({ messages: [{ role: 'user', content: [{ type: 'tool_use', id: 'a', name: 'f', input: {} }] }] })).toThrow('assistant role');
    expect(() => toAnthropicRequest([{ role: 'user', content: null, tool_calls: [tool('a')] }], {}, 'm')).toThrow('assistant role');
    for (const argumentsText of ['bad', 'null', '[]', '"text"']) {
      const c = tool('a'); c.function.arguments = argumentsText;
      expect(() => toAnthropicRequest([{ role: 'assistant', content: null, tool_calls: [c] }], {}, 'm')).toThrow('function arguments');
    }
    expect(() => toAnthropicRequest([{ role: 'tool', content: 'output' }], {}, 'm')).toThrow('tool_call_id');
    expect(() => fromAnthropicRequest({ messages: [], thinking: { type: 'enabled', budget_tokens: 1000 } })).toThrow('budgeted');
  });
});

describe('Responses requests and aggregate outputs', () => {
  test('roundtrips text and multi-tool Responses output as input, keeping IDs and JSON', () => {
    const response = toResponsesResponse(completion());
    const restored = fromResponsesRequest({ instructions: 'policy', input: [...response.output,
      { type: 'function_call_output', call_id: 'a', output: 'done' },
      { type: 'function_call_output', call_id: 'b', output: [{ type: 'input_text', text: 'result' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rule' }] },
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }] },
    ], max_output_tokens: 200, temperature: 0.5, tool_choice: { type: 'function', name: 'lookup_a' }, parallel_tool_calls: false,
      tools: [{ type: 'function', name: 'lookup_a', parameters: { type: 'object' } }, { type: 'function', function: { name: 'lookup_b' } }],
      text: { format: { type: 'json_schema', name: 'result', schema: { type: 'object' }, strict: true } }, reasoning: { effort: 'medium' }, store: false });
    expect(restored.messages.map((m) => m.role)).toEqual(['system', 'assistant', 'assistant', 'assistant', 'tool', 'tool', 'developer', 'user']);
    expect(restored.messages.flatMap((m) => m.tool_calls ?? [])).toEqual(completion().choices[0].message.tool_calls);
    expect(restored.options.maxTokens).toBe(200);
    expect(restored.options.tools?.map((t) => t.function.name)).toEqual(['lookup_a', 'lookup_b']);
    expect(restored.options.toolChoice).toEqual({ type: 'function', function: { name: 'lookup_a' } });
    expect(restored.options.responseFormat).toEqual({ type: 'json_schema', json_schema: { name: 'result', schema: { type: 'object' }, strict: true } });
    expect(toAnthropicRequest(restored.messages, { ...restored.options, responseFormat: undefined }, 'm').messages[0].content.filter((b: any) => b.type === 'tool_use')).toHaveLength(2);
    expect(response.status).toBe('completed');
    expect(response.usage).toMatchObject({ input_tokens: 20, output_tokens: 8, total_tokens: 28 });
    expect(fromResponsesRequest({ input: 'hello' }).messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
  test('Anthropic response stop reasons and cached usage; Responses truncation and null text', () => {
    const response = toAnthropicResponse(completion());
    expect(response.stop_reason).toBe('tool_use');
    expect(response.content.filter((b: any) => b.type === 'tool_use').map((b: any) => b.input)).toEqual([args, args]);
    expect(response.usage).toEqual({ input_tokens: 14, output_tokens: 8, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 });
    expect(toAnthropicResponse(completion('length')).stop_reason).toBe('max_tokens');
    expect(toResponsesResponse(completion('length'))).toMatchObject({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
    const plain: ChatCompletion = { id: 'plain', choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] };
    expect(toAnthropicResponse(plain).stop_reason).toBe('end_turn');
    expect(toResponsesResponse(plain).output[0].content[0].text).toBe('done');
    plain.choices[0].message = { role: 'assistant', content: null, tool_calls: [tool('a')] };
    expect(toResponsesResponse(plain).output.map((i: any) => i.type)).toEqual(['function_call']);
  });
  test.each([{ previous_response_id: 'resp_old' }, { store: true }, { conversation: 'conv' }])('rejects state reliance %j', (state: Record<string, any>) => {
    expect(() => fromResponsesRequest({ input: [], ...state })).toThrow('stateless gateway');
  });
  test.each(['reasoning', 'web_search_call', 'computer_call', 'unknown'])('rejects unsupported Responses item %s', (type: string) => {
    expect(() => fromResponsesRequest({ input: [{ type }] })).toThrow('unsupported');
  });
  test('refuses unsupported completion blocks, hosted definitions and multiple choices', () => {
    expect(() => fromResponsesRequest({ input: [], tools: [{ type: 'web_search' }] })).toThrow('hosted/server');
    expect(() => fromResponsesRequest({ input: [{ role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }] })).toThrow('unsupported');
    const c = completion(); c.choices.push(c.choices[0]);
    expect(() => toResponsesResponse(c)).toThrow('exactly one');
    c.choices.pop(); c.choices[0].message.content = [{ type: 'server_tool_use' }];
    expect(() => toAnthropicResponse(c)).toThrow('unsupported');
  });
});

describe('Anthropic chunk conversion', () => {
  test('fragmented multi-tool indices ignore text indices, preserve IDs, stable chunk ID and usage', () => {
    const converter = new AnthropicChunkConverter(), chunks = converter.convert(start());
    chunks.push(...converter.convert(blockStart(0, { type: 'text', text: 'Checking' })));
    chunks.push(...converter.convert(delta(0, { type: 'text_delta', text: '.' }))); converter.convert(stop(0));
    const accumulated: Record<number, any> = {};
    for (const [index, id] of [[1, 'a'], [3, 'b']] as const) {
      chunks.push(...converter.convert(blockStart(index, { type: 'tool_use', id, name: `lookup_${id}`, input: {} })));
      const json = JSON.stringify(args);
      for (const part of [json.slice(0, 4), json.slice(4, 19), json.slice(19)]) chunks.push(...converter.convert(delta(index, { type: 'input_json_delta', partial_json: part })));
      converter.convert(stop(index));
    }
    chunks.push(...converter.convert({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }));
    expect(converter.convert({ type: 'message_stop' })).toEqual([]);
    for (const chunk of chunks) for (const t of chunk.choices[0].delta.tool_calls ?? []) {
      const a = accumulated[t.index] ??= { id: t.id, name: t.function.name, arguments: '' };
      a.arguments += t.function.arguments;
    }
    expect(Object.values(accumulated).map((c: any) => [c.id, c.name, JSON.parse(c.arguments)])).toEqual([['a', 'lookup_a', args], ['b', 'lookup_b', args]]);
    expect(new Set(chunks.map((c) => c.id))).toEqual(new Set(['msg_stream']));
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe('tool_calls');
    expect(chunks.at(-1)!.usage).toMatchObject({ prompt_tokens: 16, completion_tokens: 9, total_tokens: 25 });
    expect(chunks[0].choices[0].delta.role).toBe('assistant');
  });
  test.each([['end_turn', 'stop'], ['max_tokens', 'length'], ['tool_use', 'tool_calls']])('maps finish %s', (reason: string, finish: string) => {
    const c = new AnthropicChunkConverter(); c.convert(start());
    expect(c.convert({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 1 } })[0].choices[0].finish_reason).toBe(finish);
  });
  test('thinking deltas, empty arguments and nonempty initial tool input', () => {
    const c = new AnthropicChunkConverter(); c.convert(start());
    expect(c.convert(blockStart(0, { type: 'thinking', thinking: 'plan' }))[0].choices[0].delta.reasoning_content).toBe('plan');
    expect(c.convert(delta(0, { type: 'thinking_delta', thinking: ' more' }))[0].choices[0].delta.reasoning_content).toBe(' more'); c.convert(stop(0));
    c.convert(blockStart(1, { type: 'tool_use', id: 'empty', name: 'empty', input: {} }));
    expect(c.convert(stop(1))[0].choices[0].delta.tool_calls[0].function.arguments).toBe('{}');
    expect(c.convert(blockStart(2, { type: 'tool_use', id: 'a', name: 'f', input: args }))[0].choices[0].delta.tool_calls[0].function.arguments).toBe(JSON.stringify(args));
    expect(() => c.convert(delta(2, { type: 'input_json_delta', partial_json: '{}' }))).toThrow('nonempty initial');
  });
  test('errors, invalid fragmented JSON, unsupported executable blocks/signatures and closed streams throw', () => {
    const c = new AnthropicChunkConverter();
    expect(() => c.convert({ type: 'error', error: { message: 'overloaded' } })).toThrow('overloaded');
    expect(() => c.convert(delta(0, { type: 'text_delta', text: 'orphan' }))).toThrow('message_start'); c.convert(start());
    expect(c.convert({ type: 'ping' })).toEqual([]);
    expect(() => c.convert(blockStart(0, { type: 'server_tool_use' }))).toThrow('unsupported');
    c.convert(blockStart(0, { type: 'thinking', thinking: '' }));
    expect(() => c.convert(delta(0, { type: 'signature_delta', signature: 'signed' }))).toThrow('signatures'); c.convert(stop(0));
    c.convert(blockStart(1, { type: 'tool_use', id: 'a', name: 'f', input: {} })); c.convert(delta(1, { type: 'input_json_delta', partial_json: '{bad' }));
    expect(() => c.convert(stop(1))).toThrow('valid JSON');
    const closed = new AnthropicChunkConverter(); closed.convert(start()); closed.convert({ type: 'message_stop' });
    expect(() => closed.convert({ type: 'message_delta' })).toThrow('closed');
  });
});
