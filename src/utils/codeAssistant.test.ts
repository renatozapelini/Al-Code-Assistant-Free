import { describe, expect, test } from 'bun:test';
import { CodeAssistantRunner, createCodeProject, restoreCodeProjects, validateProjectPath, validateProjectFiles,
  type AssistantReply, type AssistantTransport, type CodeMessage, type CodeProject, type CodeToolCall } from './codeAssistant';
import { buildZipBlob } from './androidProjectZip';
const call = (name: string, args: unknown, id = crypto.randomUUID()): CodeToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (providerId: string, calls: CodeToolCall[]): AssistantReply => ({ providerId, model: providerId + '-coder',
  message: { role: 'assistant', content: null, tool_calls: calls }, finishReason: 'tool_calls' });
const start = (maxTurns = 20) => createCodeProject({ name: 'App de teste', goal: 'Criar página HTML', providerIds: ['a', 'b'], maxTurns });
const providers = [{ id: 'a', name: 'IA A', enabled: true }, { id: 'b', name: 'IA B', enabled: true }];
const endCalls = () => [call('set_task_status', { id: 'task-1', status: 'completed' }), call('project_complete', { summary: 'Arquivos implementados. Revisão e build ainda necessários.' })];
const serializedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const largeProject = (maxTurns = 5) => createCodeProject({ name: 'Projeto de 2 MB', goal: 'Revisar arquivos existentes',
  providerIds: ['a', 'b'], maxTurns,
  files: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`src/file-${i}.ts`, 'á'.repeat(100000)])) });
