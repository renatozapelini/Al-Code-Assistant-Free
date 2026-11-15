import crypto from 'node:crypto';
import type { Response } from 'express';
import type { ChatCompletion, BridgeMessage } from './protocolBridge.ts';

type Obj = Record<string, any>;

/** Aggregate fragmented tool arguments without dropping IDs, names or finish_reason. */
export class CompletionAccumulator {
  id = `chatcmpl-${crypto.randomUUID()}`;
  content = '';
  reasoning = '';
  finishReason = 'stop';
  promptTokens = 0;
  completionTokens = 0;
  tools = new Map<number, NonNullable<BridgeMessage['tool_calls']>[number]>();
  add(chunk: Obj): void {
    if (chunk.id) this.id = chunk.id;
    if (chunk.usage) {
      this.promptTokens = Math.max(this.promptTokens, Number(chunk.usage.prompt_tokens || 0));
      this.completionTokens = Math.max(this.completionTokens, Number(chunk.usage.completion_tokens || 0));
    }
    for (const choice of chunk.choices ?? []) {
      if ((choice.index ?? 0) !== 0) throw new Error('O gateway suporta uma escolha por requisição (n=1).');
      const delta = choice.delta ?? choice.message ?? {};
      this.content += delta.content ?? '';
      this.reasoning += delta.reasoning_content ?? '';
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
      for (const tool of delta.tool_calls ?? []) {
        const index = tool.index ?? this.tools.size;
        const old = this.tools.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tool.id) old.id = tool.id;
        if (tool.function?.name) old.function.name += tool.function.name;
        if (tool.function?.arguments) old.function.arguments += tool.function.arguments;
        this.tools.set(index, old);
      }
    }
  }
  completion(model: string): ChatCompletion & Obj {
    const tools = [...this.tools.values()];
    return {
      id: this.id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: this.content || (tools.length ? null : ''),
        ...(tools.length ? { tool_calls: tools } : {}), ...(this.reasoning ? { reasoning_content: this.reasoning } : {}) },
        finish_reason: this.finishReason }],
      usage: { prompt_tokens: this.promptTokens, completion_tokens: this.completionTokens,
        total_tokens: this.promptTokens + this.completionTokens },
    };
  }
}

export function startSse(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}
export function event(res: Response, type: string, data: Obj): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Translate OpenAI tool deltas into Anthropic's structured block lifecycle. */
export class AnthropicStreamWriter {
  private nextIndex = 0;
  private activeBlock?: { index: number; kind: string };
  private toolBlocks = new Map<number, { index: number; started: boolean; id: string; name: string; args: string }>();
  private reason = 'end_turn';
  constructor(private res: Response, model: string, usage: { prompt_tokens?: number } = {}) {
    event(res, 'message_start', { type: 'message_start', message: { id: `msg_${crypto.randomUUID()}`,
      type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: 0 } } });
  }
  private close(): void {
    if (this.activeBlock) event(this.res, 'content_block_stop', { type: 'content_block_stop', index: this.activeBlock.index });
    this.activeBlock = undefined;
  }
  write(chunk: Obj): void {
    for (const choice of chunk.choices ?? []) {
      const d = choice.delta ?? {};
      if (choice.finish_reason) this.reason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
      // Unsigned cross-provider reasoning is not an Anthropic thinking block; emit text only.
      if (d.content) {
        if (this.activeBlock?.kind !== 'text') {
          this.close();
          this.activeBlock = { index: this.nextIndex++, kind: 'text' };
          event(this.res, 'content_block_start', { type: 'content_block_start', index: this.activeBlock.index, content_block: { type: 'text', text: '' } });
        }
        event(this.res, 'content_block_delta', { type: 'content_block_delta', index: this.activeBlock.index,
          delta: { type: 'text_delta', text: d.content } });
      }
      for (const tool of d.tool_calls ?? []) {
        const ti = tool.index ?? 0;
        let block = this.toolBlocks.get(ti);
        if (!block) {
          this.close();
          block = { index: this.nextIndex++, started: false, id: '', name: '', args: '' };
          this.toolBlocks.set(ti, block);
        }
        if (tool.id) block.id = tool.id;
        if (tool.function?.name) block.name += tool.function.name;
        block.args += tool.function?.arguments ?? '';
        if (!block.started && block.id && block.name) {
          event(this.res, 'content_block_start', { type: 'content_block_start', index: block.index,
            content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
          block.started = true;
        }
        if (block.started && block.args) {
          event(this.res, 'content_block_delta', { type: 'content_block_delta', index: block.index,
            delta: { type: 'input_json_delta', partial_json: block.args } });
          block.args = '';
        }
      }
    }
  }
  end(usage: Obj): void {
    this.close();
    for (const b of this.toolBlocks.values()) {
      if (!b.started) throw new Error('Chamada de ferramenta sem ID ou nome.');
      event(this.res, 'content_block_stop', { type: 'content_block_stop', index: b.index });
    }
    event(this.res, 'message_delta', { type: 'message_delta', delta: { stop_reason: this.reason, stop_sequence: null },
      usage: { output_tokens: usage.completion_tokens ?? 0 } });
    event(this.res, 'message_stop', { type: 'message_stop' });
    this.res.end();
  }
}

// Responses is buffered until validated, then delivered as a complete SSE lifecycle.
// This avoids replaying half-executed tools when a provider disconnects.
export function writeResponsesSse(res: Response, response: Obj): void {
  startSse(res);
  let sequence = 0;
  const emit = (type: string, data: Obj) => event(res, type, { type, sequence_number: sequence++, ...data });
  emit('response.created', { response: { ...response, status: 'in_progress', output: [] } });
  emit('response.in_progress', { response: { ...response, status: 'in_progress', output: [] } });
  for (let i = 0; i < response.output.length; i++) {
    const item = response.output[i];
    emit('response.output_item.added', { output_index: i, item: { ...item, status: 'in_progress',
      ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } });
    if (item.type === 'function_call') {
      emit('response.function_call_arguments.delta', { item_id: item.id, output_index: i, delta: item.arguments });
      emit('response.function_call_arguments.done', { item_id: item.id, output_index: i, arguments: item.arguments, name: item.name });
    } else if (item.type === 'message') {
      for (let ci = 0; ci < item.content.length; ci++) {
        const part = item.content[ci];
        emit('response.content_part.added', { item_id: item.id, output_index: i, content_index: ci, part: { ...part, text: '' } });
        emit('response.output_text.delta', { item_id: item.id, output_index: i, content_index: ci, delta: part.text });
        emit('response.output_text.done', { item_id: item.id, output_index: i, content_index: ci, text: part.text });
        emit('response.content_part.done', { item_id: item.id, output_index: i, content_index: ci, part });
      }
    }
    emit('response.output_item.done', { output_index: i, item });
  }
  emit(response.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response });
  res.end();
}
