package com.qoder2api.hub;

import java.io.*;
import java.net.*;
import java.util.*;
import static com.qoder2api.hub.Json.*;

/** Matches external-catalog.json v1, with no credentials stored in catalog or discovery results. */
final class ExternalCatalog {
    final HubState state; private Map<String,Object> cache;
    ExternalCatalog(HubState state) throws IOException {
        this.state = state; File f = new File(state.directory, "external-catalog.json");
        cache = obj("version", 1, "providers", obj("openrouter", obj("models", arr(), "status", obj()), "github", obj("models", arr(), "status", obj())), "manual", arr());
        if (f.exists()) {
            try { Map<String,Object> saved = map(parse(HubState.read(f, 32*1024*1024))); if (num(saved.get("version")) == 1 && saved.get("providers") instanceof Map && saved.get("manual") instanceof List) cache = saved; }
            catch (RuntimeException e) { /* Invalid public catalog cannot reset credential state. */ }
        }
    }
    static String encode(String text) { try { return URLEncoder.encode(text, "UTF-8").replace("+", "%20").replace("%21", "!").replace("%27", "'").replace("%28", "(").replace("%29", ")").replace("%7E", "~"); } catch (Exception e) { throw new IllegalArgumentException(e); } }
    static Map<String,Object> model(String provider, String id, String url, String protocol, String source) {
        return obj("key", "external:"+encode(provider)+":"+encode(url)+":"+protocol+":"+encode(id), "id", id, "modelName", id, "displayName", id, "realm", "intl", "availableRealms", arr(), "priceFactor", 0, "maxInputTokens", 0, "maxOutputTokens", 0, "isVl", false, "isReasoning", false, "enable", true, "source", source, "provider", provider, "baseUrl", url, "protocol", protocol, "updatedAt", System.currentTimeMillis());
    }
    synchronized Map<String,Object> snapshot() {
        LinkedHashMap<String,Object> unique = new LinkedHashMap<>(); Map<String,Object> providers = map(cache.get("providers")), statuses = obj();
        for (String p : new String[]{"openrouter", "github"}) {
            Map<String,Object> c = providers.get(p) instanceof Map ? map(providers.get(p)) : obj("models", arr(), "status", obj()); statuses.put(p, copy(c.get("status")));
            for (Object raw : list(c.get("models"))) unique.put(str(map(raw).get("key")), copy(raw));
        }
        for (Object raw : list(cache.get("manual"))) {
            Map<String,Object> m = map(copy(raw)); String key = str(m.get("key"));
            if (unique.containsKey(key)) { Map<String,Object> merged = map(unique.get(key)); merged.put("source", "manual"); merged.put("displayName", m.get("displayName")); }
            else unique.put(key, m);
        }
        return obj("models", new ArrayList<>(unique.values()), "statuses", statuses, "ttlMs", 3600000, "retryMs", 300000);
    }
    private void persist(Map<String,Object> next) throws IOException { HubState.atomic(new File(state.directory, "external-catalog.json"), next); cache = next; }
    synchronized Map<String,Object> manual(Map<String,Object> input) throws IOException {
        String provider = requiredProvider(input), id = Protocol.required(input.containsKey("modelName") ? input.get("modelName") : input.get("modelId"), "modelName");
        if (id.length() > 256 || id.matches("(?s).*[\\s\\x00-\\x1f\\x7f].*")) throw new IllegalArgumentException("Invalid model ID");
        Map<String,Object> preset = state.preset(provider); String url = HubState.baseUrl(input.containsKey("baseUrl") ? input.get("baseUrl") : preset.get("baseUrl"));
        if (provider.equals("custom") && !input.containsKey("baseUrl")) throw new IllegalArgumentException("Custom model requires baseUrl");
        String protocol = text(input, "protocol", str(preset.get("protocol"))); if (!arr("openai", "anthropic").contains(protocol)) throw new IllegalArgumentException("Invalid protocol");
        Map<String,Object> m = model(provider, id, url, protocol, "manual"); String name = text(input, "displayName", id); if (name.length() > 512 || name.matches("(?s).*[\\x00-\\x1f\\x7f].*")) throw new IllegalArgumentException("Invalid display name"); m.put("displayName", name);
        Map<String,Object> next = map(copy(cache)); List<Object> entries = list(next.get("manual")); entries.removeIf(v -> m.get("key").equals(map(v).get("key"))); if (entries.size() >= 500) throw new IllegalArgumentException("Manual catalog limit reached"); entries.add(m); persist(next);
        Map<String,Object> result = snapshot(); result.put("ok", true); return result;
    }
    String requiredProvider(Map<String,Object> input) { String p = Protocol.required(input.get("provider"), "provider"); state.preset(p); return p; }
    synchronized Map<String,Object> refresh(String provider) throws IOException {
        if (!arr("openrouter", "github").contains(provider)) throw new IllegalArgumentException("provider must be openrouter or github");
        Map<String,Object> previous = map(map(cache.get("providers")).get(provider)), status = map(previous.get("status")); long now = System.currentTimeMillis();
        long stamp = num(status.get(status.containsKey("error") ? "attemptedAt" : "updatedAt"));
        if (stamp > 0 && now - stamp < (status.containsKey("error") ? 300000 : 3600000)) { Map<String,Object> r = snapshot(); r.putAll(obj("ok", !status.containsKey("error"), "cached", true, "message", text(status, "error", "Catalog cache is current"))); return r; }
        List<Object> models = arr(); String error = null;
        try {
            if (provider.equals("github")) throw new IOException("GitHub Models automatic catalog unavailable: observed endpoint returned text/plain OK, not a model catalog. Cache preserved; configure a verified endpoint manually.");
            String url = "https://openrouter.ai/api/v1/models"; Set<String> seen = new HashSet<>();
            while (url != null) {
                if (!seen.add(url) || seen.size() > 20) throw new IOException("Invalid catalog pagination");
                Map<String,Object> payload = Gateway.fetchJson(url, null, "", false, 10000, 8*1024*1024); List<Object> data = list(payload.get("data"));
                if (data.size()+models.size() > 10000) throw new IOException("Catalog model limit exceeded");
                for (Object raw : data) {
                    Map<String,Object> v = map(raw); String id = str(v.get("id")); if (id.isEmpty() || id.length() > 256 || id.matches("(?s).*\\s.*")) continue;
                    Map<String,Object> m = model("openrouter", id, "https://openrouter.ai/api/v1", "openai", "openrouter"); m.put("displayName", text(v, "name", id)); m.put("maxInputTokens", num(v.get("context_length")));
                    Map<String,Object> top = v.get("top_provider") instanceof Map ? map(v.get("top_provider")) : obj(); m.put("maxOutputTokens", num(top.get("max_completion_tokens")));
                    Map<String,Object> pricing = v.get("pricing") instanceof Map ? map(v.get("pricing")) : obj(), price = obj("currency", "USD", "unit", "token");
                    for (String k : new String[]{"prompt", "completion"}) try { double n = Double.parseDouble(String.valueOf(pricing.get(k))); if (Double.isFinite(n) && n >= 0) price.put(k, n); } catch (NumberFormatException ignored) {}
                    m.put("pricing", price); if (v.get("supported_parameters") instanceof List) { List<Object> ps = list(v.get("supported_parameters")); m.put("supportsTools", ps.contains("tools")); m.put("isReasoning", ps.contains("reasoning") || ps.contains("include_reasoning")); }
                    if (v.get("architecture") instanceof Map && map(v.get("architecture")).get("input_modalities") instanceof List) m.put("isVl", list(map(v.get("architecture")).get("input_modalities")).contains("image")); models.add(m);
                }
                Object next = payload.get("links") instanceof Map ? map(payload.get("links")).get("next") : null;
                if (next == null) url = null; else {
                    String href = next instanceof String ? str(next) : str(map(next).get("href")); URI u = URI.create(url).resolve(href);
                    if (href.isEmpty() || !"https".equals(u.getScheme()) || !"openrouter.ai".equals(u.getHost()) || !"/api/v1/models".equals(u.getPath()) || u.getUserInfo() != null || u.getFragment() != null) throw new IOException("Unsafe catalog pagination"); url = u.toString();
                }
            }
            if (models.isEmpty()) throw new IOException("OpenRouter catalog empty or invalid");
        } catch (Exception e) { error = e instanceof Gateway.Failure ? e.getMessage() : provider.equals("github") ? e.getMessage() : "OpenRouter catalog refresh failed; previous cache preserved"; }
        Map<String,Object> next = map(copy(cache)), ns = obj("attemptedAt", now); if (status.containsKey("updatedAt")) ns.put("updatedAt", status.get("updatedAt"));
        if (error != null) ns.put("error", error); else ns.put("updatedAt", now);
        map(next.get("providers")).put(provider, obj("models", error == null ? models : previous.get("models"), "status", ns)); persist(next);
        Map<String,Object> result = snapshot(); result.putAll(obj("ok", error == null, "cached", false, "message", error == null ? "OpenRouter catalog refreshed" : error)); return result;
    }
    Map<String,Object> discover() throws IOException {
        List<Object> found = arr(), probes = arr(), errors = arr(); List<Object> providers = state.providers();
        Map<String,Object> refreshed = refresh("openrouter"); if (!yes(refreshed.get("ok"))) errors.add(refreshed.get("message"));
        for (Object raw : list(snapshot().get("models"))) {
            Map<String,Object> m = map(raw), pricing = m.get("pricing") instanceof Map ? map(m.get("pricing")) : obj();
            if ("openrouter".equals(m.get("provider")) && (str(m.get("id")).endsWith(":free") || (pricing.containsKey("prompt") && pricing.containsKey("completion") && HubState.number(pricing.get("prompt")) == 0 && HubState.number(pricing.get("completion")) == 0))) found.add(discovered(m, "openrouter-free", providers));
        }
        probes.add(obj("provider", "ollama", "baseUrl", "http://127.0.0.1:11434/v1", "apiKey", "")); probes.add(obj("provider", "lmstudio", "baseUrl", "http://127.0.0.1:1234/v1", "apiKey", ""));
        for (Object raw : providers) if (yes(map(raw).get("enabled")) && "openai".equals(map(raw).get("protocol"))) probes.add(raw);
        Set<String> seen = new HashSet<>(); int count = 0;
        for (Object raw : probes) {
            Map<String,Object> p = map(raw); String url = str(p.get("baseUrl")); if (!seen.add(url) || count++ >= 12) continue;
            try {
                Map<String,Object> payload = Gateway.fetchJson(url+"/models", null, str(p.get("apiKey")), false, 1500, 2*1024*1024); int n = 0;
                for (Object v : list(payload.get("data"))) {
                    if (++n > 100) break; String id = str(map(v).get("id")); if (id.isEmpty()) continue;
                    found.add(discovered(model(str(p.get("provider")), id, url, "openai", "manual"), url.startsWith("http://127.0.0.1:") ? "local-scan" : "endpoint-sync", providers));
                }
            } catch (Exception e) { errors.add(obj("provider", p.get("provider"), "message", "Model discovery failed; endpoint not added")); }
        }
        return obj("ok", true, "providers", found, "discovered", found.size(), "total", found.size(), "errors", errors, "scannedAt", System.currentTimeMillis());
    }
    Map<String,Object> discovered(Map<String,Object> m, String source, List<Object> providers) {
        boolean configured = false, keyed = false;
        for (Object raw : providers) { Map<String,Object> p = map(raw); if (m.get("baseUrl").equals(p.get("baseUrl"))) { if (!str(p.get("apiKey")).isEmpty() && !"local-no-key".equals(p.get("apiKey"))) keyed = true; if (m.get("id").equals(p.get("defaultModel"))) configured = true; } }
        boolean requires = yes(state.preset(str(m.get("provider"))).get("requiresKey"));
        return obj("id", m.get("key"), "provider", m.get("provider"), "name", m.get("displayName"), "baseUrl", m.get("baseUrl"), "defaultModel", m.get("modelName"), "protocol", m.get("protocol"), "source", source, "requiresKey", requires, "canAutoAdd", !requires || keyed, "alreadyConfigured", configured, "contextLength", m.get("maxInputTokens"), "description", "Discovered model; availability must be confirmed with provider test");
    }
}