const readCalls = (project: CodeProject) => Object.keys(project.files).map((path) => call('read_file', { path }));
const readExchange = (project: CodeProject): CodeMessage[] => {
  const calls = readCalls(project);
  return [reply('a', calls).message, ...calls.map((tool): CodeMessage => ({ role: 'tool', tool_call_id: tool.id,
    content: project.files[JSON.parse(tool.function.arguments).path] }))];
};
const expectCompletePairs = (exchanges: CodeMessage[][]) => {
  for (const [assistant, ...results] of exchanges) {
    expect(assistant.role).toBe('assistant');
    expect(results.map((result) => [result.role, result.tool_call_id])).toEqual(
      (assistant.tool_calls ?? []).map((tool) => ['tool', tool.id]));
  }
};
describe('code assistants execute project files, not chat text', () => {
  test('IA A creates files, then 402 hands project to IA B without replaying completed writes', async () => {
    const attempts: string[] = [], contexts: CodeMessage[][] = [];
    let first = true, saved = '';
    const transport: AssistantTransport = { available: async () => providers,
      complete: async (id, messages) => {
        attempts.push(id); contexts.push(messages);
        if (id === 'a' && first) { first = false; return reply(id, [call('set_plan', { tasks: ['Página inicial'] }), call('write_file', { path: 'index.html', content: '<h1>Projeto A</h1>' })]); }
        if (id === 'a') throw new Error('HTTP 402 — sem créditos');
        expect(messages[0].content).toContain('index.html');
        expect(messages[0].content).toContain('task-1');
        expect(messages.some((m) => m.role === 'tool' && m.content?.includes('"saved":"index.html"'))).toBe(true);
        return reply(id, [call('replace_in_file', { path: 'index.html', old_text: 'Projeto A', new_text: 'Continuado por B' }), ...endCalls()]);
      } };
    const runner = new CodeAssistantRunner(start(), transport, (p) => { saved = JSON.stringify(p); });
    await runner.run();
    expect(attempts).toEqual(['a', 'a', 'b']);
    expect(runner.project.files['index.html']).toBe('<h1>Continuado por B</h1>');
    expect(runner.project.revision).toBe(2);
    expect(runner.project.status).toBe('review');
    expect(runner.project.events.filter((e) => e.type === 'handoff')).toHaveLength(1);
    expect(JSON.parse(saved).files).toEqual(runner.project.files);
    expect(contexts[2][0].content).toContain('revisão 1');
  });
  test('pause/reload resumes pending batch exactly once from durable checkpoint', async () => {
    let persisted: CodeProject | undefined;
    let runner: CodeAssistantRunner;
    const transport: AssistantTransport = { available: async () => providers, complete: async (id) => reply(id, [
      call('set_plan', { tasks: ['Página'] }), call('write_file', { path: 'index.html', content: 'A' }),
      call('replace_in_file', { path: 'index.html', old_text: 'A', new_text: 'B' }), ...endCalls()]) };
    runner = new CodeAssistantRunner(start(), transport, (p) => { persisted = JSON.parse(JSON.stringify(p)); }, (p) => { if (p.revision === 1) runner.pause(); });
    await runner.run();
    expect(persisted!.files['index.html']).toBe('A'); expect(persisted!.pending?.index).toBe(2);
    const restored = restoreCodeProjects(JSON.stringify([persisted]))[0];
    const resumed = new CodeAssistantRunner(restored, { available: async () => providers, complete: async () => { throw new Error('Must not request another model'); } }, (p) => { persisted = p; });
    await resumed.run();
    expect(resumed.project.files['index.html']).toBe('B'); expect(resumed.project.revision).toBe(2);
    expect(resumed.project.status).toBe('review'); expect(resumed.project.pending).toBeUndefined();
    expect(resumed.project.receipts).toEqual({});
  });
  test('failed storage checkpoint halts instead of applying tools or trying another IA', async () => {
    const attempts: string[] = [];
    const runner = new CodeAssistantRunner(start(), { available: async () => providers,
      complete: async (id) => { attempts.push(id); return reply(id, [call('write_file', { path: 'x.ts', content: 'x' })]); } },
      (p) => { if (p.pending) throw new Error('Storage quota exceeded'); });
    await expect(runner.run()).rejects.toThrow('Storage quota');
    expect(attempts).toEqual(['a']); expect(runner.project.files).toEqual({});
  });
  test('repeated 2 MB reads keep every checkpoint below saveList quota and the latest exchange complete', async () => {
    const project = largeProject();
    project.tasks = [{ id: 'task-1', title: 'Revisar', status: 'in_progress' }];
    let rounds = 0, largest = 0, saves = 0;
    const runner = new CodeAssistantRunner(project, { available: async () => providers, complete: async (id, messages) => {
      if (rounds++) {
        const results = messages.filter((message) => message.role === 'tool');
        expect(results).toHaveLength(10);
        expect(results.every((message) => message.content === project.files['src/file-0.ts'])).toBe(true);
      }
      return reply(id, readCalls(project));
    } }, (next) => {
      const size = serializedBytes([next]); largest = Math.max(largest, size); saves++;
      if (size > 4400000) throw new Error('saveList quota exceeded');
      expect(next.receipts).toEqual({});
      if (next.pending) expect(next.exchanges.at(-1)!.length).toBe(next.pending.index + 1);
    });
    await runner.run();
    expect(rounds).toBe(5); expect(saves).toBeGreaterThan(50);
    expect(largest).toBeLessThan(4400000);
    expect(runner.project.status).toBe('paused');
    expect(runner.project.files).toEqual(project.files); expect(runner.project.tasks).toEqual(project.tasks);
    expect(runner.project.exchanges.length).toBeLessThanOrEqual(3);
    expect(serializedBytes(runner.project.exchanges)).toBeLessThanOrEqual(2100000);
    expect(runner.project.exchanges.at(-1)!.slice(1).map((message) => message.content)).toEqual(Object.values(project.files));
    expectCompletePairs(runner.project.exchanges);
  });
  test('restoration and runner start compact bloated legacy history before the first persistence', async () => {
    const legacy = largeProject(1);
    legacy.status = 'running'; legacy.summary = 'Resumo preservado';
    legacy.tasks = [{ id: 'task-1', title: 'Revisar', status: 'pending' }];
    legacy.exchanges = [readExchange(legacy), readExchange(legacy), readExchange(legacy)];
    legacy.receipts = Object.fromEntries(Object.entries(legacy.files).map(([path, content]) => [`old:${path}`, content]));
    expect(serializedBytes([legacy])).toBeGreaterThan(4400000);
    const restored = restoreCodeProjects(JSON.stringify([legacy]))[0];
    expect(restored.receipts).toEqual({}); expect(restored.status).toBe('paused');
    expect(restored.exchanges).toEqual([legacy.exchanges.at(-1)!]);
    expect(restored.files).toEqual(legacy.files); expect(restored.tasks).toEqual(legacy.tasks);
    expect(restored.summary).toBe(legacy.summary); expectCompletePairs(restored.exchanges);
    expect(serializedBytes([restored])).toBeLessThan(4400000);
    for (const initial of [legacy, restored]) {
      let firstSaved: CodeProject | undefined;
      const runner = new CodeAssistantRunner(initial, { available: async () => [], complete: async () => { throw new Error('No model'); } }, (next) => {
        if (serializedBytes([next]) > 4400000) throw new Error('saveList quota exceeded');
        firstSaved ??= structuredClone(next);
      });
      await runner.run();
      expect(firstSaved!.receipts).toEqual({}); expect(firstSaved!.files).toEqual(legacy.files);
      expect(firstSaved!.exchanges).toEqual(restored.exchanges);
    }
    expect(Object.keys(legacy.receipts)).toHaveLength(10); // Constructor does not mutate its input.
  });
  test('oversized completed exchange is replaced as a whole, never with truncated tool pairs', () => {
    const project = largeProject();
    // Escaped JSON takes more space than the validated text file bytes.
    project.files = Object.fromEntries(Object.keys(project.files).map((path) => [path, '"'.repeat(200000)]));
    project.exchanges = [readExchange(project)];
    const restored = restoreCodeProjects(JSON.stringify([project]))[0];
    expect(restored.files).toEqual(project.files);
    expect(serializedBytes([restored])).toBeLessThan(4400000);
    expect(restored.exchanges).toHaveLength(1);
    expect(restored.exchanges[0]).toHaveLength(1);
    expect(restored.exchanges[0][0].content).toContain('checkpoint autoritativo');
    expect(restored.exchanges[0][0].tool_calls).toBeUndefined();
    expectCompletePairs(restored.exchanges);
  });
  test('legacy pending keeps unconsumed receipts and incomplete exchanges but never replays mutations', async () => {
    const project = start(1);
    project.files = { 'index.html': 'B' }; project.revision = 2;
    project.tasks = [{ id: 'task-1', title: 'Página', status: 'in_progress' }];
    const calls = [call('write_file', { path: 'index.html', content: 'A' }),
      call('replace_in_file', { path: 'index.html', old_text: 'A', new_text: 'B' }), ...endCalls()];
    const partial: CodeMessage[] = [reply('a', calls).message, { role: 'tool', tool_call_id: calls[0].id, content: 'saved A' }];
    const orphaned: CodeMessage[] = [reply('a', [call('read_file', { path: 'index.html' })]).message];
    project.exchanges = [orphaned, ...Array.from({ length: 5 }, () => readExchange(project)), partial];
    project.pending = { sequence: 'legacy', calls, index: 1 };
    project.receipts = { 'old:0': 'x'.repeat(200000), 'legacy:0': 'saved A', 'legacy:1': 'saved B',
      'legacy:2': '{"id":"task-1","status":"completed"}', 'legacy:4': 'out of batch' };
    // The legacy receipt records an already-applied mutation with a stale index.
    project.tasks[0].status = 'completed';
    const restored = restoreCodeProjects(JSON.stringify([project]))[0];
    expect(restored.pending).toEqual(project.pending);
    expect(restored.receipts).toEqual({ 'legacy:1': 'saved B', 'legacy:2': project.receipts['legacy:2'] });
    expect(restored.exchanges[0]).toEqual(orphaned); expect(restored.exchanges.at(-1)).toEqual(partial);
    expect(restored.files).toEqual(project.files); expect(restored.tasks).toEqual(project.tasks);
    let saves = 0;
    const runner = new CodeAssistantRunner(restored, { available: async () => providers,
      complete: async () => { throw new Error('Pending must finish without a new request'); } }, (next) => {
      saves++;
      if (next.pending?.index === 2) expect(next.receipts).toEqual({ 'legacy:2': project.receipts['legacy:2'] });
    });
    await runner.run();
    expect(saves).toBeGreaterThan(3); expect(runner.project.files['index.html']).toBe('B');
    expect(runner.project.revision).toBe(2); expect(runner.project.status).toBe('review');
    expect(runner.project.receipts).toEqual({}); expect(runner.project.pending).toBeUndefined();
    const results = runner.project.exchanges.at(-1)!.slice(1);
    expect(results.map((result) => result.tool_call_id)).toEqual(calls.map((tool) => tool.id));
    expect(results[1].content).toBe('saved B');
  });
  test('a cached project_complete result restores review without requesting a model', async () => {
    const project = start(); project.files = { 'index.html': 'Done' };
    project.tasks = [{ id: 'task-1', title: 'Página', status: 'completed' }];
    project.summary = 'Resumo já aplicado';
    const calls = [call('project_complete', { summary: 'Resumo já aplicado' })];
    project.exchanges = [[reply('a', calls).message]];
    project.pending = { sequence: 'cached', calls, index: 0 };
    project.receipts = { 'cached:0': 'Arquivos prontos para revisão humana. Compilação/testes não foram executados por esta ferramenta.' };
    const runner = new CodeAssistantRunner(restoreCodeProjects(JSON.stringify([project]))[0], {
      available: async () => { throw new Error('No new model'); }, complete: async () => { throw new Error('No new model'); },
    }, () => {});
    await runner.run();
    expect(runner.project.status).toBe('review'); expect(runner.project.summary).toBe(project.summary);
    expect(runner.project.receipts).toEqual({}); expectCompletePairs(runner.project.exchanges);
  });
  test('failed final checkpoint retains the unconsumed legacy receipt and pending pair for retry', async () => {
    const project = start(); project.files = { 'index.html': 'Done' };
    project.tasks = [{ id: 'task-1', title: 'Página', status: 'completed' }];
    project.summary = 'Resumo já aplicado';
    const calls = [call('project_complete', { summary: 'Resumo já aplicado' })];
    project.exchanges = [[reply('a', calls).message]];
    project.pending = { sequence: 'cached', calls, index: 0 };
    project.receipts = { 'cached:0': 'Arquivos prontos para revisão humana. Compilação/testes não foram executados por esta ferramenta.' };
    let durable = JSON.stringify([project]), rejected = 0;
    const noModel: AssistantTransport = { available: async () => { throw new Error('No model'); }, complete: async () => { throw new Error('No model'); } };
    const runner = new CodeAssistantRunner(project, noModel, (next) => {
      if (!next.pending) {
        expect(next.receipts).toEqual({}); expectCompletePairs(next.exchanges);
        rejected++; throw new Error('Final save failed');
      }
      durable = JSON.stringify([next]);
    });
    await expect(runner.run()).rejects.toThrow('Final save failed');
    expect(rejected).toBe(1);
    const restored = restoreCodeProjects(durable)[0];
    expect(restored.pending).toEqual(project.pending); expect(restored.receipts).toEqual(project.receipts);
    expect(restored.exchanges).toEqual(project.exchanges); expect(restored.files).toEqual(project.files);
    expect(runner.project.receipts).toEqual(project.receipts);
    const resumed = new CodeAssistantRunner(restored, noModel, (next) => { durable = JSON.stringify([next]); });
    await resumed.run();
    expect(resumed.project.status).toBe('review'); expect(resumed.project.pending).toBeUndefined();
    expect(resumed.project.receipts).toEqual({}); expect(resumed.project.exchanges[0]).toHaveLength(2);
    expectCompletePairs(resumed.project.exchanges);
    expect(JSON.parse(durable)[0]).toEqual(resumed.project);
  });
  test('an oversized pending batch is preserved, not summarized to force a save', async () => {
    const project = largeProject(1);
    const calls = Array.from({ length: 16 }, () => call('read_file', { path: 'src/file-0.ts' }));
    let durable = '', requests = 0;
    const runner = new CodeAssistantRunner(project, { available: async () => providers,
      complete: async (id) => { requests++; return reply(id, calls); } }, (next) => {
      if (serializedBytes([next]) > 4400000) throw new Error('saveList quota exceeded');
      durable = JSON.stringify([next]);
    });
    await expect(runner.run()).rejects.toThrow('saveList quota exceeded');
    const restored = restoreCodeProjects(durable)[0];
    expect(requests).toBe(1); expect(restored.status).toBe('paused');
    expect(restored.pending!.index).toBeGreaterThan(0); expect(restored.pending!.index).toBeLessThan(16);
    expect(restored.pending!.calls).toEqual(calls); expect(restored.files).toEqual(project.files);
    expect(restored.exchanges[0][0].tool_calls).toEqual(calls);
    expect(restored.exchanges[0]).toHaveLength(restored.pending!.index + 1);
    expect(restored.exchanges[0].slice(1).every((result) => result.content === project.files['src/file-0.ts'])).toBe(true);
    expect(restored.receipts).toEqual({});
  });
  test('large partial batch survives pause/reload and failed mutation persistence with exact results', async () => {
    const project = largeProject(1);
    project.files['src/file-0.ts'] = 'A' + project.files['src/file-0.ts'].slice(1);
    project.tasks = [{ id: 'task-1', title: 'Revisar', status: 'in_progress' }];
    const calls = [...readCalls(project), call('replace_in_file', { path: 'src/file-0.ts', old_text: 'A', new_text: 'B' }), ...endCalls()];
    let durable = '', runner: CodeAssistantRunner;
    const save = (next: CodeProject) => {
      if (serializedBytes([next]) > 4400000) throw new Error('saveList quota exceeded');
      durable = JSON.stringify([next]);
    };
    runner = new CodeAssistantRunner(project, { available: async () => providers,
      complete: async (id) => reply(id, calls) }, save, (next) => { if (next.pending?.index === 5) runner.pause(); });
    await runner.run();
    const legacyPaused = JSON.parse(durable)[0] as CodeProject;
    legacyPaused.receipts = Object.fromEntries(Object.values(project.files).map((content, index) => [`finished:${index}`, content]));
    for (let index = 0; index < 5; index++) legacyPaused.receipts[`${legacyPaused.pending!.sequence}:${index}`] = Object.values(project.files)[index];
    const paused = restoreCodeProjects(JSON.stringify([legacyPaused]))[0];
    expect(paused.exchanges).toEqual(legacyPaused.exchanges);
    expect(paused.pending?.index).toBe(5); expect(paused.exchanges.at(-1)).toHaveLength(6);
    expect(paused.receipts).toEqual({}); expect(paused.files).toEqual(project.files);
    const noModel: AssistantTransport = { available: async () => { throw new Error('No model'); }, complete: async () => { throw new Error('No model'); } };
    const failed = new CodeAssistantRunner(paused, noModel, (next) => {
      if (next.revision === 1) throw new Error('Injected persistence failure');
      save(next);
    });
    await expect(failed.run()).rejects.toThrow('Injected persistence failure');
    const afterFailure = restoreCodeProjects(durable)[0];
    expect(afterFailure.pending?.index).toBe(10); expect(afterFailure.revision).toBe(0);
    expect(afterFailure.files).toEqual(project.files); expect(afterFailure.tasks).toEqual(project.tasks);
    expect(afterFailure.exchanges.at(-1)).toHaveLength(11);
    expect(failed.project.files).toEqual(project.files);
    const resumed = new CodeAssistantRunner(afterFailure, noModel, save);
    await resumed.run();
    expect(resumed.project.status).toBe('review'); expect(resumed.project.revision).toBe(1);
    expect(resumed.project.files['src/file-0.ts']).toBe('B' + project.files['src/file-0.ts'].slice(1));
    expect(resumed.project.tasks[0].status).toBe('completed'); expect(resumed.project.pending).toBeUndefined();
    expect(resumed.project.receipts).toEqual({}); expectCompletePairs(resumed.project.exchanges);
    const results = resumed.project.exchanges.at(-1)!.slice(1);
    expect(results.map((result) => result.tool_call_id)).toEqual(calls.map((tool) => tool.id));
    expect(results.slice(0, 10).map((result) => result.content)).toEqual(Object.values(project.files));
    expect(serializedBytes(JSON.parse(durable))).toBeLessThan(4400000);
  });
  test('path traversal, secrets, Windows names and case duplicates are refused', () => {
    for (const path of ['../x', '/tmp/x', 'C:/x', 'x\\y', '.git/config', 'node_modules/a', '.env', '.env.production', 'secrets.json', 'CON.txt', 'a/..', 'a:b', '__proto__']) expect(() => validateProjectPath(path)).toThrow();
    expect(validateProjectPath('src/main.ts')).toBe('src/main.ts');
    expect(validateProjectPath('.env.example')).toBe('.env.example');
    expect(() => validateProjectFiles({ 'src/A.ts': 'x', 'src/a.ts': 'y' })).toThrow();
  });
  test('invalid tool does not leave a partially applied file mutation', async () => {
    let count = 0;
    const transport: AssistantTransport = { available: async () => providers,
      complete: async (id) => ++count === 1 ? reply(id, [call('set_plan', { tasks: ['Página'] }), call('write_file', { path: '../escape', content: 'bad' }), call('write_file', { path: 'index.html', content: 'safe' })]) : reply(id, endCalls()) };
    const runner = new CodeAssistantRunner(start(), transport, () => {}); await runner.run();
    expect(runner.project.files).toEqual({ 'index.html': 'safe' });
    expect(runner.project.exchanges.flat().some((m) => m.role === 'tool' && m.content?.includes('error'))).toBe(true);
  });
  test('ambiguous replacement never overwrites the current file', async () => {
    let count = 0;
    const runner = new CodeAssistantRunner(start(), { available: async () => providers,
      complete: async (id) => ++count === 1 ? reply(id, [call('set_plan', { tasks: ['Página'] }), call('write_file', { path: 'index.html', content: 'A A' }), call('replace_in_file', { path: 'index.html', old_text: 'A', new_text: 'X' })]) : reply(id, endCalls()) }, () => {});
    await runner.run(); expect(runner.project.files['index.html']).toBe('A A');
  });
  test('all APIs exhausted waits with checkpoint instead of claiming success', async () => {
    const project = start(); project.files = { 'existing.ts': 'keep' };
    const runner = new CodeAssistantRunner(project, { available: async () => providers, complete: async () => { throw new Error('HTTP 429'); } }, () => {});
    await runner.run(); expect(runner.project.status).toBe('waiting'); expect(runner.project.files['existing.ts']).toBe('keep'); expect(runner.project.turn).toBe(2);
  });
  test('missing/removed providers are not silently replaced outside the selected queue', async () => {
    const runner = new CodeAssistantRunner(start(), { available: async () => [{ id: 'c', enabled: true, name: 'out of queue' }], complete: async () => { throw new Error('Should not request'); } }, () => {});
    await runner.run(); expect(runner.project.status).toBe('waiting'); expect(runner.project.turn).toBe(0);
  });
  test('text-only model switches to another executable assistant', async () => {
    const attempts: string[] = [];
    const runner = new CodeAssistantRunner(start(), { available: async () => providers, complete: async (id) => {
      attempts.push(id); return id === 'a' ? { providerId: id, model: id, message: { role: 'assistant', content: 'Here is how you should code...' } } : reply(id, [call('set_plan', { tasks: ['Página'] }), call('write_file', { path: 'index.html', content: 'Done' }), ...endCalls()]);
    } }, () => {});
    await runner.run(); expect(attempts).toEqual(['a', 'b']); expect(runner.project.status).toBe('review');
  });
  test('budget counts unsuccessful API attempts and prevents unlimited paid retries', async () => {
    const runner = new CodeAssistantRunner(start(1), { available: async () => providers, complete: async () => { throw new Error('limit'); } }, () => {});
    await runner.run(); expect(runner.project.status).toBe('paused'); expect(runner.project.turn).toBe(1);
  });
  test('disabled failover never tries the second assistant', async () => {
    const ids: string[] = [];
    const runner = new CodeAssistantRunner(start(), { available: async () => providers, autoFailoverEnabled: () => false,
      complete: async (id) => { ids.push(id); throw new Error('limit'); } }, () => {});
    await runner.run(); expect(ids).toEqual(['a']);
  });
  test('complete requires actual files and a completed plan', async () => {
    const runner = new CodeAssistantRunner(start(1), { available: async () => providers, complete: async (id) => reply(id, [call('project_complete', { summary: 'I am done' })]) }, () => {});
    await runner.run(); expect(runner.project.status).toBe('paused'); expect(runner.project.summary).toBe('');
  });
  test('tool arguments truncated by token limit cannot partially change files', async () => {
    const runner = new CodeAssistantRunner(start(1), { available: async () => providers, complete: async (id) => ({ ...reply(id, [call('write_file', { path: 'a.ts', content: 'bad' })]), finishReason: 'length' }) }, () => {});
    await runner.run(); expect(runner.project.files).toEqual({});
  });
  test('new requested changes extend the plan without erasing finished tasks or files', async () => {
    const project = start(); project.files = { 'index.html': 'First version' };
    project.tasks = [{ id: 'task-1', title: 'Primeira versão', status: 'completed' }];
    project.goal += '\nAlteração solicitada: atualizar a página.';
    const runner = new CodeAssistantRunner(project, { available: async () => providers, complete: async (id) => reply(id, [
      call('add_tasks', { tasks: ['Atualizar página'] }),
      call('replace_in_file', { path: 'index.html', old_text: 'First', new_text: 'Second' }),
      call('set_task_status', { id: 'task-2', status: 'completed' }),
      call('project_complete', { summary: 'Alteração implementada; revisão pendente.' }),
    ]) }, () => {});
    await runner.run(); expect(runner.project.status).toBe('review');
    expect(runner.project.files['index.html']).toBe('Second version');
    expect(runner.project.tasks[0]).toEqual(project.tasks[0]); expect(runner.project.tasks).toHaveLength(2);
  });
  test('ZIP exports actual textual project files with UTF8 metadata', async () => {
    const blob = buildZipBlob([{ path: 'src/main.ts', content: 'export const nome = "Sorvetes";' }]);
    const raw = new Uint8Array(await blob.arrayBuffer()), view = new DataView(raw.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50); expect(view.getUint16(6, true)).toBe(0x0800);
    expect(new TextDecoder().decode(raw)).toContain('Sorvetes'); expect(new DataView(raw.buffer, raw.length - 22).getUint32(0, true)).toBe(0x06054b50);
  });
});
