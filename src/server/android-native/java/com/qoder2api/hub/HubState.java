package com.qoder2api.hub;

import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
import static com.qoder2api.hub.Json.*;

/** TS-compatible state, private app files, atomic replace; never resets a corrupt credential file. */
public final class HubState {
    final File directory;
    private Map<String,Object> state;
    final List<Object> presets;
    final long started = System.currentTimeMillis();
    public HubState(File directory, List<Object> presets) throws IOException {
        this.directory = directory; this.presets = presets;
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create private data directory");
        File file = new File(directory, "hub-state.json");
        state = file.exists() ? map(parse(read(file, 32 * 1024 * 1024))) : obj();
        for (String k : new String[]{"accounts", "providers", "apiKeys", "logs"}) {
            if (!state.containsKey(k)) state.put(k, arr()); else list(state.get(k));
        }
        Map<String,Object> settings = obj("defaultRealm", "intl", "autoRealm", true, "queueWaitMode", "wait", "trafficGuard", true,
            "maxConcurrencyPerAccount", 2, "autoCheckinEnabled", false, "requireApiKey", false, "autoFailoverEnabled", true,
            "fallbackToQoderZeroX", false, "autoRefreshTokens", false, "bannedModels", arr());
        if (state.containsKey("settings")) settings.putAll(map(state.get("settings")));
        for (String k : new String[]{"autoRealm", "autoCheckinEnabled", "requireApiKey", "fallbackToQoderZeroX", "autoRefreshTokens"}) settings.put(k, false);
        state.put("settings", settings);
        Map<String,Object> risk = obj("queueCount", 0, "rateLimitCount", 0, "rejectedCount", 0, "versionGateCount", 0);
        if (state.containsKey("risk")) risk.putAll(map(state.get("risk"))); state.put("risk", risk);
        if (!state.containsKey("totalRequests")) state.put("totalRequests", 0);
        if (!file.exists()) save(); // No public gateway keys or automatic Qoder claims.
    }
    static String read(File f, int max) throws IOException { try (InputStream in = new FileInputStream(f)) { return new String(Gateway.readBounded(in, max), StandardCharsets.UTF_8); } }
    static void atomic(File f, Object value) throws IOException {
        File tmp = new File(f.getPath() + ".tmp");
        try {
            try (FileOutputStream out = new FileOutputStream(tmp)) { out.write(stringify(value).getBytes(StandardCharsets.UTF_8)); out.getFD().sync(); }
            java.nio.file.Files.move(tmp.toPath(), f.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        } finally { if (tmp.exists()) tmp.delete(); }
    }
    private void save() throws IOException { atomic(new File(directory, "hub-state.json"), state); }
    synchronized void commit(Map<String,Object> next) throws IOException {
        atomic(new File(directory, "hub-state.json"), next); state = next;
    }
    synchronized Map<String,Object> snapshot() { return map(copy(state)); }
    synchronized Map<String,Object> settings() { return map(copy(state.get("settings"))); }
    static String id(String prefix) {
        byte[] b = new byte[18]; new SecureRandom().nextBytes(b); StringBuilder s = new StringBuilder(prefix);
        for (byte v : b) s.append(String.format(Locale.ROOT, "%02x", v & 255)); return s.toString();
    }
    static Map<String,Object> newKey(String name, String realm) { return obj("id", id("key-"), "name", name, "key", id("qd-"), "realmLock", realm, "createdAt", System.currentTimeMillis(), "requestCount", 0); }
    synchronized Map<String,Object> authenticate(String token, String model) throws IOException {
        boolean required = yes(map(state.get("settings")).get("requireApiKey"));
        Map<String,Object> next = snapshot(); Map<String,Object> hit = null;
        for (Object raw : list(next.get("apiKeys"))) if (str(map(raw).get("key")).equals(token) && !token.isEmpty()) { hit = map(raw); break; }
        if (hit == null && required) throw new Gateway.Failure(401, "authentication_error", "API Key required, invalid or revoked");
        if (hit != null) {
            if (hit.get("models") instanceof List && !list(hit.get("models")).isEmpty() && !list(hit.get("models")).contains(model)) throw new Gateway.Failure(403, "permission_error", "Model not allowed for this API key");
            if ("cn".equals(hit.get("realmLock"))) throw new Gateway.Failure(403, "permission_error", "External providers do not support cn realm-locked keys");
            hit.put("lastUsedAt", System.currentTimeMillis()); increment(hit, "requestCount", 1); commit(next);
        }
        return hit;
    }
    synchronized Map<String,Object> updateSettings(Map<String,Object> patch) throws IOException {
        Map<String,Object> next = snapshot(), settings = map(next.get("settings"));
        for (Map.Entry<String,Object> e : patch.entrySet()) {
            String k = e.getKey(); Object v = e.getValue(); if (!settings.containsKey(k)) throw new IllegalArgumentException("Unknown setting: " + k);
            if (k.equals("defaultRealm")) { if (!arr("intl", "cn").contains(v)) throw new IllegalArgumentException("Invalid realm"); }
            else if (k.equals("queueWaitMode")) { if (!arr("wait", "fast").contains(v)) throw new IllegalArgumentException("Invalid queue mode"); }
            else if (k.equals("maxConcurrencyPerAccount")) { if (!(v instanceof Number) || num(v) < 1 || num(v) > 16 || ((Number)v).doubleValue() != num(v)) throw new IllegalArgumentException("Concurrency must be 1..16"); }
            else if (k.equals("bannedModels")) { for (Object item : list(v)) if (!(item instanceof String)) throw new IllegalArgumentException("Invalid banned model"); }
            else if (!(v instanceof Boolean)) throw new IllegalArgumentException(k + " must be boolean");
            settings.put(k, copy(v));
        }
        commit(next); return settings;
    }
    Map<String,Object> preset(String provider) {
        for (Object raw : presets) if (provider.equals(map(raw).get("id"))) return map(raw);
        throw new IllegalArgumentException("Unknown provider preset: " + provider);
    }
    static String baseUrl(Object raw) {
        String s = str(raw).trim().replaceAll("/+$", "");
        try {
            URI u = new URI(s);
            if (!arr("http", "https").contains(u.getScheme()) || u.getHost() == null || u.getUserInfo() != null || u.getQuery() != null || u.getFragment() != null) throw new Exception();
            if (s.length() > 2048 || s.matches(".*[\\x00-\\x20\\x7f].*")) throw new Exception(); return s;
        } catch (Exception e) { throw new IllegalArgumentException("baseUrl must be HTTP(S), without credentials, query or fragment"); }
    }
    Map<String,Object> validateProvider(Map<String,Object> input, Map<String,Object> previous, long priority) {
        Map<String,Object> p = previous == null ? obj() : map(copy(previous));
        String provider = previous == null ? text(input, "provider", "custom") : str(previous.get("provider")); Map<String,Object> preset = preset(provider);
        for (String k : new String[]{"name", "baseUrl", "apiKey", "defaultModel", "protocol"}) {
            Object value = input.containsKey(k) ? input.get(k) : p.containsKey(k) ? p.get(k) : preset.get(k);
            if (k.equals("apiKey") && value == null) value = "";
            if (!(value instanceof String) || str(value).length() > 8192 || str(value).matches("(?s).*[\\x00-\\x1f\\x7f].*")) throw new IllegalArgumentException("Invalid " + k);
            p.put(k, str(value).trim());
        }
        p.put("baseUrl", baseUrl(p.get("baseUrl")));
        if (!arr("openai", "anthropic").contains(p.get("protocol"))) throw new IllegalArgumentException("Invalid protocol");
        if (str(p.get("name")).isEmpty() || str(p.get("defaultModel")).isEmpty()) throw new IllegalArgumentException("Name and model required");
        String host = URI.create(str(p.get("baseUrl"))).getHost(); boolean local = host.equals("localhost") || host.equals("127.0.0.1") || host.equals("[::1]") || host.startsWith("192.168.") || host.startsWith("10.");
        if (str(p.get("apiKey")).isEmpty() && yes(preset.get("requiresKey")) && !local) throw new IllegalArgumentException("Provider API key required");
        if (str(p.get("apiKey")).isEmpty()) p.put("apiKey", "local-no-key");
        if (previous == null) {
            p.putAll(obj("id", id("prv-"), "provider", provider, "enabled", true, "priority", priority, "createdAt", System.currentTimeMillis()));
            for (String k : new String[]{"requestCount", "errorCount", "failoverCount", "promptTokens", "completionTokens", "totalLatencyMs"}) p.put(k, 0);
        }
        p.remove("cooldownUntil"); p.remove("lastError"); return p;
    }
    synchronized List<Object> addProviders(List<Object> items, boolean discovered) throws IOException {
        if (items.isEmpty() || items.size() > 100) throw new IllegalArgumentException("Batch requires 1..100 providers");
        Map<String,Object> next = snapshot(); List<Object> pool = list(next.get("providers")), result = arr(); long priority = 0;
        for (Object raw : pool) priority = Math.max(priority, num(map(raw).get("priority")));
        for (Object raw : items) {
            Map<String,Object> input = map(copy(raw));
            if (discovered && str(input.get("apiKey")).isEmpty()) {
                String url = baseUrl(input.get("baseUrl"));
                for (Object saved : pool) if (url.equals(map(saved).get("baseUrl")) && !str(map(saved).get("apiKey")).isEmpty()) { input.put("apiKey", map(saved).get("apiKey")); break; }
            }
            Map<String,Object> p = validateProvider(input, null, ++priority); pool.add(p); result.add(safeProvider(p));
        }
        commit(next); return result; // A single durable commit only after every item validated.
    }
    static Map<String,Object> find(List<Object> pool, String field, String id) {
        for (Object raw : pool) if (id.equals(map(raw).get(field))) return map(raw);
        throw new Gateway.Failure(404, "not_found", "Entry not found");
    }
    static void increment(Map<String,Object> m, String key, long amount) { m.put(key, num(m.get(key)) + amount); }
    static Map<String,Object> safeProvider(Map<String,Object> p) {
        Map<String,Object> s = map(copy(p)); String key = str(s.remove("apiKey"));
        s.put("keyPrefix", key.isEmpty() ? "sem-chave" : "***");
        if (!key.isEmpty() && s.get("lastError") instanceof String) s.put("lastError", str(s.get("lastError")).replace(key, "[redacted]"));
        return s;
    }
    static Map<String,Object> safeAccount(Map<String,Object> a) {
        Map<String,Object> s = obj();
        for (String k : new String[]{"uid", "nickname", "email", "realm", "source", "expiresAt", "enabled", "userType", "organizationName", "creditsRemain", "creditsUsed", "creditsSize", "quotaBuckets", "planName", "checkinClaimedToday", "lastCheckinAt", "lastQuotaSyncAt", "cooldownUntil", "lastError", "requestCount", "createdAt"}) if (a.containsKey(k)) s.put(k, a.get(k));
        s.put("tokenPrefix", "***"); if (!s.containsKey("quotaBuckets")) s.put("quotaBuckets", arr()); return s;
    }
    synchronized List<Object> providers() {
        List<Object> p = list(copy(state.get("providers"))); p.sort((a,b) -> Long.compare(num(map(a).get("priority")), num(map(b).get("priority")))); return p;
    }
    synchronized Map<String,Object> overview() {
        Map<String,Object> s = snapshot(), settings = map(s.get("settings")); List<Object> accounts = arr(), providers = arr();
        long enabled = 0, cooling = 0, pe = 0; double remain = 0, used = 0, size = 0;
        for (Object raw : list(s.get("accounts"))) {
            Map<String,Object> a = map(raw); accounts.add(safeAccount(a)); if (yes(a.get("enabled"))) enabled++;
            if (num(a.get("cooldownUntil")) > System.currentTimeMillis()/1000) cooling++;
            remain += number(a.get("creditsRemain")); used += number(a.get("creditsUsed")); size += number(a.get("creditsSize"));
        }
        for (Object raw : providers()) { providers.add(safeProvider(map(raw))); if (yes(map(raw).get("enabled"))) pe++; }
        return obj("version", "2.1.0-android", "uptimeSec", (System.currentTimeMillis()-started)/1000, "defaultRealm", settings.get("defaultRealm"), "autoRealm", settings.get("autoRealm"), "accounts", accounts, "providers", providers,
            "totals", obj("accountsTotal", accounts.size(), "accountsEnabled", enabled, "accountsInCooldown", cooling, "providersTotal", providers.size(), "providersEnabled", pe, "creditsRemain", remain, "creditsUsed", used, "creditsSize", size, "totalRequests", s.get("totalRequests")),
            "risk", s.get("risk"), "settings", settings, "apiKeys", s.get("apiKeys"), "recentLogs", list(s.get("logs")).subList(0, Math.min(60, list(s.get("logs")).size())),
            "nativeCapabilities", obj("externalApis", true, "qoder", false, "streaming", "buffered: complete provider response validated before SSE; no token-by-token delivery"));
    }
    static double number(Object v) { return v instanceof Number ? ((Number)v).doubleValue() : 0; }
    synchronized void record(String providerId, boolean success, boolean failover, Map<String,Object> log, long cooldown) throws IOException {
        Map<String,Object> next = snapshot();
        for (Object raw : list(next.get("providers"))) {
            Map<String,Object> p = map(raw); if (!str(p.get("id")).equals(providerId)) continue;
            if (success) {
                increment(p, "requestCount", 1); if (failover) increment(p, "failoverCount", 1);
                increment(p, "promptTokens", num(log.get("promptTokens"))); increment(p, "completionTokens", num(log.get("completionTokens"))); increment(p, "totalLatencyMs", num(log.get("latencyMs")));
                p.remove("lastError"); p.remove("cooldownUntil");
            } else { increment(p, "errorCount", 1); p.put("lastError", log.get("error")); if (cooldown > 0) p.put("cooldownUntil", System.currentTimeMillis()/1000 + cooldown); }
        }
        increment(next, "totalRequests", 1); log.put("id", id("log-")); log.put("timestamp", System.currentTimeMillis());
        List<Object> logs = list(next.get("logs")); logs.add(0, log); while (logs.size() > 200) logs.remove(logs.size()-1);
        if (num(log.get("status")) == 429) increment(map(next.get("risk")), "rateLimitCount", 1); commit(next);
    }
}
