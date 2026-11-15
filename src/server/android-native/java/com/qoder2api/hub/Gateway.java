package com.qoder2api.hub;

import java.io.*;
import java.net.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import static com.qoder2api.hub.Json.*;

/** Private, dependency-free Android/JVM HTTP engine. Not a public AI gateway. */
public final class Gateway {
    public interface AssetSource { InputStream open(String path) throws IOException; }
    private static final int PORT = 8790, BODY_LIMIT = 25 * 1024 * 1024;
    private static final String HOST = "127.0.0.1:8790", ORIGIN = "http://" + HOST;
    private static final ScheduledThreadPoolExecutor DEADLINES = new ScheduledThreadPoolExecutor(1, daemon("hub-deadline"));
    static { DEADLINES.setRemoveOnCancelPolicy(true); }
    private final HubState state;
    private final AssetSource assets;
    private final ExternalCatalog catalog;
    private final AppUpdates updates;
    private final String token = HubState.id("session-");
    private final Set<Socket> clients = Collections.newSetFromMap(new ConcurrentHashMap<Socket,Boolean>());
    private final Set<HttpURLConnection> upstreams = Collections.newSetFromMap(new ConcurrentHashMap<HttpURLConnection,Boolean>());
    private volatile boolean running;
    private ServerSocket listener;
    private ThreadPoolExecutor workers;

