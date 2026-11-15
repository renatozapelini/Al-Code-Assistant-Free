package com.qoder2api.hub;

import com.sun.net.httpserver.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static com.qoder2api.hub.Json.*;

/** Run with JDK17; no Android device, network service, JUnit or external dependency needed. */
public final class GatewayTest {
    private static int checks;
    private static final String SECRET = "provider-secret-must-not-leak";
    private final HubState state;
    private final Gateway gateway;
    private final File directory;
    private final List<Fake> fakes = new ArrayList<>();
    private GatewayTest() throws Exception {
        directory = Files.createTempDirectory("android-hub-test-").toFile();
        List<Object> presets = arr();
        for (String id : new String[]{"custom", "anthropic", "gemini", "openrouter", "github", "ollama", "lmstudio"}) presets.add(obj("id", id, "name", id, "baseUrl", "http://127.0.0.1:1/v1", "protocol", id.equals("anthropic") ? "anthropic" : "openai", "defaultModel", "configured-model", "requiresKey", true));
        state = new HubState(directory, presets);
        // Discovery/refresh routes are tested offline, using a fresh public cache.
        HubState.atomic(new File(directory, "external-catalog.json"), obj("version", 1, "providers", obj("openrouter", obj("models", arr(ExternalCatalog.model("openrouter", "test:free", "https://openrouter.ai/api/v1", "openai", "openrouter")), "status", obj("updatedAt", System.currentTimeMillis())), "github", obj("models", arr(), "status", obj())), "manual", arr()));
        gateway = new Gateway(state, path -> {
            if (path.equals("www/index.html")) return new ByteArrayInputStream("<!doctype html><div>SPA</div>".getBytes(StandardCharsets.UTF_8));
            if (path.equals("www/assets/app.js")) return new ByteArrayInputStream("console.log('app');".getBytes(StandardCharsets.UTF_8));
            throw new FileNotFoundException(path);
        });
        eq(gateway.start(), 8790, "stable port"); eq(gateway.start(), 8790, "start idempotent");
    }
    private static void check(boolean value, String label) { checks++; if (!value) throw new AssertionError(label); }
    private static void eq(Object actual, Object expected, String label) { check(Objects.equals(actual, expected), label + ": expected " + expected + ", got " + actual); }
    private static final class Result {
        int status; String text; final Map<String,String> headers = new HashMap<>();
        Map<String,Object> json() { return map(parse(text)); }
    }
    private Result request(String method, String path, Object body) throws Exception { return request(method, path, body, obj()); }
    private Result request(String method, String path, Object body, Map<String,Object> override) throws Exception {
        Map<String,String> h = new LinkedHashMap<>(); h.put("Host", "127.0.0.1:8790"); h.put("X-App-Session", gateway.sessionToken()); h.put("Content-Type", "application/json");
        for (Map.Entry<String,Object> e : override.entrySet()) { if (e.getValue() == null) h.remove(e.getKey()); else h.put(e.getKey(), str(e.getValue())); }
        byte[] bytes = body == null ? new byte[0] : stringify(body).getBytes(StandardCharsets.UTF_8);
        StringBuilder wire = new StringBuilder(method + " " + path + " HTTP/1.1\r\n");
        for (Map.Entry<String,String> e : h.entrySet()) wire.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        wire.append("Content-Length: ").append(bytes.length).append("\r\n\r\n");
        return raw(wire.toString(), bytes);
    }
    private Result raw(String headers, byte[] body) throws Exception {
        try (Socket socket = new Socket("127.0.0.1", 8790)) {
            socket.setSoTimeout(20000); OutputStream out = socket.getOutputStream(); out.write(headers.getBytes(StandardCharsets.ISO_8859_1)); out.write(body); out.flush();
            byte[] response = Gateway.readBounded(socket.getInputStream(), 30*1024*1024); String wire = new String(response, StandardCharsets.UTF_8); int end = wire.indexOf("\r\n\r\n");
            check(end >= 0, "complete local HTTP response"); String[] lines = wire.substring(0, end).split("\r\n"); Result r = new Result(); r.status = Integer.parseInt(lines[0].split(" ")[1]);
            for (int i = 1; i < lines.length; i++) { int colon = lines[i].indexOf(':'); r.headers.put(lines[i].substring(0, colon).toLowerCase(Locale.ROOT), lines[i].substring(colon+1).trim()); }
            r.text = wire.substring(end+4); check(!r.headers.containsKey("access-control-allow-origin"), "no CORS response"); return r;
        }
    }
    private Fake fake(String protocol) throws Exception { Fake f = new Fake(protocol); fakes.add(f); return f; }
    private String add(Fake fake, String name) throws Exception {
        Result r = request("POST", "/api/app/providers", obj("provider", fake.protocol.equals("anthropic") ? "anthropic" : "custom", "name", name, "baseUrl", fake.url(), "apiKey", SECRET, "defaultModel", name + "-model", "protocol", fake.protocol));
        eq(r.status, 200, "add provider"); check(!r.text.contains(SECRET), "provider response masks key"); return str(map(r.json().get("provider")).get("id"));
    }
    private Map<String,Object> turn(String model, Object scope) { return obj("model", model, "assistant_provider_ids", scope, "messages", arr(obj("role", "user", "content", "Build a project"))); }
    private void enableOnly(String... ids) throws Exception {
        Set<String> enabled = new HashSet<>(Arrays.asList(ids));
        synchronized (state) { Map<String,Object> next = state.snapshot(); for (Object p : list(next.get("providers"))) { map(p).put("enabled", enabled.contains(str(map(p).get("id")))); map(p).remove("cooldownUntil"); } state.commit(next); }
    }
    private void clearCooldown(String id) throws Exception {
        synchronized (state) { Map<String,Object> next = state.snapshot(); HubState.find(list(next.get("providers")), "id", id).remove("cooldownUntil"); state.commit(next); }
    }
    private static Map<String,Object> complete(String text) { return obj("id", "fake-complete", "choices", arr(obj("index", 0, "message", obj("role", "assistant", "content", text), "finish_reason", "stop")), "usage", obj("prompt_tokens", 2, "completion_tokens", 3, "total_tokens", 5)); }
    private static final class Fake implements AutoCloseable {
        final String protocol; final HttpServer server; final ExecutorService executor;
        final AtomicInteger hits = new AtomicInteger(); volatile String mode = "valid"; volatile Map<String,Object> received; volatile String authorization, apiKey, version, receivedPath; volatile String redirect;
        final CountDownLatch stall = new CountDownLatch(1);
        Fake(String protocol) throws Exception {
            this.protocol = protocol; server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 8);
            executor = Executors.newFixedThreadPool(2); server.setExecutor(executor); server.createContext("/", this::handle); server.start();
        }
        String url() { return "http://127.0.0.1:" + server.getAddress().getPort() + "/v1"; }
        void handle(HttpExchange x) throws IOException {
            try {
                hits.incrementAndGet(); receivedPath = x.getRequestURI().getPath();
                if (mode.equals("stall")) { try { stall.await(5, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } return; }
                authorization = x.getRequestHeaders().getFirst("Authorization"); apiKey = x.getRequestHeaders().getFirst("x-api-key"); version = x.getRequestHeaders().getFirst("anthropic-version");
                byte[] request = Gateway.readBounded(x.getRequestBody(), 26*1024*1024); if (request.length > 0) received = map(parse(new String(request, StandardCharsets.UTF_8)));
                int status = 200; String type = "application/json", text;
                if (mode.equals("402")) { status = 402; text = stringify(obj("error", obj("message", SECRET))); }
                else if (mode.equals("429")) { status = 429; text = stringify(obj("error", SECRET)); }
                else if (mode.equals("redirect")) { status = 307; x.getResponseHeaders().set("Location", redirect); text = "{}"; }
                else if (mode.equals("html")) { type = "text/html"; text = "<html>" + SECRET + "</html>"; }
                else if (mode.equals("malformed")) text = "{\"error\":\"" + SECRET;
                else if (mode.equals("envelope")) text = stringify(obj("error", SECRET));
                else if (mode.equals("empty-body")) text = "";
                else if (mode.equals("empty")) text = stringify(complete(""));
                else if (mode.equals("length")) { Map<String,Object> c = complete("partial"); map(list(c.get("choices")).get(0)).put("finish_reason", "length"); text = stringify(c); }
                else if (mode.equals("tool-malformed")) { Map<String,Object> c = complete("tool"); Protocol.message(c).put("tool_calls", arr(obj("id", "bad", "type", "function", "function", obj("name", "write_file", "arguments", "{")))); text = stringify(c); }
                else if (mode.equals("too-big")) { x.getResponseHeaders().set("Content-Type", type); x.sendResponseHeaders(200, 26*1024*1024); return; }
                else if (mode.equals("truncated-body")) { x.getResponseHeaders().set("Content-Type", type); x.sendResponseHeaders(200, 2000); x.getResponseBody().write(stringify(complete("partial")).getBytes(StandardCharsets.UTF_8)); return; }
                else if (mode.equals("sse") || mode.equals("truncated-sse") || mode.equals("sse-error")) {
                    type = "text/event-stream";
                    text = "data: " + stringify(obj("id", "fake-sse", "choices", arr(obj("index", 0, "delta", obj("role", "assistant", "content", "buffered answer"), "finish_reason", null)))) + "\n\n";
                    if (mode.equals("sse")) text += "data: " + stringify(obj("choices", arr(obj("index", 0, "delta", obj(), "finish_reason", "stop")))) + "\n\ndata: [DONE]\n\n";
                    if (mode.equals("sse-error")) text += "data: " + stringify(obj("error", SECRET)) + "\n\n";
                } else if (mode.equals("tools")) {
                    if (protocol.equals("anthropic")) text = stringify(obj("id", "msg_tools", "type", "message", "role", "assistant", "model", "remote", "stop_reason", "tool_use", "content", arr(obj("type", "tool_use", "id", "call-write", "name", "write_file", "input", obj("path", "hello.txt", "content", "Hello"))), "usage", obj("input_tokens", 2, "output_tokens", 3)));
                    else { Map<String,Object> c = complete("tool requested"); Protocol.message(c).put("tool_calls", arr(obj("id", "call-write", "type", "function", "function", obj("name", "write_file", "arguments", "{\"path\":\"hello.txt\",\"content\":\"Hello\"}")))); map(list(c.get("choices")).get(0)).put("finish_reason", "tool_calls"); text = stringify(c); }
                } else if (protocol.equals("anthropic")) text = stringify(obj("id", "msg_answer", "type", "message", "role", "assistant", "model", "remote", "stop_reason", "end_turn", "content", arr(obj("type", "text", "text", "continued by B")), "usage", obj("input_tokens", 2, "output_tokens", 3)));
                else text = stringify(complete("continued by B"));
                x.getResponseHeaders().set("Content-Type", type); byte[] bytes = text.getBytes(StandardCharsets.UTF_8); x.sendResponseHeaders(status, bytes.length == 0 ? -1 : bytes.length); if (bytes.length > 0) x.getResponseBody().write(bytes);
            } finally { x.close(); }
        }
        public void close() { server.stop(0); executor.shutdownNow(); }
    }
    private void security() throws Exception {
        eq(request("GET", "/health", null, obj("X-App-Session", null)).status, 200, "public health");
        for (String p : new String[]{"/api/app/overview", "/api/app/settings", "/api/app/catalog", "/api/app/missing"}) eq(request("GET", p, null, obj("X-App-Session", null)).status, 401, "app route requires session");
        eq(request("POST", "/api/app/providers", obj(), obj("X-App-Session", "incorrect")).status, 401, "write session check");
        eq(request("OPTIONS", "/api/app/providers", null, obj("Origin", "https://evil.test")).status, 403, "no preflight CORS");
        for (Map<String,Object> bad : Arrays.asList(obj("Origin", "http://127.0.0.1:9999"), obj("Origin", "null"), obj("Host", "evil.test:8790"), obj("Sec-Fetch-Site", "cross-site"), obj("Sec-Fetch-Site", "same-site"), obj("Referer", "http://127.0.0.1:8790.evil.test/"))) eq(request("GET", "/api/app/overview", null, bad).status, 403, "origin/host/fetch/referer restriction");
        eq(request("GET", "/api/app/overview", null, obj("Origin", "http://127.0.0.1:8790", "Sec-Fetch-Site", "same-origin")).status, 200, "same origin accepted");
        for (String p : new String[]{"/v1", "/v1/chat/completions", "/api/hub", "/api/hub/accounts", "/credits", "/ping", "/api/unknown", "/api/app/unknown"}) { Result r = request("GET", p, null); eq(r.status, 404, "blocked API " + p); check(r.headers.get("content-type").startsWith("application/json"), "API never returns SPA"); }
        eq(request("GET", "/", null).status, 200, "index asset"); eq(request("GET", "/projects/checkpoint", null).status, 200, "SPA deep link");
        check(request("GET", "/assets/app.js", null).headers.get("content-type").startsWith("text/javascript"), "JS MIME");
        eq(request("GET", "/assets/missing.js", null).status, 404, "missing asset not SPA");
        for (String p : new String[]{"/%61pi/app/overview", "/api/app/../overview", "/%2e%2e/private", "/api%2fapp/overview"}) eq(request("GET", p, null).status, 400, "path traversal/noncanonical rejected");
        eq(raw("POST /api/app/settings HTTP/1.1\r\nHost: 127.0.0.1:8790\r\nContent-Length: 26214401\r\n\r\n", new byte[0]).status, 413, "25MB request bound before allocation");
        eq(raw("GET /health HTTP/1.1\r\nHost: 127.0.0.1:8790\r\nHost: evil.test\r\n\r\n", new byte[0]).status, 400, "duplicate Host rejected");
        eq(raw("POST /api/app/settings HTTP/1.1\r\nHost: 127.0.0.1:8790\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n", new byte[0]).status, 400, "request smuggling rejected");
        eq(request("POST", "/api/app/settings", obj("autoCheckinEnabled", true)).status, 400, "automatic credits setting blocked");
        eq(request("GET", "/api/app/catalog/providers", null).status, 200, "provider catalog route");
        eq(request("POST", "/api/app/catalog/providers/refresh", obj("provider", "openrouter")).json().get("cached"), true, "OpenRouter refresh respects fresh cache");
        eq(request("POST", "/api/app/catalog/providers/refresh", obj("provider", "github")).status, 503, "unverified GitHub catalog honestly unavailable");
        eq(request("POST", "/api/app/catalog/providers/refresh", obj("provider", "custom")).status, 400, "unsupported refresh provider");
        eq(request("GET", "/api/app/providers/presets", null).status, 200, "presets route");
        eq(request("POST", "/api/app/qoder/reminder", obj()).status, 503, "reminder placeholder");
        eq(request("POST", "/api/app/qoder/claim", obj()).status, 404, "no invented claim endpoint");
        Result caps = request("GET", "/api/app/project-build/capabilities", null); eq(caps.json().get("platform"), "android", "honest platform"); eq(caps.json().get("runtime"), null, "no build runtime");
        eq(request("POST", "/api/app/project-build/prepare", obj()).status, 503, "prepare blocked"); eq(request("POST", "/api/app/project-build/run", obj()).status, 503, "run blocked");
        check(list(state.snapshot().get("apiKeys")).isEmpty(), "no default gateway key"); check(!yes(state.settings().get("autoCheckinEnabled")), "no automatic Qoder claim default");
        try (ServerSocket occupied = new ServerSocket()) {
            occupied.setReuseAddress(false); occupied.bind(new InetSocketAddress("127.0.0.1", 0));
            Gateway other = new Gateway(state, path -> null); check(!other.sessionToken().equals(gateway.sessionToken()), "per-instance random session");
            boolean failed = false; try { other.start(); } catch (IOException expected) { failed = true; } finally { other.stop(); } check(failed, "busy 8790 fails instead of changing origin");
        }
    }
    private void routesAndContinuity() throws Exception {
        Fake a = fake("openai"), b = fake("anthropic"); String aid = add(a, "A"), bid = add(b, "B"); enableOnly(aid, bid); a.mode = "tools";
        Map<String,Object> tools = obj("type", "function", "function", obj("name", "write_file", "parameters", obj("type", "object", "properties", obj("path", obj("type", "string"), "content", obj("type", "string")))));
        Map<String,Object> first = turn("provider:" + aid, arr(aid)); first.put("tools", arr(tools)); first.put("tool_choice", "auto"); first.put("parallel_tool_calls", false);
        Result ar = request("POST", "/api/app/assistant/complete", first); eq(ar.status, 200, "A tool completion"); Map<String,Object> ac = ar.json();
        eq(map(ac.get("qoder_meta")).get("provider_id"), aid, "A identity metadata required"); eq(a.authorization, "Bearer " + SECRET, "OpenAI credential header"); eq(a.received.get("stream"), false, "upstream fully buffered"); eq(a.received.get("tools"), arr(tools), "tools forwarded unchanged"); eq(a.received.get("parallel_tool_calls"), false, "tool options forwarded"); check(!a.received.containsKey("assistant_provider_ids"), "private scope not forwarded");
        Map<String,Object> call = map(list(Protocol.message(ac).get("tool_calls")).get(0)); eq(call.get("id"), "call-write", "tool identity preserved");
        List<Object> continuation = arr(obj("role", "user", "content", "Build a project"), Protocol.message(ac), obj("role", "tool", "tool_call_id", call.get("id"), "content", "File saved"));
        Map<String,Object> second = turn("provider:" + aid, arr(aid)); second.put("messages", continuation); second.put("tools", arr(tools)); a.mode = "402"; int before = b.hits.get();
        Result depleted = request("POST", "/api/app/assistant/complete", second); eq(depleted.status, 402, "A credits exhausted"); check(!depleted.text.contains(SECRET), "HTTP error body cannot leak key"); eq(b.hits.get(), before, "scoped singleton never falls through");
        int coolingHits = a.hits.get(); eq(request("POST", "/api/app/assistant/complete", second).status, 503, "singleton cooldown respected"); eq(a.hits.get(), coolingHits, "cooldown provider not called again"); eq(b.hits.get(), before, "cooldown singleton cannot escape scope");
        second.put("model", "provider:" + bid); second.put("assistant_provider_ids", arr(bid));
        Result br = request("POST", "/api/app/assistant/complete", second); eq(br.status, 200, "B continues checkpoint"); eq(map(br.json().get("qoder_meta")).get("provider_id"), bid, "B identity metadata"); eq(b.apiKey, SECRET, "Anthropic x-api-key"); eq(b.authorization, null, "no OpenAI auth on Anthropic"); eq(b.version, "2023-06-01", "Anthropic version");
        List<Object> blocks = list(map(list(b.received.get("messages")).get(1)).get("content")); eq(map(blocks.get(blocks.size()-1)).get("type"), "tool_use", "assistant tool call converted for B");
        Map<String,Object> result = map(list(map(list(b.received.get("messages")).get(2)).get("content")).get(0)); eq(result.get("tool_use_id"), "call-write", "tool result continuation preserved"); check(b.received.containsKey("tools"), "Anthropic tool definition forwarded");
        clearCooldown(aid); second.put("model", "provider:" + aid); second.put("assistant_provider_ids", arr(aid, bid));
        Result failover = request("POST", "/api/app/assistant/complete", second); eq(failover.status, 200, "multi-provider failover"); eq(map(failover.json().get("qoder_meta")).get("failover_provider_ids"), arr(aid), "failover chain records attempted A");
        eq(request("POST", "/api/app/settings", obj("autoFailoverEnabled", false)).status, 200, "failover setting"); clearCooldown(aid); before = b.hits.get(); eq(request("POST", "/api/app/assistant/complete", second).status, 402, "failover disabled"); eq(b.hits.get(), before, "no B request when failover disabled"); request("POST", "/api/app/settings", obj("autoFailoverEnabled", true));
        for (Object scope : new Object[]{arr(), arr(aid, aid), arr("missing"), null, "bad", Collections.nCopies(101, aid)}) { Map<String,Object> bad = turn("auto-failover", scope); eq(request("POST", "/api/app/assistant/complete", bad).status, 400, "invalid scope rejected"); }
        eq(request("POST", "/api/app/assistant/complete", turn("provider:missing", arr(bid))).status, 400, "unknown provider model"); eq(request("POST", "/api/app/assistant/complete", turn("provider:" + aid, arr(bid))).status, 400, "explicit ID outside scope"); eq(request("POST", "/api/app/assistant/complete", turn("A-model", arr(bid))).status, 400, "explicit configured model outside scope"); eq(request("POST", "/api/app/assistant/complete", turn("qoder-remote", arr(bid))).status, 400, "no Qoder model routing");
        eq(request("POST", "/api/app/assistant/complete", turn("B-model", arr(bid))).status, 200, "configured external model");
        Map<String,Object> unscoped = turn("provider:" + bid, arr(bid)); unscoped.remove("assistant_provider_ids"); eq(request("POST", "/api/app/assistant/complete", unscoped).status, 200, "React chat defaults to external-only pool");
        enableOnly(bid); int aBefore = a.hits.get(); eq(request("POST", "/api/app/assistant/complete", turn("provider:" + aid, arr(aid))).status, 503, "disabled singleton unavailable"); eq(a.hits.get(), aBefore, "disabled provider not called");
        int count = state.providers().size(); eq(request("POST", "/api/app/providers/batch", obj("items", arr(obj("name", "valid", "baseUrl", a.url(), "apiKey", SECRET), obj("name", "bad", "baseUrl", "https://user:password@example.test/v1")))).status, 400, "invalid batch rejected"); eq(state.providers().size(), count, "batch atomicity");
        Result manual = request("POST", "/api/app/catalog/manual", obj("provider", "custom", "modelName", "manual-model", "baseUrl", a.url())); eq(manual.status, 200, "manual catalog"); check(!manual.text.contains(SECRET), "catalog has no credentials");
        eq(request("POST", "/api/app/providers/" + bid + "/priority", obj("direction", "up")).status, 200, "priority move"); eq(request("POST", "/api/app/providers/" + aid + "/toggle", obj()).status, 200, "toggle provider"); eq(request("PATCH", "/api/app/providers/" + bid, obj("name", "Renamed B")).status, 200, "patch provider");
        eq(request("POST", "/api/app/providers/" + bid + "/test", obj()).json().get("ok"), true, "real provider test");
        Result discovered = request("POST", "/api/app/providers/discover", obj()); eq(discovered.status, 200, "offline discovery route"); check(!discovered.text.contains(SECRET), "discovery results contain no credentials");
        Result addedDiscovery = request("POST", "/api/app/providers/discover/add", obj("items", arr(obj("provider", "custom", "name", "Discovered A", "baseUrl", a.url(), "defaultModel", "discovered-model", "protocol", "openai")))); eq(addedDiscovery.status, 200, "discovered provider add reuses private endpoint key");
        String discoveredId = str(map(list(addedDiscovery.json().get("providers")).get(0)).get("id")); eq(HubState.find(state.providers(), "id", discoveredId).get("apiKey"), SECRET, "private discovery credential reused without exposure");
        Result view = request("GET", "/api/app/overview", null); check(!view.text.contains(SECRET), "overview/logs contain no credentials"); check(list(view.json().get("accounts")).isEmpty() && list(view.json().get("apiKeys")).isEmpty(), "legacy account/gateway state not exposed");
        HubState restored = new HubState(directory, state.presets); eq(restored.providers().size(), state.providers().size(), "provider persistence"); check(HubState.find(restored.providers(), "id", bid).get("apiKey").equals(SECRET), "credential survives private restart");
    }
    private void invalidResponsesAndSse() throws Exception {
        Fake bad = fake("openai"), good = fake("openai"); String id = add(bad, "Invalid"), goodId = add(good, "Good"); enableOnly(id, goodId);
        for (String mode : new String[]{"html", "malformed", "envelope", "empty-body", "empty", "length", "tool-malformed", "too-big", "truncated-body", "truncated-sse", "sse-error"}) {
            bad.mode = mode; clearCooldown(id); Map<String,Object> body = turn("provider:" + id, arr(id)); body.put("stream", true);
            Result r = request("POST", "/api/app/assistant/complete", body); eq(r.status, 502, "invalid upstream " + mode); check(r.headers.get("content-type").startsWith("application/json"), "no local partial SSE " + mode); check(!r.text.contains(SECRET), "safe upstream failure " + mode);
        }
        bad.mode = "redirect"; bad.redirect = good.url() + "/chat/completions"; int before = good.hits.get(); clearCooldown(id); eq(request("POST", "/api/app/assistant/complete", turn("provider:" + id, arr(id))).status, 502, "redirect refused"); eq(good.hits.get(), before, "no redirected credential request");
        bad.mode = "truncated-sse"; clearCooldown(id); Map<String,Object> scope = turn("provider:" + id, arr(id, goodId)); scope.put("stream", true); Result fallback = request("POST", "/api/app/assistant/complete", scope); eq(fallback.status, 200, "invalid buffered stream retries before local SSE"); check(!fallback.text.contains("buffered answer"), "discarded partial output absent"); check(fallback.text.contains(goodId) && fallback.text.contains("[DONE]"), "fallback SSE has identity and terminal");
        bad.mode = "sse"; clearCooldown(id); Map<String,Object> body = turn("provider:" + id, arr(id)); body.put("stream", true); Result stream = request("POST", "/api/app/assistant/complete", body); eq(stream.status, 200, "valid upstream SSE buffered"); check(stream.text.contains("buffered answer") && stream.text.contains(id), "SSE content and provider metadata");
        bad.mode = "tools"; clearCooldown(id); Result toolStream = request("POST", "/api/app/assistant/complete", body); check(toolStream.text.contains("call-write") && toolStream.text.contains("write_file"), "local SSE preserves tools");
        Fake anthropic = fake("anthropic"); String anthId = add(anthropic, "AnthropicTools"); enableOnly(anthId); anthropic.mode = "tools"; Result anth = request("POST", "/api/app/assistant/complete", turn("provider:" + anthId, arr(anthId))); eq(anth.status, 200, "Anthropic tools normalized"); eq(map(list(Protocol.message(anth.json()).get("tool_calls")).get(0)).get("id"), "call-write", "Anthropic tool ID preserved");
        eq(anthropic.receivedPath, "/v1/messages", "Anthropic endpoint");
        eq(map(Protocol.output(anth.json(), "anthropic").get("qoder_meta")).get("provider_id"), anthId, "Anthropic output retains metadata");
        eq(map(Protocol.output(anth.json(), "responses").get("qoder_meta")).get("provider_id"), anthId, "Responses output retains metadata");
        Fake gemini = fake("openai"); Result createdGemini = request("POST", "/api/app/providers", obj("provider", "gemini", "name", "Gemini compatible", "baseUrl", gemini.url(), "apiKey", SECRET)); String geminiId = str(map(createdGemini.json().get("provider")).get("id")); enableOnly(geminiId);
        eq(request("POST", "/api/app/assistant/complete", turn("provider:" + geminiId, arr(geminiId))).status, 200, "Gemini preset uses OpenAI compatibility"); eq(gemini.receivedPath, "/v1/chat/completions", "Gemini OpenAI endpoint"); eq(gemini.authorization, "Bearer " + SECRET, "Gemini OpenAI credential");
        Fake timeout = fake("openai"); timeout.mode = "stall"; long started = System.currentTimeMillis(); boolean timedOut = false;
        try { Gateway.fetchJson(timeout.url(), null, SECRET, false, 200, 1024); }
        catch (Gateway.Failure e) { timedOut = true; check(!e.getMessage().contains(SECRET), "safe bounded timeout error"); }
        finally { timeout.stall.countDown(); }
        check(timedOut && System.currentTimeMillis()-started < 2500, "upstream wall/idle timeout bounded");
        eq(request("DELETE", "/api/app/providers/" + goodId, null).status, 200, "delete provider"); eq(request("POST", "/api/app/providers/" + goodId + "/test", obj()).status, 404, "deleted provider not found");
        boolean bounded = false; try { Gateway.readBounded(new ByteArrayInputStream(new byte[10]), 9); } catch (Gateway.Failure e) { bounded = true; } check(bounded, "bounded stream helper");
        boolean duplicate = false; try { parse("{\"x\":1,\"x\":2}"); } catch (IllegalArgumentException e) { duplicate = true; } check(duplicate, "strict JSON duplicate keys");
        boolean missingStop = false; try { Protocol.bufferedSse("data: " + stringify(obj("type", "message_start", "message", obj("type", "message", "role", "assistant", "content", arr(), "usage", obj()))) + "\n\ndata: [DONE]\n\n", true); } catch (Gateway.Failure e) { missingStop = true; } check(missingStop, "Anthropic cannot terminate with OpenAI DONE");
    }
    private void workerBound() throws Exception {
        List<Socket> sockets = new ArrayList<>(); int rejected = 0;
        try {
            for (int i = 0; i < 20; i++) { Socket s = new Socket("127.0.0.1", 8790); s.setSoTimeout(100); sockets.add(s); s.getOutputStream().write("GET /health HTTP/1.1\r\n".getBytes(StandardCharsets.US_ASCII)); }
            for (Socket s : sockets) { try { if (s.getInputStream().read() == -1) rejected++; } catch (SocketTimeoutException expected) {} catch (SocketException rejectedConnection) { rejected++; } }
            check(rejected >= 8, "four workers plus eight queued connections are bounded");
        } finally { for (Socket s : sockets) s.close(); }
        eq(request("GET", "/health", null).status, 200, "worker capacity recovered");
    }
    private void cleanup() throws Exception {
        gateway.stop(); gateway.stop(); for (Fake f : fakes) f.close();
        try (java.util.stream.Stream<Path> paths = Files.walk(directory.toPath())) { for (Path path : (Iterable<Path>)paths.sorted(Comparator.reverseOrder())::iterator) Files.deleteIfExists(path); }
    }
    private static void tokenBudgetCompatibility() {
        Map<String,Object> canonical = Protocol.normalize(obj("messages", arr(obj("role", "user", "content", "Reply OK")), "max_completion_tokens", 8192), "openai");
        Map<String,Object> official = Protocol.upstream(canonical, "o4-mini", false, "https://api.openai.com/v1");
        eq(num(official.get("max_completion_tokens")), 8192L, "official OpenAI reasoning budget");
        check(!official.containsKey("max_tokens"), "o-series does not receive deprecated max_tokens");
        eq(num(canonical.get("max_tokens")), 8192L, "canonical budget is unchanged");
        Map<String,Object> compatible = Protocol.upstream(canonical, "o4-mini", false, "https://compatible.example/v1");
        eq(num(compatible.get("max_tokens")), 8192L, "other compatible APIs retain max_tokens");
        check(!compatible.containsKey("max_completion_tokens"), "no OpenAI host guessing");
        eq(num(Protocol.upstream(canonical, "claude-test", true, "https://api.anthropic.com/v1").get("max_tokens")), 8192L, "Anthropic budget retained");
    }
    public static void main(String[] args) throws Exception {
        tokenBudgetCompatibility();
        GatewayTest test = new GatewayTest();
        try { test.security(); test.routesAndContinuity(); test.invalidResponsesAndSse(); test.workerBound(); test.gateway.stop(); eq(test.gateway.start(), 8790, "same port after restart"); eq(test.request("GET", "/health", null).status, 200, "health after restart"); System.out.println("GatewayTest: " + checks + " checks passed"); }
        finally { test.cleanup(); }
    }
}
