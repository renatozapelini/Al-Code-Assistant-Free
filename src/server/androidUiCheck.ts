// Controlled verification: native Java HTTP engine + real mobile-sized Chromium UI.
// No real credentials, account actions, phone installation, or EXE generation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDER_PRESETS } from './providerPresets.ts';
import { CodeAssistantRunner, createCodeProject, type CodeProject } from '../utils/codeAssistant.ts';
import { createAssistantTransport } from '../utils/assistantTransport.ts';

const root = path.resolve(import.meta.dir, '../..');
const checks: string[] = [], failures: string[] = [], captures: string[] = [];
const layouts: any[] = [];
function passed(label: string) { checks.push(label); console.log(`PASS ${label}`); }
const jdk = 'C:/Users/Eskimo/AppData/Local/android-toolchain/jdk17/jdk-17.0.21+9/bin';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'android-ui-controlled-'));
const screenshots = path.join(root, '.android-build', 'verification', new Date().toISOString().replace(/[:.]/g, '-'));
let java: ReturnType<typeof Bun.spawn> | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let chrome: ReturnType<typeof Bun.spawn> | undefined;
let socket: WebSocket | undefined;
try {
const classes = path.join(temp, 'classes'); fs.mkdirSync(classes);
fs.mkdirSync(screenshots, { recursive: true });
const presets = path.join(temp, 'provider-presets.json'); fs.writeFileSync(presets, JSON.stringify(PROVIDER_PRESETS));
const driver = path.join(temp, 'NativeUiDriver.java');
// Same policy as HubApplication; this tests the UI under the native restrictions,
// but does not substitute for Android WebView/device verification.
const securityMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;
fs.writeFileSync(driver, `package com.qoder2api.hub;
import java.io.*;
import java.net.*;
import java.security.cert.Certificate;
import javax.net.ssl.HttpsURLConnection;
import static com.qoder2api.hub.Json.*;
public class NativeUiDriver {
 public static void main(String[] args) throws Exception {
  HubState state = new HubState(new File(args[0]), list(parse(HubState.read(new File(args[1]), 1000000))));
  final File dist = new File(args[2]);
  // Real updater/parser/cache, controlled EMPTY release list, never a fake published APK.
  AppUpdates updates = new AppUpdates(() -> new HttpsURLConnection(new URL(AppUpdates.RELEASES_URL)) {
   public void connect() {} public void disconnect() {} public boolean usingProxy() { return false; }
   public String getCipherSuite() { return "fixture-only"; }
   public Certificate[] getLocalCertificates() { return null; }
   public Certificate[] getServerCertificates() { return null; }
   public int getResponseCode() { return 200; }
   public String getContentType() { return "application/json"; }
   public long getContentLengthLong() { return 2; }
   public InputStream getInputStream() { return new ByteArrayInputStream(new byte[]{91,93}); }
  }, System::currentTimeMillis);
  Gateway gateway = new Gateway(state, new Gateway.AssetSource() {
   public InputStream open(String asset) throws IOException {
    String relative = asset.startsWith("www/") ? asset.substring(4) : asset;
    File f = new File(dist, relative);
    if (!f.getCanonicalPath().startsWith(dist.getCanonicalPath()+File.separator)) throw new IOException("Invalid asset");
    if (!asset.endsWith(".html")) return new FileInputStream(f);
    byte[] bytes; try (InputStream input = new FileInputStream(f)) { bytes = Gateway.readBounded(input, 4*1024*1024); }
    String html = new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
    int head = html.indexOf("<head>"); if (head < 0) throw new IOException("Missing trusted head");
    String secured = html.substring(0, head+6) + ${JSON.stringify(securityMeta)} + html.substring(head+6);
    return new ByteArrayInputStream(secured.getBytes(java.nio.charset.StandardCharsets.UTF_8));
   }
  }, updates);
  System.out.println("READY "+gateway.start()+" "+gateway.sessionToken()); System.out.flush();
  System.in.read(); gateway.stop();
 }
}`);

function assert(value: unknown, label: string): asserts value { if (!value) throw new Error(label); }
async function run(cmd: string[]) {
  const child = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit) throw new Error(`${path.basename(cmd[0])}: ${err || out}`);
  return out;
}
const source = path.join(root, 'src/server/android-native/java/com/qoder2api/hub');
await run([path.join(jdk, 'javac.exe'), '--release', '8', '-encoding', 'UTF-8', '-d', classes,
  ...['Json', 'HubState', 'Protocol', 'ExternalCatalog', 'AppUpdates', 'Gateway'].map(n => path.join(source, `${n}.java`)), driver]);
passed('javac Java 8 sources, including AppUpdates.java');
const stateDir = path.join(temp, 'state'); fs.mkdirSync(stateDir);
const discoveryModel = 'fixture/controlled-coder:free';
const discoveryFixture = { ok: true, discovered: [{ id: 'fixture-openrouter', provider: 'openrouter',
  name: 'OpenRouter (fixture controlada)', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: discoveryModel,
  protocol: 'openai', source: 'fixture-local', requiresKey: true, canAutoAdd: false, alreadyConfigured: false,
  contextLength: 32000, description: 'Fixture local; não comprova disponibilidade de modelo real.' }], sourcesChecked: ['fixture-local'], errors: [] };
// Native public catalog cache prevents ModelsPanel's automatic refresh from querying real providers.
fs.writeFileSync(path.join(stateDir, 'external-catalog.json'), JSON.stringify({ version: 1, providers: {
  openrouter: { models: [{ key: 'external:fixture-openrouter', id: discoveryModel, modelName: discoveryModel,
    displayName: 'Modelo controlado OpenRouter', realm: 'intl', availableRealms: [], source: 'openrouter', provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai', pricing: { prompt: 0, completion: 0, currency: 'USD', unit: 'token' },
    supportsTools: true, maxInputTokens: 32000, maxOutputTokens: 2048, enable: true, updatedAt: Date.now() }], status: { updatedAt: Date.now() } },
  github: { models: [], status: { attemptedAt: Date.now(), error: 'Fixture controlada: catálogo GitHub indisponível.' } },
}, manual: [] }));
let cspProbeRequests = 0;
let upstreamRequests = 0;
const toolCalls: string[] = [];
const completionRequests: Array<{ route: 'A' | 'B'; messages: Array<{ role: string; content?: string }> }> = [];
const blueprintRequests: Array<Array<{ role: string; content?: string }>> = [];
const blueprintFixture = '# Pré-script: estoque offline\n\nINTEGRAÇÃO CONTROLADA, SEM IA REAL.\n\n## Objetivo\nCriar estoque offline com entradas e saídas, alerta de estoque baixo e exportação CSV.\n\n## Plano\n1. Criar página index.html.\n2. Guardar dados localmente.\n3. Validar entradas, saídas e CSV.\n\n## Critérios de aceite\nNão permitir estoque negativo; preservar dados; revisar exportação.\n\n## Prompt final\nATUE COMO ENGENHEIRO SÊNIOR. Implemente o estoque offline com CSV e alertas. Preserve arquivos, tarefas e checkpoints ao passar o trabalho a outra API. Não invente testes executados.\n\n'
  + 'Restrição controlada: preserve todos os requisitos, arquivos e tarefas; deixe testes e compilação para revisão humana.\n'.repeat(120)
  + '\nFIM DO CONTEXTO INTEGRAL — fixture local.';
const upstreamServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  upstreamRequests++;
  const url = new URL(req.url);
  if (url.pathname === '/discovery') return Response.json(discoveryFixture);
  if (url.pathname === '/csp-probe') { cspProbeRequests++; return new Response('Unexpected cross-origin request'); }
  if (url.pathname.endsWith('/models')) return Response.json({ data: [] });
  assert(req.method === 'POST' && /^\/[ab]\/v1\/chat\/completions$/.test(url.pathname), `Unexpected fixture request ${req.method} ${url.pathname}`);
  const first = url.pathname.startsWith('/a/');
  const body = await req.json() as { tools?: unknown[]; messages: Array<{ role: string; content?: string }> };
  if (body.tools?.length) completionRequests.push({ route: first ? 'A' : 'B', messages: body.messages });
  else blueprintRequests.push(body.messages);
  if (!body.tools?.length) return Response.json({ id: 'fixture-blueprint', model: 'fixture-planner', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content:
    blueprintFixture } }], usage: { prompt_tokens: 10, completion_tokens: 30 } });
  toolCalls.push(first ? 'A' : 'B');
  if (first && body.messages.some(m => m.role === 'tool')) return Response.json({ error: { message: 'TESTE CONTROLADO: sem saldo' } }, { status: 402 });
  const calls: Array<[string, object]> = first ? [
    ['set_plan', { tasks: ['Implementar página de estoque'] }],
    ['write_file', { path: 'index.html', content: '<!doctype html><html><meta charset="utf-8"><h1>Estoque iniciado por A</h1></html>' }],
  ] : body.messages.at(-1)?.role === 'tool' && body.messages.at(-1)?.content?.includes('Estoque iniciado por A') ? [
    ['replace_in_file', { path: 'index.html', old_text: 'iniciado por A', new_text: 'continuado por B' }],
    ['set_task_status', { id: 'task-1', status: 'completed' }],
    ['project_complete', { summary: 'Teste controlado: B continuou o arquivo de A; revisão humana pendente.' }],
  ] : [
    ['read_file', { path: 'index.html' }],
  ];
  return Response.json({ id: crypto.randomUUID(), model: first ? 'fixture-a-coder' : 'fixture-b-coder', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: calls.map(([name, args], i) => ({ id: `fixture_${first ? 'a' : 'b'}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }], usage: { prompt_tokens: 10, completion_tokens: 12 } });
} });
upstream = upstreamServer;
const javaProcess = Bun.spawn([path.join(jdk, 'java.exe'), '-cp', classes, 'com.qoder2api.hub.NativeUiDriver', path.join(temp, 'state'), presets, path.join(root, 'dist')], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
java = javaProcess;
  const ready = await Promise.race([
    (async () => { const r = javaProcess.stdout.getReader(); let text = ''; while (true) { const v = await r.read(); if (v.done) throw new Error('Native engine exited before ready'); text += new TextDecoder().decode(v.value); const match = /READY (\d+) (\S+)/.exec(text); if (match) { r.releaseLock(); return { port: Number(match[1]), token: match[2] }; } } })(),
    javaProcess.exited.then(async code => { throw new Error(`Native Java exit ${code}: ${await new Response(javaProcess.stderr).text()}`); }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Native startup timeout')), 20000)),
  ]);
  const base = `http://127.0.0.1:${ready.port}`;
  const apiFetch = (url: string, init?: RequestInit) => { const h = new Headers(init?.headers); h.set('X-App-Session', ready.token); return fetch(`${base}${url}`, { ...init, headers: h }); };
  assert((await apiFetch('/health')).ok, 'Native health');
  for (const url of ['/v1/chat/completions', '/v1/messages', '/api/hub/overview', '/api/app/accounts/export']) assert((await apiFetch(url)).status === 404, `Legacy route must be404 ${url}`);
  assert((await fetch(`${base}/api/app/overview`)).status === 401, 'Native session secret required');
  assert(ready.port === 8790, 'Native gateway must use port 8790, never change origin or kill another listener');
  const initialOverview = await (await apiFetch('/api/app/overview')).json() as { providers: unknown[] };
  assert(initialOverview.providers.length === 0, 'Empty API scenario must run before any provider is seeded');
  const updates = await (await apiFetch('/api/app/updates')).json() as { ok: boolean; available: boolean; downloadUrl?: string; error?: string };
  assert(!updates.ok && updates.error === 'empty_releases' && !updates.available && !updates.downloadUrl, 'Empty release fixture must report no verified release, never a fabricated APK');
  const ids: string[] = [];

  chrome = Bun.spawn(['C:/Program Files/Google/Chrome/Application/chrome.exe', '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'chrome')}`, 'about:blank'], { stdout: 'pipe', stderr: 'pipe' });
  const endpoint = await Promise.race([
    (async () => { const r = (chrome!.stderr as ReadableStream<Uint8Array>).getReader(); let text = ''; while (true) { const v = await r.read(); if (v.done) throw new Error('Chromium failed to start'); text += new TextDecoder().decode(v.value); const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text); if (m) { r.releaseLock(); return m[1]; } } })(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Chromium startup timeout')), 20000)),
  ]);
  socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => { socket!.addEventListener('open', () => resolve(), { once: true }); socket!.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true }); });
  const browserExceptions: string[] = [];
  socket.addEventListener('message', e => { const msg = JSON.parse(String(e.data)); if (msg.method === 'Runtime.exceptionThrown') browserExceptions.push(msg.params.exceptionDetails?.text || 'Browser exception'); });
  let seq = 0; const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  socket.addEventListener('message', e => { const msg = JSON.parse(String(e.data)); if (msg.id) { const request = waiting.get(msg.id); waiting.delete(msg.id); if (msg.error) request?.reject(new Error(msg.error.message)); else request?.resolve(msg.result); } });
  const cdp = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const browserTargets = await cdp('Target.getTargets');
  const target = browserTargets.targetInfos.find((t: any) => t.type === 'page'); assert(target, 'Chromium page');
  const { sessionId } = await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const page = (method: string, params: object = {}) => cdp(method, params, sessionId);
  await page('Page.enable');
  await page('Runtime.enable');
  const interceptionErrors: string[] = [], externalRequests: string[] = [];
  const interceptions = new Set<Promise<void>>();
  let discoveryIntercepts = 0, providerPosts = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.sessionId !== sessionId || message.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = message.params;
    const task = (async () => {
      try {
        const url = new URL(request.url);
        if (url.origin !== base) {
          externalRequests.push(`${request.method} ${url.origin}${url.pathname}`);
          await page('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
          return;
        }
        // Discovery has no native route yet. Intercept only the local UI request;
        // support the current POST alias as well as the intended GET route.
        if ((url.pathname === '/api/app/discover-ai' && request.method === 'GET')
          || (url.pathname === '/api/app/providers/discover' && request.method === 'POST')) {
          discoveryIntercepts++;
          await page('Fetch.fulfillRequest', { requestId, responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
            body: Buffer.from(JSON.stringify(discoveryFixture)).toString('base64') });
          return;
        }
        if (url.pathname === '/api/app/assistant/complete') {
          const body = JSON.parse(request.postData || '{}');
          const selected = body.assistant_provider_ids;
          assert(Array.isArray(selected) && selected.length > 0 && selected.every((id: string) => ids.includes(id)), 'Only local fixture A/B may receive assistant calls');
        }
        assert(!/\/providers\/[^/]+\/test$/.test(url.pathname) && url.pathname !== '/api/app/providers/discover/add', 'Never test real endpoints or auto-add discovered providers');
        if (request.method === 'POST' && ['/api/app/providers', '/api/app/providers/batch'].includes(url.pathname)) providerPosts++;
        await page('Fetch.continueRequest', { requestId });
      } catch (error) {
        interceptionErrors.push(error instanceof Error ? error.message : String(error));
        await page('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
      }
    })();
    interceptions.add(task);
    void task.then(() => interceptions.delete(task));
  });
  await page('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  const visibleSource = `(el)=>{
    if(!el || !el.getClientRects().length)return false;
    for(let node=el;node;node=node.parentElement){
      const style=getComputedStyle(node);
      if(node.hidden || style.display==='none' || style.visibility==='hidden' || style.visibility==='collapse' || Number(style.opacity)===0)return false;
      if(node.tagName==='DETAILS' && !node.open){
        const summary=[...node.children].find(child=>child.tagName==='SUMMARY');
        if(node!==el && (!summary || !summary.contains(el)))return false;
      }
    }
    const rect=el.getBoundingClientRect();return rect.width>0 && rect.height>0;
  }`;
  await page('Page.addScriptToEvaluateOnNewDocument', { source: `window.__uiVisible=${visibleSource};window.AndroidApp={getSessionToken:()=>${JSON.stringify(ready.token)},getReminderSettings:()=>JSON.stringify({enabled:false,notificationPermission:false,scheduled:false}),setReminderEnabled:(enabled)=>JSON.stringify({enabled,notificationPermission:true,scheduled:enabled}),exportProjectZip:(base64,filename)=>{window.__fixtureExport={base64,filename};return JSON.stringify({ok:true})}};` });
  const evaluate = async (expression: string) => {
    const result = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (expression: string) => {
    await evaluate(`new Promise((resolve,reject)=>{const until=Date.now()+15000;const timer=setInterval(()=>{try{if(${expression}){clearInterval(timer);resolve(true)}else if(Date.now()>until){clearInterval(timer);reject(new Error('UI timeout: '+${JSON.stringify(expression)}))}}catch(e){clearInterval(timer);reject(e)}},50)})`);
  };
  const settle = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
  const shown = (selector: string) => `window.__uiVisible(document.querySelector(${JSON.stringify(selector)}))`;
  const clickText = (text: string, scope = 'document') => evaluate(`(()=>{const button=[...${scope}.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(text)})&&window.__uiVisible(b));if(!button)throw new Error('Visible button missing: '+${JSON.stringify(text)});if(button.disabled)throw new Error('Button disabled: '+${JSON.stringify(text)});button.click();return true})()`);
  const nav = async (label: string) => {
    await evaluate(`(()=>{const bars=[...document.querySelectorAll('nav[aria-label="Navegação móvel"],nav[aria-label="Navegação principal"]')];const button=bars.flatMap(bar=>[...bar.querySelectorAll('button')]).find(b=>window.__uiVisible(b)&&b.textContent.includes(${JSON.stringify(label)}));if(!button)throw new Error('Navigation missing: '+${JSON.stringify(label)});button.click()})()`);
    await settle();
  };
  const area = async (label: string) => {
    await clickText(label, 'document.querySelector(\'nav[aria-label="Áreas do projeto"]\')');
    await waitFor(`document.querySelector('nav[aria-label="Áreas do projeto"] button[aria-pressed="true"]').textContent.trim()===${JSON.stringify(label)}`);
  };
  const selectProject = async (name: string) => {
    await clickText(name, 'document.querySelector(\'nav[aria-label="Selecionar projeto"]\')');
    await waitFor(shown('[aria-label="Chat do projeto"]'));
    assert(await evaluate("document.querySelector('nav[aria-label=\"Áreas do projeto\"] button[aria-pressed=\"true\"]').textContent.trim()==='Chat'"), 'Opening a project must default to its Chat area');
  };
  const setField = (selector: string, value: string) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!window.__uiVisible(el))throw new Error('Visible input missing: '+${JSON.stringify(selector)});const prototype=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true}));return true})()`);
  const storedProjects = async (): Promise<CodeProject[]> => evaluate("JSON.parse(localStorage.getItem('hub-code-projects-v1')||'[]')");
  const savedProject = async (name: string) => {
    const project = (await storedProjects()).find(project => project.name === name);
    assert(project, `Saved project missing: ${name}`); return project;
  };
  const capture = async (name: string, selector?: string) => {
    await evaluate(selector ? `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!window.__uiVisible(el))throw new Error('Screenshot target hidden');const y=el.getBoundingClientRect().top+window.scrollY;window.scrollTo(0,Math.max(0,y-115))})()` : 'window.scrollTo(0,0)');
    await settle();
    const data = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const filename = path.join(screenshots, name); fs.writeFileSync(filename, Buffer.from(data.data, 'base64')); captures.push(filename);
  };
  let viewportWidth = 390;
  const viewport = async (width: number) => {
    viewportWidth = width;
    await page('Emulation.setDeviceMetricsOverride', { width, height: width === 844 ? 390 : 844, deviceScaleFactor: 1, mobile: true,
      screenOrientation: { type: width === 844 ? 'landscapePrimary' : 'portraitPrimary', angle: width === 844 ? 90 : 0 } });
    await evaluate('window.scrollTo(0,0)'); await settle();
  };
  const checkLayout = async (label: string) => {
    await settle();
    const layout = await evaluate(`(()=>{
      const viewport=window.innerWidth,offenders=[];let inspected=0,localScrollDescendants=0;
      for(const el of document.querySelectorAll('body *')){
        if(!window.__uiVisible(el))continue;
        // Check the scroll container's own box, but not its intentionally scrollable
        // contents. Hidden/clip overflow NEVER exempts descendants from inspection.
        let local=false;
        for(let parent=el.parentElement;parent&&parent!==document.body&&parent!==document.documentElement;parent=parent.parentElement){
          if(/^(auto|scroll)$/.test(getComputedStyle(parent).overflowX)&&parent.scrollWidth>parent.clientWidth+1){local=true;break}
        }
        if(local){localScrollDescendants++;continue}
        inspected++;
        const rect=el.getBoundingClientRect();
        if(rect.left < -1 || rect.right > viewport+1)offenders.push({tag:el.tagName,id:el.id,aria:el.getAttribute('aria-label'),text:el.textContent.trim().slice(0,80),left:rect.left,right:rect.right,width:rect.width,overflowX:getComputedStyle(el).overflowX});
      }
      return {viewport,height:window.innerHeight,scroll:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),inspected,localScrollDescendants,offenders};
    })()`);
    layouts.push({ label, ...layout });
    assert(layout.viewport === viewportWidth, `${label}: viewport must equal emulated width ${viewportWidth}, got ${layout.viewport}`);
    assert(layout.scroll <= layout.viewport + 1 && layout.offenders.length === 0, `${label}: horizontal overflow ${JSON.stringify(layout)}`);
    passed(`Layout ${label} ${layout.viewport}x${layout.height}: scrollWidth and all visible element bounds`);
  };
  const exportVisible = () => evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Exportar projeto')&&window.__uiVisible(b))");
  const assertHome = async () => {
    await waitFor("[...document.querySelectorAll('h1')].some(h=>window.__uiVisible(h)&&h.textContent.trim()==='Meus projetos')");
    const home = await evaluate(`(()=>{const h=[...document.querySelectorAll('h1')].find(h=>window.__uiVisible(h)&&h.textContent.trim()==='Meus projetos');return {shortcuts:[...h.closest('section').querySelectorAll('button')].filter(window.__uiVisible).map(b=>b.textContent.trim()),bottom:[...document.querySelectorAll('nav[aria-label="Navegação móvel"] button')].map(b=>b.querySelector(':scope > span').textContent.trim())}})()`);
    assert(home.shortcuts.length === 2 && home.shortcuts.includes('Criar pré-prompt') && home.shortcuts.some((label: string) => label === 'Novo projeto' || label === 'Fechar formulário'), 'Home must offer exactly two project shortcuts');
    assert(home.bottom.join('|') === 'Projetos|Chat|APIs IA|Opções', 'Mobile bottom navigation must have exactly four current destinations');
    assert(!await evaluate(shown('[aria-label="Execução do projeto"]')), 'Reload/home must not expose a project workspace');
  };
  const configureTeam = async () => {
    await area('Equipe');
    for (const name of ['IA A (teste controlado)', 'IA B (teste controlado)']) {
      await evaluate(`(()=>{const section=document.querySelector('section[aria-label="Equipe de assistentes"]');const label=[...section.querySelectorAll('label')].find(l=>l.textContent.includes(${JSON.stringify(name)}));const input=label?.querySelector('input[type="checkbox"]');if(!input||input.disabled)throw new Error('Available fixture team missing');if(!input.checked)input.click()})()`);
      await settle();
    }
    await clickText('Salvar equipe', 'document.querySelector(\'section[aria-label="Equipe de assistentes"]\')');
    await settle();
  };
  await viewport(390);
  await page('Page.navigate', { url: base });
  await assertHome();
  await checkLayout('Home without APIs'); await capture('01-home-mobile.png');
  assert(await evaluate("document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]').content.includes(\"connect-src 'self'\")"), 'Native CSP must be present');
  const cspBlocked = await evaluate(`fetch(${JSON.stringify(`${upstreamServer.url.origin}/csp-probe`)}).then(()=>false,()=>true)`);
  assert(cspBlocked && cspProbeRequests === 0 && externalRequests.length === 0, 'CSP must block cross-origin requests before networking');
  passed('Native CSP, secret session, 8790 origin and empty release fixture');

  // This must happen before seeding: a blank folder is useful without any API.
  const emptyName = 'Pasta sem APIs';
  const beforeEmpty = upstreamRequests;
  await clickText('Novo projeto'); await waitFor(shown('#code-create-form'));
  assert(await evaluate("document.querySelectorAll('#code-create-form input[type=checkbox]').length===0"), 'No provider checkboxes before seed');
  await setField('#code-create-form input:not([type])', emptyName);
  await setField('#code-create-form textarea', 'Guardar a ideia sem chamadas de IA');
  await evaluate("document.querySelector('#code-create-form').requestSubmit()");
  await waitFor(shown('[aria-label="Chat do projeto"]'));
  const empty = await savedProject(emptyName);
  assert(empty.status === 'idle' && empty.turn === 0 && empty.providerIds.length === 0 && Object.keys(empty.files).length === 0, 'Empty folder must be saved idle without an API team');
  assert(await evaluate("[...document.querySelectorAll('section[aria-label=\"Execução do projeto\"] button')].find(b=>b.textContent.includes('Iniciar assistentes')).disabled"), 'Start must be disabled without a team');
  assert(await evaluate("document.querySelector('nav[aria-label=\"Áreas do projeto\"] button[aria-pressed=\"true\"]').textContent.trim()==='Chat'"), 'Creating a folder must open Chat by default');
  assert(!await exportVisible(), 'Project export must be hidden outside Files');
  await checkLayout('Empty folder Chat'); await capture('02-chat-pasta-sem-apis-mobile.png');
  await area('Arquivos');
  assert(await exportVisible() && await evaluate("[...document.querySelectorAll('button')].find(b=>window.__uiVisible(b)&&b.textContent.includes('Exportar projeto')).disabled"), 'Empty Files must expose a disabled ZIP action');
  await nav('Projetos'); await assertHome();
  await page('Page.reload'); await assertHome();
  await selectProject(emptyName);
  assert(JSON.stringify(await savedProject(emptyName)) === JSON.stringify(empty), 'Reload must preserve the entire empty folder checkpoint');
  assert(upstreamRequests === beforeEmpty && toolCalls.length === 0 && blueprintRequests.length === 0, 'Creating/reloading a folder must make zero upstream API calls');
  passed('Empty API folder: idle, no calls, disabled Start, default Chat, reload');

  for (const [route, name] of [['a', 'IA A (teste controlado)'], ['b', 'IA B (teste controlado)']]) {
    const res = await apiFetch('/api/app/providers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'custom', name, baseUrl: `${upstreamServer.url.origin}/${route}/v1`, apiKey: 'TEST-NOT-REAL', defaultModel: `fixture-${route}-coder`, protocol: 'openai' }) });
    const data = await res.json() as { provider: { id: string } }; assert(res.ok && data.provider?.id, 'Add native fixture provider'); ids.push(data.provider.id);
  }
  const calls: string[] = [];
  const transport = createAssistantTransport(apiFetch);
  const project = createCodeProject({ name: 'Verificação nativa', goal: 'Criar estoque offline', providerIds: ids });
  let checkpoint = project;
  const runner = new CodeAssistantRunner(project, { ...transport, complete: async (providerId, messages, signal) => { calls.push(providerId); return transport.complete(providerId, messages, signal); } }, p => { checkpoint = p; });
  await runner.run();
  assert(checkpoint.status === 'review' && checkpoint.files['index.html'].includes('continuado por B'), 'Native runner must hand off and preserve files');
  assert(calls.join(',') === [ids[0], ids[0], ids[1], ids[1]].join(',') && toolCalls.join(',') === 'A,A,B,B', `Native handoff must remain explicit A,A,B,B with B reading before editing; got ${calls.join(',')} / ${toolCalls.join(',')}`);
  const reset = await apiFetch(`/api/app/providers/${ids[0]}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'IA A (teste controlado)' }) });
  assert(reset.ok, 'Clear fixture cooldown before independent UI scenario');
  passed('Independent native runner A,A,B preserves files and review checkpoint');

  await page('Page.reload'); await assertHome();
  await waitFor("document.body.textContent.includes('IA A (teste controlado)')");
  await selectProject(emptyName);
  const beforeTeam = upstreamRequests;
  await configureTeam();
  const configured = await savedProject(emptyName);
  assert(configured.providerIds.join(',') === ids.join(',') && configured.turn === 0 && Object.keys(configured.files).length === 0 && configured.goal === empty.goal, 'A team may be added later without discarding folder context');
  assert(upstreamRequests === beforeTeam, 'Saving a team must not initiate assistant calls');
  await area('Chat');
  assert(await evaluate("![...document.querySelectorAll('section[aria-label=\"Execução do projeto\"] button')].find(b=>b.textContent.includes('Retomar trabalho')).disabled"), 'Start/resume must become available after selecting the team');
  passed('Team selected later, preserved empty folder, execution remains manual');

  await nav('Projetos'); await assertHome();
  await clickText('Criar pré-prompt'); await waitFor(shown('#script-title'));
  const idea = 'Entradas e saídas de estoque, alerta baixo e exportação CSV';
  const notes = 'Funcionar offline, não permitir estoque negativo';
  await setField('#script-title', 'Estoque offline');
  await setField('#script-idea-input', idea);
  await setField('#script-notes', notes);
  const targets = await evaluate("({platform:document.querySelector('#script-platform').value,assistant:document.querySelector('#script-assistant').value})");
  await checkLayout('Pre-script ideas'); await capture('03-pre-script-mobile.png', 'form[aria-label="Ideias para o pré-script"]');
  const beforeGeneration = toolCalls.length;
  await evaluate("document.querySelector('#script-title').closest('form').requestSubmit()");
  await waitFor(`document.querySelector('#pre-script-result').value===${JSON.stringify(blueprintFixture)}`);
  assert(toolCalls.length === beforeGeneration && Number(blueprintRequests.length) === 1, 'Pre-prompt generation must not run project tools');
  const synthesisContext = blueprintRequests[0].map(message => message.content || '').join('\n');
  for (const requirement of ['Estoque offline', idea, notes, targets.platform, targets.assistant]) assert(synthesisContext.includes(requirement), `Synthesis must receive full idea context: ${requirement}`);
  const createFromPromptDisabled = () => evaluate("[...document.querySelectorAll('section[aria-label=\"Resultado e revisão humana\"] button')].find(b=>b.textContent.includes('Criar projeto')).disabled");
  const approvePrompt = () => evaluate("(()=>{const review=document.querySelector('section[aria-label=\"Resultado e revisão humana\"] input[type=checkbox]');if(!review||review.disabled)throw new Error('Human review approval missing');if(!review.checked)review.click()})()");
  assert(await createFromPromptDisabled(), 'An unreviewed pre-prompt must not create a project');
  await approvePrompt(); await settle();
  assert(!await createFromPromptDisabled(), 'Human approval must allow forwarding, not execution');
  const reviewedBlueprint = `${blueprintFixture}\n\nREVISÃO HUMANA: manter todos os critérios acima e validar CSV manualmente.`;
  await setField('#pre-script-result', reviewedBlueprint);
  assert(await createFromPromptDisabled(), 'Editing a previously approved prompt must require a new human review');
  await approvePrompt(); await settle();
  await checkLayout('Pre-script human review'); await capture('04-prompt-gerado-mobile.png', 'section[aria-label="Resultado e revisão humana"]');
  await clickText('Criar projeto com este pré-script'); await waitFor(shown('#code-create-form'));
  const blueprintValue = () => evaluate("[...document.querySelectorAll('#code-create-form textarea')].find(t=>t.closest('label')?.textContent.includes('Blueprint do projeto')).value");
  assert(await blueprintValue() === reviewedBlueprint, 'The complete reviewed blueprint must be forwarded without truncation');
  await nav('APIs IA');
  await waitFor("[...document.querySelectorAll('h1')].some(h=>window.__uiVisible(h)&&h.textContent.trim()==='APIs de IA e chaves')");
  await nav('Projetos'); await waitFor(shown('#code-create-form'));
  assert(await blueprintValue() === reviewedBlueprint, 'The full reviewed blueprint must survive visiting API management');
  const savedName = 'Estoque da primeira versão';
  await setField('#code-create-form input:not([type])', savedName);
  await setField('#code-create-form textarea', 'Implementar estoque offline com CSV e alertas');
  for (const name of ['IA A (teste controlado)', 'IA B (teste controlado)']) {
    await evaluate(`(()=>{const label=[...document.querySelectorAll('#code-create-form fieldset label')].find(l=>l.textContent.includes(${JSON.stringify(name)}));const input=label?.querySelector('input[type=checkbox]');if(!input||input.disabled)throw new Error('Fixture selection missing');if(!input.checked)input.click()})()`);
    await settle();
  }
  const beforeCreate = upstreamRequests, uiCallStart = toolCalls.length, uiRequestStart = completionRequests.length;
  await evaluate("document.querySelector('#code-create-form').requestSubmit()");
  await waitFor(shown('[aria-label="Chat do projeto"]'));
  const idle = await savedProject(savedName);
  assert(idle.status === 'idle' && idle.blueprint === reviewedBlueprint && idle.providerIds.join(',') === ids.join(',') && idle.turn === 0 && upstreamRequests === beforeCreate, 'Creating the reviewed project must preserve the full context without starting it');
  assert(!await exportVisible(), 'Chat must not expose project ZIP export');
  await clickText('Iniciar assistentes');
  await waitFor("document.querySelector('section[aria-label=\"Execução do projeto\"] [role=status]').textContent==='Aguardando sua validação'");
  await waitFor("![...document.querySelectorAll('section[aria-label=\"Execução do projeto\"] button')].find(b=>b.textContent.includes('Continuar com IA')).disabled");
  const saved = await savedProject(savedName);
  assert(saved.status === 'review' && saved.files['index.html']?.includes('continuado por B') && saved.blueprint === reviewedBlueprint && saved.tasks.some(task => task.status === 'completed'), 'UI blueprint and task/file checkpoint must survive the native handoff');
  assert(toolCalls.slice(uiCallStart).join(',') === 'A,A,B,B', 'UI must independently perform exactly A,A,B,B');
  const uiRequests = completionRequests.slice(uiRequestStart);
  assert(uiRequests.length === 4, 'UI must make exactly four tool-bearing fixture requests');
  for (const request of uiRequests) {
    const system = request.messages.find(message => message.role === 'system')?.content || '';
    assert(system.includes(JSON.stringify(reviewedBlueprint)), `${request.route} must receive the entire reviewed blueprint`);
  }
  const bContext = uiRequests[3].messages.map(message => message.content || '').join('\n');
  assert(bContext.includes('index.html') && bContext.includes('Implementar página de estoque') && bContext.includes('Estoque iniciado por A'), 'B must receive A files, task plan and previous exchanges, not restart');
  assert(saved.events.some(event => event.type === 'handoff' && event.providerId === ids[1]), 'Checkpoint must record the explicit handoff to B');
  await checkLayout('Completed project Chat'); await capture('05-chat-projeto-continuado-mobile.png');
  passed('Full pre-prompt, repeat human review, manual Start, native UI A,A,B,B and task/file handoff');

  assert(!await exportVisible(), 'Completed Chat must still keep export in Files only');
  await area('Arquivos'); await waitFor(shown('#code-file-editor'));
  assert(await evaluate("document.querySelector('#code-file-editor').value") === saved.files['index.html'], 'Files editor must display the checkpoint from B');
  await checkLayout('Completed project Files'); await capture('06-arquivos-mobile.png');
  await clickText('Exportar projeto (ZIP)'); await waitFor('window.__fixtureExport');
  const exported = await evaluate('window.__fixtureExport') as { filename: string; base64: string };
  const zip = Buffer.from(exported.base64, 'base64'), zipFiles: Record<string, string> = {};
  assert(zip.length >= 22 && zip.readUInt32LE(0) === 0x04034b50 && exported.filename.endsWith('.zip'), 'Native bridge export must contain a valid ZIP request');
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    assert(zip.readUInt16LE(offset + 8) === 0 && (zip.readUInt16LE(offset + 6) & 8) === 0, 'Controlled ZIP must use stored entries with explicit sizes');
    const size = zip.readUInt32LE(offset + 18), nameLength = zip.readUInt16LE(offset + 26), extraLength = zip.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    assert(start + size <= zip.length, 'ZIP entry must remain within bounds');
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    assert(!Object.hasOwn(zipFiles, name), 'ZIP must not contain duplicate files');
    zipFiles[name] = zip.subarray(start, start + size).toString('utf8'); offset = start + size;
  }
  assert(Object.keys(zipFiles).length === Object.keys(saved.files).length && Object.entries(saved.files).every(([name, content]) => zipFiles[name] === content), 'ZIP must preserve all checkpoint files and their exact contents');
  const beforeReload = upstreamRequests;
  await page('Page.reload'); await assertHome();
  await selectProject(savedName);
  assert(JSON.stringify(await savedProject(savedName)) === JSON.stringify(saved), 'The complete project checkpoint must remain unchanged after reload');
  assert(!await exportVisible() && upstreamRequests === beforeReload, 'Reload and project selection must default to Chat without resuming calls');
  passed('ZIP preserves exact files; reload returns home; selecting project restores Chat and the full checkpoint');

  const discover = async () => {
    await evaluate("(()=>{const summary=[...document.querySelectorAll('summary')].find(s=>window.__uiVisible(s)&&s.textContent.includes('Descobrir modelos'));if(!summary)throw new Error('Discovery details missing');if(!summary.parentElement.open)summary.click()})()");
    await clickText('Consultar catálogos');
    await waitFor(`document.body.textContent.includes(${JSON.stringify(discoveryModel)})`);
    await settle();
  };
  const signup = PROVIDER_PRESETS.find(preset => preset.id === 'openrouter')?.signupUrl;
  assert(signup && new URL(signup).hostname === 'openrouter.ai', 'Fixture signup must refer to the official OpenRouter preset');
  const assertSignup = async () => {
    assert(await evaluate(`(()=>{const links=[...document.querySelectorAll('#ai-api-key-form a')].filter(a=>window.__uiVisible(a)&&a.href===${JSON.stringify(signup)});return links.length>0&&links.every(a=>a.target==='_self'&&a.textContent.includes('Registrar / obter chave'))})()`), 'OpenRouter registration/key links must use the official URL and _self without account automation');
  };
  await nav('APIs IA'); await waitFor(shown('#ai-api-key-form'));
  const originalKeyId = await evaluate("document.querySelector('#ai-api-key-form input[type=password]').id") as string;
  await setField(`#${originalKeyId}`, 'TEST-TYPED-KEY-NOT-REAL');
  const beforeDiscovery = upstreamRequests, beforeProviderPosts = providerPosts;
  await discover();
  await clickText('Adicionar chave');
  await waitFor("document.activeElement?.matches('#ai-api-key-form input[type=password]')");
  const discoveredKeyId = await evaluate('document.activeElement.id') as string;
  assert(discoveredKeyId !== originalKeyId, 'Adding a different provider must focus a separate password input');
  const focused = await evaluate("(()=>{const input=document.activeElement;const row=input.closest('fieldset').querySelectorAll(':scope > div');return {visible:window.__uiVisible(input),top:input.getBoundingClientRect().top,bottom:input.getBoundingClientRect().bottom,header:document.querySelector('header').getBoundingClientRect().bottom,height:window.innerHeight,provider:input.closest('fieldset > div').querySelector('select').value,model:[...input.closest('fieldset > div').querySelectorAll('input')].find(el=>el.value.includes('fixture/'))?.value}})()");
  assert(focused.visible && focused.top >= focused.header - 1 && focused.bottom <= focused.height - 64 + 1 && focused.provider === 'openrouter' && focused.model === discoveryModel, 'Add key must reveal and focus the OpenRouter password input with the discovered model');
  assert(await evaluate(`document.getElementById(${JSON.stringify(originalKeyId)}).value==='TEST-TYPED-KEY-NOT-REAL'`), 'Adding the discovered provider must preserve the previously typed key');
  await setField(`#${discoveredKeyId}`, 'TEST-OPENROUTER-KEY-NOT-REAL');
  await clickText('Adicionar chave');
  await waitFor(`document.activeElement?.id===${JSON.stringify(discoveredKeyId)}`);
  assert(await evaluate(`document.getElementById(${JSON.stringify(discoveredKeyId)}).value==='TEST-OPENROUTER-KEY-NOT-REAL'&&document.getElementById(${JSON.stringify(originalKeyId)}).value==='TEST-TYPED-KEY-NOT-REAL'`), 'Repeated Add key must preserve both typed keys and reuse the matching draft');
  await assertSignup(); await checkLayout('APIs discovery and focused password form');
  await capture('07-apis-form-mobile.png', '#ai-api-key-form');
  assert(upstreamRequests === beforeDiscovery && providerPosts === beforeProviderPosts && discoveryIntercepts > 0, 'Discovery and Add key must remain local without saving or querying real APIs');
  // Explicitly remove the unrelated draft through the UI before saving only the
  // controlled OpenRouter record. Never test/execute its dummy credential.
  await evaluate(`(()=>{const input=document.getElementById(${JSON.stringify(originalKeyId)});const row=input.closest('fieldset > div');const remove=[...row.querySelectorAll('button')].find(b=>b.textContent.includes('Remover campo'));if(!remove)throw new Error('Draft removal missing');remove.click()})()`);
  await settle();
  await evaluate("document.querySelector('#ai-api-key-form form[aria-label=\"Adicionar chaves de APIs\"]').requestSubmit()");
  await waitFor("[...document.querySelectorAll('button')].some(b=>b.disabled&&b.textContent.trim()==='Já adicionada'&&window.__uiVisible(b))");
  assert(providerPosts > beforeProviderPosts && upstreamRequests === beforeDiscovery, 'Already added status must follow a real local provider POST, with zero real upstream calls');
  const addedOverview = await (await apiFetch('/api/app/overview')).json() as { providers: Array<{ id: string; baseUrl: string; defaultModel: string }> };
  const added = addedOverview.providers.find(provider => provider.baseUrl === discoveryFixture.discovered[0].baseUrl && provider.defaultModel === discoveryModel);
  assert(added, 'The native local provider store must contain the discovered endpoint/model');
  const disable = await apiFetch(`/api/app/providers/${added.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  assert(disable.ok, 'Disable the dummy real-endpoint record before later navigation');
  passed('CDP discovery fixture, focused password, official OpenRouter _self signup, typed-key preservation and local POST Already added');

  await page('Page.reload'); await assertHome();
  const beforeMatrix = upstreamRequests;
  for (const width of [320, 360, 390, 412, 844]) {
    await viewport(width);
    await nav('Projetos'); await assertHome(); await checkLayout('Projetos home');
    await clickText('Novo projeto'); await waitFor(shown('#code-create-form')); await checkLayout('Projetos creation form');
    await clickText('Fechar formulário'); await settle();
    await selectProject(savedName); await checkLayout('Chat');
    for (const label of ['Tarefas', 'Equipe', 'Arquivos', 'Chat']) { await area(label); await checkLayout(`Workspace ${label}`); }
    await nav('APIs IA'); await waitFor(shown('#ai-api-key-form')); await checkLayout('APIs de IA');
    await discover(); await checkLayout('APIs discovery');
    await clickText('OpenRouter');
    await waitFor("document.activeElement?.matches('#ai-api-key-form input[type=password]')");
    await assertSignup(); await checkLayout('APIs password form');
    await nav('Opções');
    await waitFor("[...document.querySelectorAll('h1')].some(h=>window.__uiVisible(h)&&h.textContent.trim()==='Opções')");
    await checkLayout('Opções');
    assert(await evaluate("(()=>{const s=document.querySelector('section[aria-label=\"Atualizações do aplicativo\"]');return window.__uiVisible(s)&&s.textContent.includes('Code Assistants 3.1.0')&&[...s.querySelectorAll('button')].some(b=>window.__uiVisible(b)&&b.textContent.includes('Verificar atualização'))})()"), 'Options must expose the GitHub update panel with the installed version and a manual check button');
    assert(!await evaluate("[...document.querySelectorAll('a')].some(a=>window.__uiVisible(a)&&a.textContent.includes('Baixar novo APK'))"), 'Empty releases must never offer an APK download');
    await clickText('Modelos de IA');
    await waitFor("[...document.querySelectorAll('h1')].some(h=>window.__uiVisible(h)&&h.textContent.trim()==='Multi-IA')");
    await waitFor("[...document.querySelectorAll('button')].some(b=>window.__uiVisible(b)&&b.textContent.includes('Atualizar provedores')&&!b.disabled)");
    await checkLayout('Modelos');
    await nav('Opções'); await clickText('Pré-prompt · detalhar uma ideia');
    await waitFor(shown('#script-title')); await checkLayout('Scripts ideas and human review');
    assert(await evaluate("document.querySelector('#pre-script-result').value") === reviewedBlueprint, 'Pre-script storage must preserve the full human-reviewed result after reload and navigation');
  }
  assert(upstreamRequests === beforeMatrix, 'Layout navigation must not call any upstream provider');
  await viewport(390); await nav('Projetos'); await assertHome(); await capture('08-home-com-projetos-mobile.png');
  await selectProject(savedName); await capture('09-chat-mobile.png');
  await nav('APIs IA'); await waitFor(shown('#ai-api-key-form')); await clickText('OpenRouter');
  await waitFor("document.activeElement?.matches('#ai-api-key-form input[type=password]')");
  await capture('10-apis-form-mobile.png', '#ai-api-key-form');
  await nav('Opções');
  await waitFor("[...document.querySelectorAll('h1')].some(h=>window.__uiVisible(h)&&h.textContent.trim()==='Opções')");
  const updateScope = 'document.querySelector(\'section[aria-label="Atualizações do aplicativo"]\')';
  await waitFor(`(()=>{const s=${updateScope};if(!window.__uiVisible(s))return false;const b=[...s.querySelectorAll('button')].find(b=>b.textContent.includes('Verificar atualização'));return !!b&&!b.disabled})()`);
  await clickText('Verificar atualização', updateScope);
  await waitFor(`(()=>{const s=${updateScope};const p=s.querySelector('p[role="status"]');return window.__uiVisible(s)&&!!p&&p.textContent.trim()!==''&&!p.textContent.includes('Consultando releases')})()`);
  const updateStatus = String(await evaluate(`${updateScope}.querySelector('p[role="status"]').textContent`));
  const updateProbe = await evaluate(`fetch('/api/app/updates',{headers:{'X-App-Session':window.AndroidApp.getSessionToken()}}).then(async r=>({status:r.status,body:(await r.text()).slice(0,400)})).catch(e=>({error:String(e)}))`);
  console.log('UPDATE STATUS:', updateStatus, 'PROBE:', JSON.stringify(updateProbe));
  assert(updateStatus.includes('lista pública de releases está vazia'), `Manual update check must report the empty public release list honestly, got: ${updateStatus}`);
  assert(await evaluate(`(()=>{const s=${updateScope};return s.textContent.includes('Code Assistants 3.1.0')&&s.textContent.includes('renatozapelini/Ai')})()`), 'Update panel must state the installed version and the public GitHub release source');
  assert(!await evaluate("[...document.querySelectorAll('a')].some(a=>window.__uiVisible(a)&&a.textContent.includes('Baixar novo APK'))"), 'Manual update check with empty releases must never fabricate an APK download');
  await checkLayout('Opções GitHub update check');
  await capture('11-opcoes-atualizacao-github-mobile.png', 'section[aria-label="Atualizações do aplicativo"]');
  passed('GitHub update panel in Opções: manual check against the real Java endpoint reports empty releases honestly, no fabricated download');
  await Promise.all([...interceptions]);
  assert(interceptionErrors.length === 0 && externalRequests.length === 0, `Blocked/unexpected network requests: ${JSON.stringify({ interceptionErrors, externalRequests })}`);
  assert(browserExceptions.length === 0, `Unhandled browser exceptions: ${browserExceptions.join(', ')}`);
  assert((await evaluate('navigator.serviceWorker.getRegistrations().then(r=>r.length)')) === 0, 'Native UI must not install a service worker');
  passed('All viewport routes, zero unhandled browser exceptions, zero real API requests, service workers = 0');
  const result = { ok: true, nativeJavaEngine: true, nativeCspReplica: true, noGateway: true, sessionProtected: true, port: 8790,
    emptyApiFolder: true, teamAddedLater: true, preScriptToProject: true, fullReviewedContext: true, explicitHandoff: ['A', 'A', 'B', 'B'],
    checkpointReload: true, reloadHomeThenSelectChat: true, discoveryFixture: true, discoveryIntercepts, signupTarget: '_self',
    typedKeysPreserved: true, alreadyAddedAfterLocalPost: true, githubUpdatePanel: true, githubUpdateCheck: 'empty_releases', mobileWidths: [320, 360, 390, 412, 844], landscapeHeight: 390,
    horizontalOverflow: false, layouts, unhandledBrowserExceptions: 0, serviceWorkers: 0, zipBridge: true, exactZipContents: true,
    realCredentials: false, realApiCalls: false, androidDeviceTested: false, screenshots, captures, checks };
  fs.writeFileSync(path.join(screenshots, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (socket) socket.close();
  if (chrome) { chrome.kill(); await chrome.exited; }
  if (java) { (java.stdin as import('bun').FileSink).end(); java.kill(); await java.exited; }
  upstream?.stop(true);
  fs.rmSync(temp, { recursive: true, force: true });
}