    public Gateway(HubState state, AssetSource assets) throws IOException {
        this(state, assets, new AppUpdates());
    }
    Gateway(HubState state, AssetSource assets, AppUpdates updates) throws IOException {
        this.state = Objects.requireNonNull(state); this.assets = Objects.requireNonNull(assets);
        this.catalog = new ExternalCatalog(state); this.updates = Objects.requireNonNull(updates);
    }
    public String sessionToken() { return token; }
    public synchronized int start() throws IOException {
        if (running) return PORT;
        ServerSocket socket = new ServerSocket();
        try { socket.setReuseAddress(true); socket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 16); }
        catch (IOException e) { socket.close(); throw e; } // Never change origin when 8790 is busy.
        listener = socket;
        workers = new ThreadPoolExecutor(4, 4, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<Runnable>(8), daemon("hub-worker"), new ThreadPoolExecutor.AbortPolicy());
        running = true;
        final ThreadPoolExecutor pool = workers;
        Thread accept = daemon("hub-listener").newThread(() -> accept(socket, pool)); accept.start();
        return PORT;
    }
    public synchronized void stop() {
        running = false;
        if (listener != null) try { listener.close(); } catch (IOException ignored) {}
        for (Socket s : clients) close(s);
        for (HttpURLConnection c : upstreams) c.disconnect();
        if (workers != null) workers.shutdownNow();
    }
    private static ThreadFactory daemon(String name) { return r -> { Thread t = new Thread(r, name); t.setDaemon(true); return t; }; }
    private static void close(Socket socket) { try { socket.close(); } catch (IOException ignored) {} }
    private void accept(ServerSocket socket, ThreadPoolExecutor pool) {
        while (!socket.isClosed()) {
            try {
                Socket client = socket.accept(); client.setSoTimeout(10000); clients.add(client);
                // Covers queued connections and slow header/body trickles, not only idle reads.
                ScheduledFuture<?> timeout = DEADLINES.schedule(() -> close(client), 15, TimeUnit.SECONDS);
                try { pool.execute(() -> serve(client, timeout)); }
                catch (RejectedExecutionException e) { timeout.cancel(false); close(client); clients.remove(client); }
            } catch (IOException e) { if (!socket.isClosed()) stop(); break; }
        }
    }
    private void serve(Socket socket, ScheduledFuture<?> readTimeout) {
        ScheduledFuture<?> totalTimeout = null;
        try (Socket client = socket) {
            try {
                InputStream in = new BufferedInputStream(client.getInputStream());
                Request request = headers(in);
                validateLocal(request);
                if (appPath(request.path)) authenticate(request);
                if (blockedApi(request.path)) throw notFound();
                byte[] body = readBody(in, request);
                readTimeout.cancel(false);
                totalTimeout = DEADLINES.schedule(() -> close(client), 135, TimeUnit.SECONDS);
                Reply reply = route(request, body);
                send(client.getOutputStream(), request.method, reply);
            } catch (Failure e) { send(client.getOutputStream(), "GET", error(e)); }
            catch (SocketTimeoutException e) { send(client.getOutputStream(), "GET", error(new Failure(408, "request_timeout", "Local request timed out"))); }
            catch (IllegalArgumentException e) { send(client.getOutputStream(), "GET", error(new Failure(400, "invalid_request_error", "Invalid request fields or JSON"))); }
            catch (Exception e) { send(client.getOutputStream(), "GET", error(new Failure(503, "unavailable", "Local engine could not complete the request"))); }
        } catch (IOException ignored) {
            // Client disconnected. Never expose raw exception messages or credentials.
        } finally { readTimeout.cancel(false); if (totalTimeout != null) totalTimeout.cancel(false); clients.remove(socket); }
    }
    private static final class Request {
        String method, path; int length;
        final Map<String,String> headers = new LinkedHashMap<>();
    }
    private static Request headers(InputStream in) throws IOException {
        int[] budget = {32768}; String first = line(in, budget);
        String[] parts = first.split(" ", -1);
        if (parts.length != 3 || !parts[0].matches("[A-Z]+") || !arr("HTTP/1.1", "HTTP/1.0").contains(parts[2])) throw new Failure(400, "invalid_http", "Invalid HTTP request line");
        Request r = new Request(); r.method = parts[0]; String target = parts[1];
        if (!target.startsWith("/") || target.startsWith("//") || target.contains("#") || target.matches(".*[\\x00-\\x20\\x7f\\\\].*")) throw new Failure(400, "invalid_http", "Invalid local request target");
        int query = target.indexOf('?'); r.path = query < 0 ? target : target.substring(0, query);
        // Reject encoded separators and dot paths rather than accidentally treating an API as SPA.
        String decoded;
        try { decoded = URLDecoder.decode(r.path.replace("+", "%2B"), "UTF-8"); }
        catch (IllegalArgumentException e) { throw new Failure(400, "invalid_http", "Invalid path encoding"); }
        if (!decoded.equals(r.path) || r.path.contains("//") || Arrays.asList(r.path.split("/", -1)).contains("..") || Arrays.asList(r.path.split("/", -1)).contains(".")) throw new Failure(400, "invalid_http", "Noncanonical path");
        int count = 0;
        while (true) {
            String h = line(in, budget); if (h.isEmpty()) break;
            int colon = h.indexOf(':');
            if (++count > 100 || colon <= 0 || !h.substring(0, colon).matches("[!#$%&'*+.^_`|~0-9A-Za-z-]+")) throw new Failure(400, "invalid_http", "Invalid HTTP header");
            String key = h.substring(0, colon).toLowerCase(Locale.ROOT), value = h.substring(colon+1).trim();
            if (value.matches(".*[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f].*") || r.headers.put(key, value) != null) throw new Failure(400, "invalid_http", "Invalid or duplicate HTTP header");
        }
        if (r.headers.containsKey("transfer-encoding") || r.headers.containsKey("expect")) throw new Failure(400, "invalid_http", "Chunked or expect requests are unsupported");
        String length = r.headers.get("content-length");
        if (length != null) {
            if (!length.matches("[0-9]{1,10}")) throw new Failure(400, "invalid_http", "Invalid content length");
            long size = Long.parseLong(length); if (size > BODY_LIMIT) throw new Failure(413, "body_too_large", "Request exceeds 25 MB"); r.length = (int)size;
        }
        return r;
    }
    private static String line(InputStream in, int[] budget) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); int previous = -1;
        while (true) {
            int c = in.read(); if (c < 0) throw new Failure(400, "invalid_http", "Incomplete HTTP headers");
            if (--budget[0] < 0 || out.size() > 8192) throw new Failure(431, "headers_too_large", "HTTP headers exceed limit");
            if (previous == '\r') { if (c != '\n') throw new Failure(400, "invalid_http", "Invalid header line ending"); break; }
            if (c == '\n') throw new Failure(400, "invalid_http", "Invalid header line ending");
            if (c != '\r') out.write(c); previous = c;
        }
        return new String(out.toByteArray(), StandardCharsets.ISO_8859_1);
    }
    private static byte[] readBody(InputStream in, Request r) throws IOException {
        if (r.length > 0 && arr("GET", "HEAD").contains(r.method)) throw new Failure(400, "invalid_http", "Read requests cannot contain a body");
        byte[] bytes = new byte[r.length]; int n = 0;
        while (n < bytes.length) { int read = in.read(bytes, n, bytes.length-n); if (read < 0) throw new Failure(400, "invalid_http", "Incomplete request body"); n += read; }
        return bytes;
    }
    private static void validateLocal(Request r) {
        if (!HOST.equals(r.headers.get("host"))) throw new Failure(403, "forbidden_origin", "Only the loopback application origin is allowed");
        String origin = r.headers.get("origin"), site = r.headers.get("sec-fetch-site"), referer = r.headers.get("referer");
        if ((origin != null && !ORIGIN.equals(origin)) || (site != null && !arr("same-origin", "none").contains(site)) || (referer != null && !(referer.equals(ORIGIN) || referer.startsWith(ORIGIN + "/")))) throw new Failure(403, "forbidden_origin", "Cross-origin local requests are forbidden");
    }
    private void authenticate(Request r) {
        String value = r.headers.get("x-app-session");
        if (value == null || !MessageDigest.isEqual(token.getBytes(StandardCharsets.UTF_8), value.getBytes(StandardCharsets.UTF_8))) throw new Failure(401, "authentication_error", "Application session required");
    }
    private static boolean prefix(String p, String base) { return p.equals(base) || p.startsWith(base + "/"); }
    private static boolean appPath(String p) { return prefix(p, "/api/app"); }
    private static boolean blockedApi(String p) { return !appPath(p) && (prefix(p, "/api") || prefix(p, "/v1") || prefix(p, "/credits") || prefix(p, "/ping") || prefix(p, "/healthz") || prefix(p, "/livez") || prefix(p, "/readyz")); }
    private static Failure notFound() { return new Failure(404, "not_found", "No public gateway; use assistants inside the application"); }
    private static Map<String,Object> body(Request r, byte[] bytes) throws IOException {
        if (bytes.length == 0) return obj();
        String type = r.headers.get("content-type");
        if (type == null || !type.toLowerCase(Locale.ROOT).matches("application/json(?:\\s*;\\s*charset=utf-8)?")) throw new Failure(415, "unsupported_media_type", "JSON request body required");
        return map(parse(utf8(bytes)));
    }
    private Reply route(Request r, byte[] bytes) throws IOException {
        String p = r.path, method = r.method;
        if (prefix(p, "/health")) {
            if (p.equals("/health") && method.equals("GET")) return json(obj("ok", true, "service", "code-assistants", "gateway", false));
            throw notFound();
        }
        if (!appPath(p)) return asset(r);
        if (p.equals("/api/app/overview") && method.equals("GET")) return json(overview());
        if (p.equals("/api/app/updates") && method.equals("GET")) {
            Map<String,Object> result = updates.check(); return new Reply(yes(result.get("ok")) ? 200 : 503, result);
        }
        if ((p.equals("/api/app/catalog") || p.equals("/api/app/catalog/providers")) && method.equals("GET")) return json(catalog.snapshot());
        if (p.equals("/api/app/providers/presets") && method.equals("GET")) return json(obj("presets", state.presets));
        if (p.equals("/api/app/providers") && method.equals("GET")) return json(obj("providers", safeProviders(state.providers())));
        if (p.equals("/api/app/settings") && method.equals("GET")) return json(state.settings());
        if (p.equals("/api/app/project-build/capabilities") && method.equals("GET")) return json(obj("platform", "android", "available", false, "bun", obj("available", false), "npm", obj("available", false), "runtime", null, "warning", "Project build unavailable on Android; no shell or Termux runtime"));
        if ((p.equals("/api/app/project-build/prepare") || p.equals("/api/app/project-build/run")) && method.equals("POST")) throw new Failure(503, "build_unavailable", "Project build is unavailable on Android; no commands are executed");
        if (p.equals("/api/app/qoder/reminder")) throw new Failure(503, "native_bridge_required", "Qoder reminder requires the MainActivity bridge; credits require manual Desktop redemption, not login");
        if (p.equals("/api/app/catalog/providers/refresh") && method.equals("POST")) {
            Map<String,Object> result = catalog.refresh(Protocol.required(body(r, bytes).get("provider"), "provider")); return new Reply(yes(result.get("ok")) ? 200 : 503, result);
        }
        if (p.equals("/api/app/catalog/manual") && method.equals("POST")) return json(catalog.manual(body(r, bytes)));
        if (p.equals("/api/app/settings") && method.equals("POST")) {
            Map<String,Object> patch = body(r, bytes);
            if (patch.size() != 1 || !(patch.get("autoFailoverEnabled") instanceof Boolean)) throw new Failure(400, "invalid_setting", "Only autoFailoverEnabled can be configured");
            return json(obj("ok", true, "settings", state.updateSettings(patch)));
        }
        if (p.equals("/api/app/assistant/complete") && method.equals("POST")) return assistant(body(r, bytes));
        if (p.equals("/api/app/providers") && method.equals("POST")) return json(obj("ok", true, "provider", state.addProviders(arr(body(r, bytes)), false).get(0)));
        if ((p.equals("/api/app/providers/batch") || p.equals("/api/app/providers/discover/add")) && method.equals("POST")) {
            Map<String,Object> b = body(r, bytes); boolean discovery = p.endsWith("discover/add");
            List<Object> items = b.containsKey("items") ? list(b.get("items")) : discovery ? arr(b) : arr();
            List<Object> created = state.addProviders(items, discovery); return json(obj("ok", true, "providers", created, "count", created.size()));
        }
        if (p.equals("/api/app/providers/discover") && method.equals("POST")) return json(catalog.discover());
        if (p.startsWith("/api/app/providers/")) {
            String[] segments = p.substring("/api/app/providers/".length()).split("/", -1);
            if (segments.length == 1 && method.equals("PATCH")) return editProvider(segments[0], body(r, bytes), "patch");
            if (segments.length == 1 && method.equals("DELETE")) return editProvider(segments[0], obj(), "delete");
            if (segments.length == 2 && method.equals("POST") && arr("toggle", "priority").contains(segments[1])) return editProvider(segments[0], body(r, bytes), segments[1]);
            if (segments.length == 2 && method.equals("POST") && segments[1].equals("test")) return testProvider(segments[0]);
        }
        throw notFound();
    }
    private static List<Object> safeProviders(List<Object> providers) { List<Object> out = arr(); for (Object p : providers) out.add(HubState.safeProvider(map(p))); return out; }
    private Map<String,Object> overview() {
        Map<String,Object> view = state.overview(), totals = map(view.get("totals"));
        view.put("accounts", arr()); view.put("apiKeys", arr());
        for (String k : new String[]{"accountsTotal", "accountsEnabled", "accountsInCooldown", "creditsRemain", "creditsUsed", "creditsSize"}) totals.put(k, 0);
        list(view.get("recentLogs")).removeIf(raw -> map(raw).containsKey("accountUid"));
        // Legacy desktop logs may contain untrusted upstream error text. Do not expose it.
        for (Object raw : list(view.get("recentLogs"))) {
            Map<String,Object> log = map(raw);
            if (log.containsKey("error")) log.put("error", "Provider request failed (HTTP " + num(log.get("status")) + ")");
        }
        return view;
    }
    private Reply editProvider(String id, Map<String,Object> patch, String action) throws IOException {
        synchronized (state) {
            Map<String,Object> next = state.snapshot(); List<Object> pool = list(next.get("providers")); Map<String,Object> p = HubState.find(pool, "id", id);
            if (action.equals("delete")) pool.remove(p);
            else if (action.equals("toggle")) p.put("enabled", !yes(p.get("enabled")));
            else if (action.equals("patch")) {
                for (String k : patch.keySet()) if (!arr("name", "baseUrl", "apiKey", "defaultModel", "protocol", "enabled").contains(k)) throw new IllegalArgumentException("Invalid provider field");
                Map<String,Object> updated = state.validateProvider(patch, p, num(p.get("priority")));
                if (patch.containsKey("enabled")) { if (!(patch.get("enabled") instanceof Boolean)) throw new IllegalArgumentException("Invalid enabled"); updated.put("enabled", patch.get("enabled")); }
                pool.set(pool.indexOf(p), updated); p = updated;
            } else {
                String direction = str(patch.get("direction")); if (!arr("up", "down").contains(direction)) throw new IllegalArgumentException("Invalid direction");
                pool.sort((a,b) -> Long.compare(num(map(a).get("priority")), num(map(b).get("priority"))));
                int index = pool.indexOf(p), other = index + (direction.equals("up") ? -1 : 1);
                if (other >= 0 && other < pool.size()) Collections.swap(pool, index, other);
                for (int i = 0; i < pool.size(); i++) map(pool.get(i)).put("priority", i+1);
            }
            state.commit(next);
            if (action.equals("delete")) return json(obj("ok", true));
            if (action.equals("priority")) return json(obj("ok", true, "providers", safeProviders(pool)));
            return json(obj("ok", true, "provider", HubState.safeProvider(p)));
        }
    }
    private Reply testProvider(String id) throws IOException {
        Map<String,Object> p = HubState.find(state.providers(), "id", id); long started = System.currentTimeMillis();
        try {
            Map<String,Object> canonical = Protocol.normalize(obj("messages", arr(obj("role", "user", "content", "Reply OK")), "max_tokens", 32), "openai");
            Map<String,Object> completion = attempt(p, canonical, 15000); record(p, completion, null, false, started);
            return json(obj("ok", true, "message", "Provider returned a validated completion", "latencyMs", System.currentTimeMillis()-started, "provider", HubState.safeProvider(HubState.find(state.providers(), "id", id))));
        } catch (Failure e) { record(p, null, e, false, started); return json(obj("ok", false, "message", e.getMessage(), "status", e.status)); }
    }
    private Reply assistant(Map<String,Object> b) throws IOException {
        List<Object> all = state.providers(); Set<String> known = new HashSet<>(); for (Object raw : all) known.add(str(map(raw).get("id")));
        Object rawScope = b.containsKey("assistant_provider_ids") ? b.get("assistant_provider_ids") : new ArrayList<Object>(known);
        List<Object> scope = list(rawScope); Set<String> selected = new HashSet<>();
        if (scope.isEmpty() || scope.size() > 100) throw new Failure(400, "invalid_scope", "Select 1..100 configured providers");
        for (Object id : scope) if (!(id instanceof String) || !known.contains(id) || !selected.add(str(id))) throw new Failure(400, "invalid_scope", "Provider scope must contain known unique IDs");
        String model = b.containsKey("model") ? Protocol.required(b.get("model"), "model") : "auto-failover";
        boolean auto = model.equals("auto-failover"), byId = model.startsWith("provider:");
        List<Object> matching = arr();
        for (Object raw : all) { Map<String,Object> p = map(raw); if ((byId && model.substring(9).equals(p.get("id"))) || (!byId && str(p.get("defaultModel")).equalsIgnoreCase(model))) matching.add(raw); }
        if (!auto && matching.isEmpty()) throw new Failure(400, "invalid_model", "Model must be configured on an external provider");
        if (!auto && matching.stream().noneMatch(raw -> selected.contains(str(map(raw).get("id"))))) throw new Failure(400, "invalid_scope", "Explicit model is outside the selected provider scope");
        if (b.containsKey("stream") && !(b.get("stream") instanceof Boolean)) throw new IllegalArgumentException("Invalid stream");
        Map<String,Object> canonical = Protocol.normalize(b, "openai"), settings = state.settings();
        List<Object> candidates = arr();
        // Explicit provider/model is first, followed only by providers in the same scope.
        if (!auto) for (Object raw : matching) if (selected.contains(str(map(raw).get("id")))) candidates.add(raw);
        for (Object raw : all) if (selected.contains(str(map(raw).get("id"))) && !candidates.contains(raw)) candidates.add(raw);
        if (!yes(settings.get("autoFailoverEnabled")) && candidates.size() > 1) candidates = new ArrayList<>(candidates.subList(0, 1));
        long deadline = System.currentTimeMillis() + 120000; List<Object> failedNames = arr(), failedIds = arr(); Failure last = null;
        for (Object raw : candidates) {
            Map<String,Object> p = map(raw);
            if (!yes(p.get("enabled")) || num(p.get("cooldownUntil")) > System.currentTimeMillis()/1000 || list(settings.get("bannedModels")).contains(p.get("defaultModel"))) continue;
            if (!running || Thread.currentThread().isInterrupted()) throw new Failure(503, "stopped", "Local engine stopped");
            int remaining = (int)(deadline - System.currentTimeMillis()); if (remaining <= 0) { last = new Failure(504, "upstream_timeout", "Assistant request deadline exceeded"); break; }
            long started = System.currentTimeMillis();
            try {
                Map<String,Object> completion = attempt(p, canonical, Math.min(60000, remaining));
                Map<String,Object> meta = obj("provider_id", p.get("id"), "provider", p.get("name"), "model", p.get("defaultModel"), "realm", "intl", "latency_ms", System.currentTimeMillis()-started, "failover_chain", failedNames, "failover_provider_ids", failedIds);
                completion.put("qoder_meta", meta);
                Reply reply = yes(b.get("stream")) ? new Reply(200, "text/event-stream; charset=utf-8", Protocol.sse(completion, "openai").getBytes(StandardCharsets.UTF_8)) : json(Protocol.output(completion, "openai"));
                reply.headers.put("X-App-Provider", ExternalCatalog.encode(str(p.get("name")))); reply.headers.put("X-App-Provider-Id", str(p.get("id")));
                if (!failedNames.isEmpty()) reply.headers.put("X-App-Failover-From", ExternalCatalog.encode(String.join(", ", strings(failedNames))));
                record(p, completion, null, !failedIds.isEmpty(), started); return reply;
            } catch (Failure e) {
                last = e; record(p, null, e, false, started); failedNames.add(p.get("name")); failedIds.add(p.get("id"));
                if (e.type.equals("unsupported_feature")) throw e;
            }
        }
        if (last != null) throw last;
        throw new Failure(503, "providers_unavailable", "No enabled provider outside cooldown in the selected scope");
    }
    private static List<String> strings(List<Object> values) { List<String> out = new ArrayList<>(); for (Object v : values) out.add(str(v)); return out; }
    private Map<String,Object> attempt(Map<String,Object> p, Map<String,Object> canonical, int timeout) throws IOException {
        boolean anthropic = "anthropic".equals(p.get("protocol"));
        Map<String,Object> request = Protocol.upstream(canonical, str(p.get("defaultModel")), anthropic, str(p.get("baseUrl")));
        String url = HubState.baseUrl(p.get("baseUrl")) + (anthropic ? "/messages" : "/chat/completions");
        Map<String,Object> payload = fetch(url, request, str(p.get("apiKey")), anthropic, timeout, BODY_LIMIT, upstreams);
        try { return Protocol.completion(payload, anthropic, str(p.get("defaultModel"))); }
        catch (Failure e) { throw new Failure(502, e.type, "Provider returned an invalid or incomplete completion"); }
        catch (RuntimeException e) { throw new Failure(502, "upstream_error", "Provider returned malformed completion data"); }
    }
    private void record(Map<String,Object> p, Map<String,Object> completion, Failure error, boolean failover, long started) throws IOException {
        Map<String,Object> usage = completion == null ? obj() : map(completion.get("usage"));
        Map<String,Object> log = obj("providerId", p.get("id"), "providerName", p.get("name"), "model", p.get("defaultModel"), "realm", "intl", "status", error == null ? 200 : error.status, "latencyMs", System.currentTimeMillis()-started, "promptTokens", num(usage.get("prompt_tokens")), "completionTokens", num(usage.get("completion_tokens")), "failover", failover);
        if (error != null) log.put("error", error.getMessage());
        long cooldown = error == null ? 0 : error.status == 402 || error.status == 401 || error.status == 403 ? 300 : error.status == 429 ? 60 : 15;
        state.record(str(p.get("id")), error == null, failover, log, cooldown);
    }
    private Reply asset(Request r) throws IOException {
        if (!arr("GET", "HEAD").contains(r.method)) throw notFound();
        String path = r.path.equals("/") ? "index.html" : r.path.substring(1); byte[] bytes;
        try (InputStream in = assets.open("www/" + path)) { if (in == null) throw new FileNotFoundException(); bytes = readBounded(in, BODY_LIMIT); }
        catch (FileNotFoundException e) {
            if (path.substring(path.lastIndexOf('/')+1).contains(".")) throw notFound();
            path = "index.html"; try (InputStream in = assets.open("www/index.html")) { if (in == null) throw notFound(); bytes = readBounded(in, BODY_LIMIT); }
        }
        String ext = path.contains(".") ? path.substring(path.lastIndexOf('.')+1).toLowerCase(Locale.ROOT) : "";
        String mime = ext.equals("html") ? "text/html; charset=utf-8" : ext.equals("js") ? "text/javascript; charset=utf-8" : ext.equals("css") ? "text/css; charset=utf-8" : ext.equals("json") ? "application/json" : ext.equals("svg") ? "image/svg+xml" : ext.equals("png") ? "image/png" : ext.equals("jpg") || ext.equals("jpeg") ? "image/jpeg" : ext.equals("webp") ? "image/webp" : ext.equals("ico") ? "image/x-icon" : ext.equals("woff2") ? "font/woff2" : "application/octet-stream";
        return new Reply(200, mime, bytes);
    }
    static byte[] readBounded(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int n;
        while ((n = in.read(buffer)) != -1) { if (n > max-out.size()) throw new Failure(502, "response_too_large", "Response exceeds bounded limit"); out.write(buffer, 0, n); }
        return out.toByteArray();
    }
    private static String utf8(byte[] bytes) throws IOException {
        try { return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString(); }
        catch (CharacterCodingException e) { throw new Failure(400, "invalid_encoding", "Invalid UTF-8 JSON"); }
    }
    static Map<String,Object> fetchJson(String url, Map<String,Object> payload, String key, boolean anthropic, int timeout, int max) throws IOException {
        return fetch(url, payload, key, anthropic, timeout, max, null);
    }
    private static Map<String,Object> fetch(String url, Map<String,Object> payload, String key, boolean anthropic, int timeout, int max, Set<HttpURLConnection> active) throws IOException {
        HttpURLConnection c = null; ScheduledFuture<?> deadline = null;
        try {
            URL target = new URL(url);
            if (!arr("http", "https").contains(target.getProtocol()) || target.getUserInfo() != null || target.getRef() != null || key.matches("(?s).*[\\x00-\\x1f\\x7f].*")) throw new Failure(400, "invalid_endpoint", "Invalid provider endpoint or credential format");
            c = (HttpURLConnection)target.openConnection(); c.setInstanceFollowRedirects(false); c.setUseCaches(false);
            c.setConnectTimeout(Math.min(10000, timeout)); c.setReadTimeout(Math.min(15000, timeout));
            c.setRequestProperty("Accept", payload == null ? "application/json" : "application/json, text/event-stream"); c.setRequestProperty("Accept-Encoding", "identity");
            if (!key.isEmpty() && !key.equals("local-no-key")) c.setRequestProperty(anthropic ? "x-api-key" : "Authorization", anthropic ? key : "Bearer " + key);
            if (anthropic) c.setRequestProperty("anthropic-version", "2023-06-01");
            final HttpURLConnection connection = c; if (active != null) active.add(c);
            deadline = DEADLINES.schedule(connection::disconnect, timeout, TimeUnit.MILLISECONDS);
            if (payload != null) {
                byte[] bytes = stringify(payload).getBytes(StandardCharsets.UTF_8); if (bytes.length > BODY_LIMIT) throw new Failure(413, "body_too_large", "Converted request exceeds 25 MB");
                c.setRequestMethod("POST"); c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json; charset=utf-8"); c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
            }
            int status = c.getResponseCode();
            if (status < 200 || status >= 300) throw new Failure(status >= 400 && status <= 599 ? status : 502, "upstream_error", status >= 300 && status < 400 ? "Provider redirect refused; credentials were not forwarded" : "Provider request failed (HTTP " + status + ")");
            if (c.getContentLengthLong() > max) throw new Failure(502, "response_too_large", "Provider response exceeds bounded limit");
            String type = str(c.getContentType()).toLowerCase(Locale.ROOT), encoding = c.getHeaderField("Content-Encoding");
            if (encoding != null && !encoding.equalsIgnoreCase("identity")) throw new Failure(502, "upstream_error", "Unsupported provider response encoding");
            boolean sse = type.startsWith("text/event-stream");
            if (!(type.startsWith("application/json") || type.matches("application/[a-z0-9.+-]+\\+json(?:;.*)?") || (payload != null && sse))) throw new Failure(502, "upstream_error", "Provider did not return JSON or a supported stream");
            byte[] bytes; try (InputStream in = c.getInputStream()) { bytes = readBounded(in, max); }
            if (c.getContentLengthLong() >= 0 && c.getContentLengthLong() != bytes.length) throw new Failure(502, "truncated_response", "Provider response body was truncated");
            String text = utf8(bytes); if (text.trim().isEmpty()) throw new Failure(502, "upstream_error", "Provider returned an empty body");
            Map<String,Object> result = sse ? Protocol.bufferedSse(text, anthropic) : map(parse(text));
            if (result.containsKey("error")) throw new Failure(502, "upstream_error", "Provider returned an error envelope");
            return result;
        } catch (Failure e) { if (e.status == 400) throw new Failure(502, "upstream_error", "Invalid provider response or endpoint"); throw e; }
        catch (SocketTimeoutException e) { throw new Failure(504, "upstream_timeout", "Provider request timed out"); }
        catch (Exception e) { throw new Failure(502, "upstream_error", "Provider connection or response validation failed"); }
        finally { if (deadline != null) deadline.cancel(false); if (c != null) { if (active != null) active.remove(c); c.disconnect(); } }
    }
    static final class Failure extends RuntimeException {
        final int status; final String type;
        Failure(int status, String type, String message) { super(message); this.status = status; this.type = type; }
    }
    private static final class Reply {
        final int status; final String type; final byte[] bytes; final Map<String,String> headers = new LinkedHashMap<>();
        Reply(int status, Object value) { this(status, "application/json; charset=utf-8", stringify(value).getBytes(StandardCharsets.UTF_8)); }
        Reply(int status, String type, byte[] bytes) { this.status = status; this.type = type; this.bytes = bytes; }
    }
    private static Reply json(Object value) { return new Reply(200, value); }
    private static Reply error(Failure failure) { return new Reply(failure.status, obj("error", obj("type", failure.type, "message", failure.getMessage()))); }
    private static void send(OutputStream out, String method, Reply reply) throws IOException {
        StringBuilder h = new StringBuilder("HTTP/1.1 ").append(reply.status).append(reply.status == 200 ? " OK\r\n" : " Error\r\n");
        h.append("Content-Type: ").append(reply.type).append("\r\nContent-Length: ").append(reply.bytes.length).append("\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCross-Origin-Resource-Policy: same-origin\r\nX-Frame-Options: DENY\r\n");
        for (Map.Entry<String,String> e : reply.headers.entrySet()) h.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        h.append("\r\n"); out.write(h.toString().getBytes(StandardCharsets.ISO_8859_1)); if (!method.equals("HEAD")) out.write(reply.bytes); out.flush();
    }
}
