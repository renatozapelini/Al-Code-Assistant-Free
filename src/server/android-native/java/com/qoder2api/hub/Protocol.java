package com.qoder2api.hub;

import java.util.*;
import static com.qoder2api.hub.Json.*;

/** Stateless function-tool bridge. Hosted tools/stateful Responses/audio are explicitly unsupported.
 * Android deliberately buffers and validates a whole attempt before emitting any client SSE. */
public final class Protocol {
    private Protocol() {}
    static String required(Object value, String label) {
        if (!(value instanceof String) || str(value).isEmpty()) throw new IllegalArgumentException(label + " must be a nonempty string"); return str(value);
    }
    static void unsupported(String message) { throw new Gateway.Failure(400, "unsupported_feature", message); }
    static List<Object> content(Object raw, boolean anthropic) {
        if (raw == null) return arr(); if (raw instanceof String) return arr(obj("type", "text", "text", raw));
        List<Object> out = arr();
        for (Object v : list(raw)) {
            Map<String,Object> b = map(copy(v)); String type = str(b.get("type"));
            if (arr("text", "input_text", "output_text").contains(type)) { if (!(b.get("text") instanceof String)) throw new IllegalArgumentException("Text block must contain text"); b.put("type", "text"); }
            else if (type.equals("input_image")) b = obj("type", "image_url", "image_url", obj("url", required(b.get("image_url"), "image_url")));
            else if (type.equals("image_url")) required(map(b.get("image_url")).get("url"), "image URL");
            else if (type.equals("image")) {
                Map<String,Object> s = map(b.get("source")); String st = str(s.get("type"));
                if (!arr("url", "base64").contains(st)) unsupported("Unsupported image source");
                if (!anthropic) b = obj("type", "image_url", "image_url", obj("url", st.equals("url") ? required(s.get("url"), "image URL") : "data:" + required(s.get("media_type"), "media_type") + ";base64," + required(s.get("data"), "image data")));
            } else if (anthropic && arr("thinking", "redacted_thinking").contains(type)) {
                if (type.equals("thinking")) required(b.get("signature"), "signed thinking signature");
            } else unsupported("Unsupported content block: " + type);
            out.add(b);
        }
        return out;
    }
    static Map<String,Object> call(Object raw) {
        Map<String,Object> c = map(raw), f = map(c.get("function"));
        if (!"function".equals(c.get("type"))) unsupported("Only function tools are supported");
        String args = required(f.get("arguments"), "function arguments"); map(parse(args));
        return obj("id", required(c.get("id"), "tool call id"), "type", "function", "function", obj("name", required(f.get("name"), "function name"), "arguments", args));
    }
    static List<Object> tools(Object raw, boolean flat) {
        List<Object> out = arr();
        for (Object v : list(raw)) {
            Map<String,Object> t = map(v); if (!"function".equals(t.get("type"))) unsupported("Only function tool definitions are supported (no hosted tools)");
            Map<String,Object> f = map(flat ? t : t.get("function"));
            Map<String,Object> fn = obj("name", required(f.get("name"), "function name"), "parameters", f.containsKey("parameters") ? map(f.get("parameters")) : obj("type", "object", "properties", obj()));
            for (String k : new String[]{"description", "strict"}) if (f.containsKey(k)) fn.put(k, f.get(k)); out.add(obj("type", "function", "function", fn));
        }
        return out;
    }
    public static Map<String,Object> normalize(Map<String,Object> body, String kind) {
        Map<String,Object> c = obj("model", text(body, "model", "auto-failover"), "messages", arr()); List<Object> messages = list(c.get("messages"));
        for (String k : new String[]{"audio", "modalities", "prediction", "previous_response_id", "conversation", "background"}) if (body.containsKey(k) && body.get(k) != null && !Boolean.FALSE.equals(body.get(k))) unsupported(k + " is not supported by this native gateway");
        if (num(body.get("n")) > 1) unsupported("Only n=1 is supported");
        if (yes(body.get("store"))) unsupported("Stateful Responses storage is unsupported; send complete input history");
        if (kind.equals("anthropic")) {
            if (body.containsKey("system")) messages.add(obj("role", "system", "content", content(body.get("system"), true)));
            for (Object raw : list(body.get("messages"))) {
                Map<String,Object> m = map(raw); String role = str(m.get("role")); if (!arr("user", "assistant").contains(role)) throw new IllegalArgumentException("Invalid Anthropic message role");
                List<Object> blocks = m.get("content") instanceof String ? content(m.get("content"), true) : list(m.get("content"));
                Map<String,Object> current = null;
                for (Object block : blocks) {
                    Map<String,Object> b = map(block); String type = str(b.get("type"));
                    if (type.equals("tool_result")) {
                        if (!role.equals("user")) throw new IllegalArgumentException("tool_result requires user role"); current = null;
                        Map<String,Object> result = obj("role", "tool", "tool_call_id", required(b.get("tool_use_id"), "tool_use_id"), "content", content(b.get("content"), true));
                        if (b.containsKey("is_error")) { if (!(b.get("is_error") instanceof Boolean)) throw new IllegalArgumentException("is_error must be boolean"); result.put("is_error", b.get("is_error")); }
                        messages.add(result); continue;
                    }
                    if (current == null) { current = obj("role", role, "content", arr()); messages.add(current); }
                    if (type.equals("tool_use")) {
                        if (!role.equals("assistant")) throw new IllegalArgumentException("tool_use requires assistant role");
                        if (!current.containsKey("tool_calls")) current.put("tool_calls", arr());
                        list(current.get("tool_calls")).add(call(obj("id", b.get("id"), "type", "function", "function", obj("name", b.get("name"), "arguments", stringify(map(b.get("input")))))));
                    } else list(current.get("content")).addAll(content(arr(b), true));
                }
                if (blocks.isEmpty()) messages.add(obj("role", role, "content", arr()));
            }
            if (body.containsKey("tools")) {
                List<Object> ts = arr(); for (Object raw : list(body.get("tools"))) { Map<String,Object> t = map(raw);
                    if (t.containsKey("type")) unsupported("Anthropic hosted tools are unsupported");
                    ts.add(obj("type", "function", "function", obj("name", required(t.get("name"), "tool name"), "description", text(t, "description", ""), "parameters", map(t.get("input_schema")))));
                } c.put("tools", ts);
            }
            if (body.containsKey("tool_choice")) {
                Map<String,Object> t = map(body.get("tool_choice")); String type = str(t.get("type"));
                if (arr("auto", "none", "any").contains(type)) c.put("tool_choice", type.equals("any") ? "required" : type);
                else if (type.equals("tool")) c.put("tool_choice", obj("type", "function", "function", obj("name", required(t.get("name"), "tool_choice name"))));
                else unsupported("Unsupported Anthropic tool_choice");
                if (t.containsKey("disable_parallel_tool_use")) c.put("parallel_tool_calls", !yes(t.get("disable_parallel_tool_use")));
            }
            if (body.containsKey("stop_sequences")) c.put("stop", body.get("stop_sequences"));
            for (String k : new String[]{"thinking", "output_config"}) if (body.containsKey(k)) c.put(k, copy(body.get(k)));
        } else if (kind.equals("responses")) {
            if (body.containsKey("instructions") && body.get("instructions") != null) messages.add(obj("role", "system", "content", content(body.get("instructions"), false)));
            Object input = body.get("input"); if (input instanceof String) messages.add(obj("role", "user", "content", content(input, false)));
            else for (Object raw : list(input)) {
                Map<String,Object> m = map(raw); String type = text(m, "type", "message");
                if (type.equals("function_call")) messages.add(obj("role", "assistant", "content", null, "tool_calls", arr(call(obj("id", m.get("call_id"), "type", "function", "function", obj("name", m.get("name"), "arguments", m.get("arguments")))))));
                else if (type.equals("function_call_output")) messages.add(obj("role", "tool", "tool_call_id", required(m.get("call_id"), "call_id"), "content", content(m.get("output"), false)));
                else if (type.equals("message")) messages.add(obj("role", required(m.get("role"), "role"), "content", content(m.get("content"), false)));
                else unsupported("Unsupported Responses input item: " + type);
            }
            if (body.containsKey("tools")) c.put("tools", tools(body.get("tools"), true));
            if (body.containsKey("tool_choice")) {
                Object raw = body.get("tool_choice");
                if (raw instanceof Map) { Map<String,Object> t = map(raw); if (!"function".equals(t.get("type"))) unsupported("Unsupported Responses tool_choice"); c.put("tool_choice", obj("type", "function", "function", obj("name", required(t.get("name"), "tool name")))); }
                else c.put("tool_choice", raw);
            }
            if (body.containsKey("max_output_tokens")) c.put("max_tokens", body.get("max_output_tokens"));
            if (body.containsKey("text")) { Map<String,Object> t = map(body.get("text")); if (t.containsKey("format")) {
                Map<String,Object> f = map(t.get("format")); c.put("response_format", "json_schema".equals(f.get("type")) ? obj("type", "json_schema", "json_schema", f) : f);
            } }
            if (body.containsKey("reasoning")) unsupported("Responses reasoning options are unsupported by this bridge");
        } else {
            for (Object raw : list(body.get("messages"))) {
                Map<String,Object> m = map(copy(raw));
                if (m.containsKey("tool_calls")) { List<Object> calls = arr(); for (Object t : list(m.get("tool_calls"))) calls.add(call(t)); m.put("tool_calls", calls); }
                if (m.get("content") instanceof List) m.put("content", content(m.get("content"), true));
                else if (m.get("content") != null && !(m.get("content") instanceof String)) throw new IllegalArgumentException("Invalid message content");
                if (m.containsKey("function_call") || "function".equals(m.get("role"))) unsupported("Legacy functions are unsupported; use tools");
                messages.add(m);
            }
            if (body.containsKey("tools")) c.put("tools", tools(body.get("tools"), false));
            if (body.containsKey("tool_choice")) c.put("tool_choice", body.get("tool_choice"));
        }
        for (String k : new String[]{"max_tokens", "temperature", "top_p", "stop", "parallel_tool_calls", "response_format", "seed", "presence_penalty", "frequency_penalty", "logit_bias", "reasoning_effort"}) if (body.containsKey(k)) c.put(k, copy(body.get(k)));
        if (body.containsKey("max_completion_tokens")) c.put("max_tokens", body.get("max_completion_tokens"));
        if (body.containsKey("functions")) unsupported("Legacy functions unsupported; use function tools");
        if (messages.isEmpty()) throw new IllegalArgumentException("At least one message required");
        for (Object raw : messages) {
            Map<String,Object> m = map(raw); String role = str(m.get("role"));
            if (!arr("system", "developer", "user", "assistant", "tool").contains(role)) throw new IllegalArgumentException("Invalid message role");
            if (role.equals("tool")) required(m.get("tool_call_id"), "tool_call_id");
            if (m.containsKey("tool_calls") && !role.equals("assistant")) throw new IllegalArgumentException("tool_calls require assistant role");
            if (m.containsKey("tool_call_id") && !role.equals("tool")) throw new IllegalArgumentException("tool_call_id requires tool role");
        }
        if (c.containsKey("max_tokens") && (!(c.get("max_tokens") instanceof Number) || num(c.get("max_tokens")) < 1)) throw new IllegalArgumentException("Invalid max_tokens");
        if (c.containsKey("tool_choice") && c.get("tool_choice") instanceof String && !arr("auto", "none", "required").contains(c.get("tool_choice"))) throw new IllegalArgumentException("Invalid tool_choice");
        return c;
    }
    static List<Object> anthropicBlocks(Object raw) {
        List<Object> out = arr();
        for (Object v : content(raw, true)) {
            Map<String,Object> b = map(v);
            if ("image_url".equals(b.get("type"))) {
                Map<String,Object> im = map(b.get("image_url")); if (im.containsKey("detail") && !"auto".equals(im.get("detail"))) unsupported("Image detail has no Anthropic equivalent");
                String u = str(im.get("url")); Map<String,Object> source;
                if (u.startsWith("http://") || u.startsWith("https://")) source = obj("type", "url", "url", u);
                else if (u.matches("data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*")) { int split = u.indexOf(";base64,"); source = obj("type", "base64", "media_type", u.substring(5, split), "data", u.substring(split+8)); }
                else { unsupported("Invalid Anthropic image URL"); return out; }
                b = obj("type", "image", "source", source);
            }
            out.add(b);
        }
        return out;
    }
    public static Map<String,Object> upstream(Map<String,Object> canonical, String model, boolean anthropic, String baseUrl) {
        Map<String,Object> request = upstream(canonical, model, anthropic);
        // Official OpenAI Chat Completions uses max_completion_tokens (including reasoning).
        // Other OpenAI-compatible endpoints may still require max_tokens.
        boolean official = false;
        try { official = "api.openai.com".equalsIgnoreCase(new java.net.URI(baseUrl).getHost()); }
        catch (java.net.URISyntaxException ignored) {}
        if (!anthropic && official && request.containsKey("max_tokens")) {
            request.put("max_completion_tokens", request.remove("max_tokens"));
        }
        return request;
    }
    public static Map<String,Object> upstream(Map<String,Object> canonical, String model, boolean anthropic) {
        Map<String,Object> c = map(copy(canonical)); c.put("model", model); c.put("stream", false);
        if (!anthropic) {
            if (c.containsKey("thinking") || c.containsKey("output_config")) unsupported("Anthropic thinking/output_config cannot be sent to an OpenAI provider");
            for (Object raw : list(c.get("messages"))) {
                Map<String,Object> m = map(raw); if (m.containsKey("is_error")) unsupported("Anthropic is_error tool result has no OpenAI equivalent");
                if (m.get("content") instanceof List) m.put("content", content(m.get("content"), false));
            }
            return c;
        }
        Map<String,Object> out = obj("model", model, "stream", false, "max_tokens", c.containsKey("max_tokens") ? c.get("max_tokens") : 4096, "messages", arr()); List<Object> system = arr(), messages = list(out.get("messages"));
        for (Object raw : list(c.get("messages"))) {
            Map<String,Object> m = map(raw); String role = str(m.get("role"));
            if (m.containsKey("name") || !str(m.get("reasoning_content")).isEmpty()) unsupported("Named messages/unsigned reasoning cannot be converted to Anthropic");
            List<Object> blocks = anthropicBlocks(m.get("content"));
            if (role.equals("system") || role.equals("developer")) {
                for (Object b : blocks) if (!"text".equals(map(b).get("type"))) unsupported("System must be text"); system.addAll(blocks); continue;
            }
            if (role.equals("tool")) { Map<String,Object> result = obj("type", "tool_result", "tool_use_id", m.get("tool_call_id"), "content", blocks); if (m.containsKey("is_error")) result.put("is_error", m.get("is_error")); blocks = arr(result); role = "user"; }
            if (m.containsKey("tool_calls")) for (Object rawCall : list(m.get("tool_calls"))) {
                Map<String,Object> tc = call(rawCall), f = map(tc.get("function")); blocks.add(obj("type", "tool_use", "id", tc.get("id"), "name", f.get("name"), "input", map(parse(str(f.get("arguments"))))));
            }
            if (!messages.isEmpty() && role.equals(map(messages.get(messages.size()-1)).get("role"))) list(map(messages.get(messages.size()-1)).get("content")).addAll(blocks);
            else messages.add(obj("role", role, "content", blocks));
        }
        if (!system.isEmpty()) out.put("system", system);
        for (String k : new String[]{"temperature", "top_p", "thinking", "output_config"}) if (c.containsKey(k)) out.put(k, c.get(k));
        if (c.containsKey("stop")) out.put("stop_sequences", c.get("stop") instanceof String ? arr(c.get("stop")) : c.get("stop"));
        for (String k : new String[]{"seed", "presence_penalty", "frequency_penalty", "logit_bias"}) if (c.containsKey(k)) unsupported(k + " has no Anthropic equivalent");
        if (c.containsKey("reasoning_effort")) unsupported("reasoning_effort conversion unsupported; use native Anthropic thinking options");
        if (c.containsKey("response_format")) { Map<String,Object> format = map(c.get("response_format")); if (!"text".equals(format.get("type"))) unsupported("Structured response_format conversion to Anthropic unsupported"); }
        if (c.containsKey("tools")) {
            List<Object> ts = arr(); for (Object raw : list(c.get("tools"))) { Map<String,Object> f = map(map(raw).get("function")); if (yes(f.get("strict"))) unsupported("Strict function schemas have no Anthropic equivalent"); ts.add(obj("name", f.get("name"), "description", text(f, "description", ""), "input_schema", f.get("parameters"))); } out.put("tools", ts);
        }
        if (c.containsKey("tool_choice")) {
            Object choice = c.get("tool_choice");
            if (choice instanceof String) out.put("tool_choice", obj("type", choice.equals("required") ? "any" : choice));
            else { Map<String,Object> choiceMap = map(choice); if (!"function".equals(choiceMap.get("type"))) unsupported("Unsupported tool_choice"); out.put("tool_choice", obj("type", "tool", "name", required(map(choiceMap.get("function")).get("name"), "tool choice name"))); }
        }
        if (c.containsKey("parallel_tool_calls")) { Map<String,Object> choice = out.containsKey("tool_choice") ? map(out.get("tool_choice")) : obj("type", "auto"); choice.put("disable_parallel_tool_use", !yes(c.get("parallel_tool_calls"))); out.put("tool_choice", choice); }
        return out;
    }
    public static Map<String,Object> completion(Map<String,Object> response, boolean anthropic, String model) {
        if (response.containsKey("error")) throw new Gateway.Failure(502, "upstream_error", "Provider returned an error envelope");
        if (!anthropic) {
            List<Object> choices = list(response.get("choices")); if (choices.size() != 1) throw new Gateway.Failure(502, "upstream_error", "Provider must return one complete choice");
            Map<String,Object> choice = map(choices.get(0)), m = map(choice.get("message"));
            String stop = str(choice.get("finish_reason"));
            if (!arr("stop", "tool_calls", "content_filter").contains(stop) || !"assistant".equals(m.get("role"))) throw new Gateway.Failure(502, "truncated_response", "Incomplete provider completion");
            List<Object> calls = m.containsKey("tool_calls") ? list(m.get("tool_calls")) : arr();
            for (Object c : calls) call(c);
            if (!(m.get("content") instanceof String) && m.get("content") != null) throw new Gateway.Failure(502, "unsupported_upstream_output", "Provider returned unsupported output content");
            if ((str(m.get("content")).trim().isEmpty() && calls.isEmpty()) || (stop.equals("tool_calls") && calls.isEmpty())) throw new Gateway.Failure(502, "upstream_error", "Provider returned an empty completion");
            validateUsage(response, "usage", "prompt_tokens", "completion_tokens", "total_tokens");
            response.put("model", model); if (!response.containsKey("id")) response.put("id", HubState.id("chatcmpl-")); if (!response.containsKey("created")) response.put("created", System.currentTimeMillis()/1000); response.put("object", "chat.completion");
            if (!response.containsKey("usage")) response.put("usage", obj("prompt_tokens", 0, "completion_tokens", 0, "total_tokens", 0)); return response;
        }
        if (!"message".equals(response.get("type")) || !"assistant".equals(response.get("role")) || !arr("end_turn", "tool_use", "stop_sequence").contains(response.get("stop_reason"))) throw new Gateway.Failure(502, "truncated_response", "Incomplete Anthropic message");
        validateUsage(response, "usage", "input_tokens", "output_tokens");
        StringBuilder text = new StringBuilder(); List<Object> calls = arr(), nativeBlocks = list(response.get("content"));
        for (Object raw : nativeBlocks) {
            Map<String,Object> b = map(raw); String type = str(b.get("type"));
            if (type.equals("text")) { if (!(b.get("text") instanceof String)) throw new Gateway.Failure(502, "upstream_error", "Invalid provider text"); text.append(str(b.get("text"))); }
            else if (type.equals("tool_use")) calls.add(call(obj("id", b.get("id"), "type", "function", "function", obj("name", b.get("name"), "arguments", stringify(map(b.get("input")))))));
            else if (!arr("thinking", "redacted_thinking").contains(type)) throw new Gateway.Failure(502, "unsupported_upstream_output", "Unsupported Anthropic output block: " + type);
        }
        if ((text.toString().trim().isEmpty() && calls.isEmpty()) || ("tool_use".equals(response.get("stop_reason")) && calls.isEmpty())) throw new Gateway.Failure(502, "upstream_error", "Provider returned an empty message");
        Map<String,Object> m = obj("role", "assistant", "content", text.length() == 0 && !calls.isEmpty() ? null : text.toString()); if (!calls.isEmpty()) m.put("tool_calls", calls);
        Map<String,Object> u = response.get("usage") instanceof Map ? map(response.get("usage")) : obj(); long pt = num(u.get("input_tokens")), ct = num(u.get("output_tokens"));
        String stop = str(response.get("stop_reason"));
        return obj("id", text(response, "id", HubState.id("chatcmpl-")), "object", "chat.completion", "created", System.currentTimeMillis()/1000, "model", model, "choices", arr(obj("index", 0, "message", m, "finish_reason", stop.equals("tool_use") ? "tool_calls" : stop.equals("max_tokens") ? "length" : "stop")), "usage", obj("prompt_tokens", pt, "completion_tokens", ct, "total_tokens", pt+ct), "_anthropic", response);
    }
    static void validateUsage(Map<String,Object> response, String key, String... fields) {
        if (!response.containsKey(key)) return;
        Map<String,Object> usage = map(response.get(key));
        for (String field : fields) if (usage.containsKey(field)) {
            Object n = usage.get(field);
            if (!(n instanceof Number) || ((Number)n).doubleValue() < 0 || ((Number)n).doubleValue() != num(n)) throw new Gateway.Failure(502, "upstream_error", "Invalid provider usage");
        }
    }
    static Map<String,Object> message(Map<String,Object> c) { return map(map(list(c.get("choices")).get(0)).get("message")); }
    static String finish(Map<String,Object> c) { return str(map(list(c.get("choices")).get(0)).get("finish_reason")); }
    public static Map<String,Object> output(Map<String,Object> c, String kind) {
        if (kind.equals("openai")) { Map<String,Object> out = map(copy(c)); out.remove("_anthropic"); return out; }
        Map<String,Object> m = message(c), u = map(c.get("usage")); List<Object> calls = m.containsKey("tool_calls") ? list(m.get("tool_calls")) : arr();
        if (kind.equals("anthropic")) {
            if (c.containsKey("_anthropic")) return metadata(map(copy(c.get("_anthropic"))), c);
            List<Object> blocks = arr(); if (!str(m.get("content")).isEmpty()) blocks.add(obj("type", "text", "text", m.get("content")));
            for (Object raw : calls) { Map<String,Object> tc = call(raw), f = map(tc.get("function")); blocks.add(obj("type", "tool_use", "id", tc.get("id"), "name", f.get("name"), "input", map(parse(str(f.get("arguments")))))); }
            return metadata(obj("id", "msg_" + str(c.get("id")), "type", "message", "role", "assistant", "model", c.get("model"), "content", blocks, "stop_reason", finish(c).equals("tool_calls") ? "tool_use" : finish(c).equals("length") ? "max_tokens" : "end_turn", "stop_sequence", null, "usage", obj("input_tokens", u.get("prompt_tokens"), "output_tokens", u.get("completion_tokens"))), c);
        }
        List<Object> items = arr(); String text = str(m.get("content"));
        if (!text.isEmpty()) items.add(obj("id", HubState.id("msg_"), "type", "message", "status", "completed", "role", "assistant", "content", arr(obj("type", "output_text", "text", text, "annotations", arr()))));
        for (Object raw : calls) { Map<String,Object> tc = call(raw), f = map(tc.get("function")); items.add(obj("id", "fc_"+tc.get("id"), "type", "function_call", "status", "completed", "call_id", tc.get("id"), "name", f.get("name"), "arguments", f.get("arguments"))); }
        boolean incomplete = finish(c).equals("length");
        return metadata(obj("id", "resp_" + c.get("id"), "object", "response", "created_at", c.get("created"), "model", c.get("model"), "status", incomplete ? "incomplete" : "completed", "error", null, "incomplete_details", incomplete ? obj("reason", "max_output_tokens") : null, "output", items, "output_text", text, "usage", obj("input_tokens", u.get("prompt_tokens"), "output_tokens", u.get("completion_tokens"), "total_tokens", u.get("total_tokens"))), c);
    }
    static Map<String,Object> metadata(Map<String,Object> out, Map<String,Object> c) {
        if (c.containsKey("qoder_meta")) out.put("qoder_meta", copy(c.get("qoder_meta"))); return out;
    }
    static void event(StringBuilder b, String name, Object data) { if (name != null) b.append("event: ").append(name).append('\n'); b.append("data: ").append(stringify(data)).append("\n\n"); }
    public static String sse(Map<String,Object> c, String kind) {
        StringBuilder b = new StringBuilder(); Map<String,Object> out = output(c, kind);
        if (kind.equals("openai")) {
            Map<String,Object> base = metadata(obj("id", c.get("id"), "object", "chat.completion.chunk", "created", c.get("created"), "model", c.get("model")), c);
            Map<String,Object> delta = map(copy(message(c))); if (delta.containsKey("tool_calls")) { int i = 0; for (Object raw : list(delta.get("tool_calls"))) map(raw).put("index", i++); }
            base.put("choices", arr(obj("index", 0, "delta", delta, "finish_reason", null))); event(b, null, base);
            base.put("choices", arr(obj("index", 0, "delta", obj(), "finish_reason", finish(c)))); base.put("usage", c.get("usage")); if (c.containsKey("qoder_meta")) base.put("qoder_meta", c.get("qoder_meta")); event(b, null, base); b.append("data: [DONE]\n\n");
        } else if (kind.equals("anthropic")) {
            Map<String,Object> start = map(copy(out)); start.put("content", arr()); start.put("stop_reason", null); start.put("stop_sequence", null); map(start.get("usage")).put("output_tokens", 0);
            event(b, "message_start", obj("type", "message_start", "message", start)); int i = 0;
            for (Object raw : list(out.get("content"))) {
                Map<String,Object> block = map(raw), empty = map(copy(block)); String type = str(block.get("type"));
                if (type.equals("text")) empty.put("text", ""); else if (type.equals("tool_use")) empty.put("input", obj()); else if (type.equals("thinking")) { empty.put("thinking", ""); empty.put("signature", ""); }
                event(b, "content_block_start", obj("type", "content_block_start", "index", i, "content_block", empty));
                if (type.equals("text")) event(b, "content_block_delta", obj("type", "content_block_delta", "index", i, "delta", obj("type", "text_delta", "text", block.get("text"))));
                else if (type.equals("tool_use")) event(b, "content_block_delta", obj("type", "content_block_delta", "index", i, "delta", obj("type", "input_json_delta", "partial_json", stringify(block.get("input")))));
                else if (type.equals("thinking")) { event(b, "content_block_delta", obj("type", "content_block_delta", "index", i, "delta", obj("type", "thinking_delta", "thinking", block.get("thinking")))); event(b, "content_block_delta", obj("type", "content_block_delta", "index", i, "delta", obj("type", "signature_delta", "signature", block.get("signature")))); }
                event(b, "content_block_stop", obj("type", "content_block_stop", "index", i++));
            }
            event(b, "message_delta", obj("type", "message_delta", "delta", obj("stop_reason", out.get("stop_reason"), "stop_sequence", out.get("stop_sequence")), "usage", obj("output_tokens", map(out.get("usage")).get("output_tokens")))); event(b, "message_stop", obj("type", "message_stop"));
        } else {
            Map<String,Object> start = map(copy(out)); start.put("output", arr()); start.put("output_text", ""); start.put("status", "in_progress"); int seq = 0;
            event(b, "response.created", obj("type", "response.created", "sequence_number", seq++, "response", start)); event(b, "response.in_progress", obj("type", "response.in_progress", "sequence_number", seq++, "response", start)); int index = 0;
            for (Object raw : list(out.get("output"))) {
                Map<String,Object> item = map(raw), initial = map(copy(item)); initial.put("status", "in_progress"); boolean function = "function_call".equals(item.get("type"));
                if (function) initial.put("arguments", ""); else initial.put("content", arr());
                event(b, "response.output_item.added", obj("type", "response.output_item.added", "sequence_number", seq++, "output_index", index, "item", initial));
                if (function) {
                    event(b, "response.function_call_arguments.delta", obj("type", "response.function_call_arguments.delta", "sequence_number", seq++, "item_id", item.get("id"), "output_index", index, "delta", item.get("arguments")));
                    event(b, "response.function_call_arguments.done", obj("type", "response.function_call_arguments.done", "sequence_number", seq++, "item_id", item.get("id"), "output_index", index, "arguments", item.get("arguments")));
                } else {
                    Map<String,Object> part = map(list(item.get("content")).get(0)), empty = map(copy(part)); empty.put("text", "");
                    event(b, "response.content_part.added", obj("type", "response.content_part.added", "sequence_number", seq++, "item_id", item.get("id"), "output_index", index, "content_index", 0, "part", empty));
                    event(b, "response.output_text.delta", obj("type", "response.output_text.delta", "sequence_number", seq++, "item_id", item.get("id"), "output_index", index, "content_index", 0, "delta", part.get("text")));
                    event(b, "response.output_text.done", obj("type", "response.output_text.done", "sequence_number", seq++, "item_id", item.get("id"), "output_index", index, "content_index", 0, "text", part.get("text")));
                    event(b, "response.content_part.done", obj("type", "response.content_part.done", "sequence_number", seq++, "item_id", item.get("id"), "output_index", index, "content_index", 0, "part", part));
                }
                event(b, "response.output_item.done", obj("type", "response.output_item.done", "sequence_number", seq++, "output_index", index++, "item", item));
            }
            String end = "response." + out.get("status"); event(b, end, obj("type", end, "sequence_number", seq, "response", out));
        }
        return b.toString();
    }
    /** Handles providers ignoring stream:false. A missing terminal frame is retryable, never partial success. */
    static Map<String,Object> bufferedSse(String text, boolean anthropic) {
        boolean terminal = false, started = false; Set<Integer> openBlocks = new HashSet<>(); Map<String,Object> response = obj(), usage = obj(); StringBuilder result = new StringBuilder(); Map<Integer,Map<String,Object>> tools = new TreeMap<>(), blocks = new TreeMap<>(); String finish = "";
        String normalized = text.replace("\r\n", "\n");
        if (!normalized.endsWith("\n\n")) throw new Gateway.Failure(502, "truncated_response", "Unterminated provider SSE frame");
        for (String frame : normalized.split("\n\n")) {
            StringBuilder data = new StringBuilder(); for (String line : frame.split("\n")) if (line.startsWith("data:")) { if (data.length() > 0) data.append('\n'); data.append(line.substring(5).trim()); }
            if (data.length() == 0) continue;
            if (terminal) throw new Gateway.Failure(502, "upstream_error", "Provider sent data after terminal SSE event");
            if (data.toString().equals("[DONE]")) { if (anthropic) throw new Gateway.Failure(502, "truncated_response", "Anthropic message_stop missing"); terminal = true; continue; }
            Map<String,Object> e = map(parse(data.toString())); if (e.containsKey("error") || "error".equals(e.get("type"))) throw new Gateway.Failure(502, "upstream_error", "Provider SSE error");
            if (anthropic) {
                String type = str(e.get("type")); int i = (int)num(e.get("index"));
                if (type.equals("message_start")) { if (started) throw new Gateway.Failure(502, "upstream_error", "Duplicate provider message_start"); started = true; response = map(e.get("message")); usage = response.get("usage") instanceof Map ? map(response.get("usage")) : obj(); }
                else if (type.equals("content_block_start")) { if (!started || blocks.containsKey(i)) throw new Gateway.Failure(502, "upstream_error", "Invalid provider block start"); openBlocks.add(i); Map<String,Object> block = map(e.get("content_block")); block.put("_partial", ""); blocks.put(i, block); }
                else if (type.equals("content_block_delta")) {
                    Map<String,Object> block = blocks.get(i), delta = map(e.get("delta")); if (block == null || !openBlocks.contains(i)) throw new Gateway.Failure(502, "truncated_response", "SSE block missing or closed"); String dt = str(delta.get("type"));
                    String key = dt.equals("input_json_delta") ? "_partial" : dt.equals("text_delta") ? "text" : dt.equals("thinking_delta") ? "thinking" : dt.equals("signature_delta") ? "signature" : "";
                    if (key.isEmpty()) throw new Gateway.Failure(502, "unsupported_upstream_output", "Unknown SSE block delta"); block.put(key, str(block.get(key)) + str(delta.get(dt.equals("input_json_delta") ? "partial_json" : key)));
                } else if (type.equals("content_block_stop")) { if (!openBlocks.remove(i)) throw new Gateway.Failure(502, "truncated_response", "Invalid provider block stop"); }
                else if (type.equals("message_delta")) { if (!started || !openBlocks.isEmpty()) throw new Gateway.Failure(502, "truncated_response", "Provider blocks were not closed"); response.putAll(map(e.get("delta"))); if (e.get("usage") instanceof Map) usage.putAll(map(e.get("usage"))); }
                else if (type.equals("message_stop")) { if (!started || !openBlocks.isEmpty()) throw new Gateway.Failure(502, "truncated_response", "Incomplete provider SSE message"); terminal = true; }
            } else {
                for (String k : new String[]{"id", "created", "model"}) if (e.containsKey(k)) response.put(k, e.get(k)); if (e.get("usage") instanceof Map) usage = map(e.get("usage"));
                for (Object raw : list(e.get("choices"))) {
                    Map<String,Object> ch = map(raw); if (num(ch.get("index")) != 0) throw new Gateway.Failure(502, "upstream_error", "Multiple SSE choices unsupported");
                    if (ch.get("finish_reason") != null) finish = str(ch.get("finish_reason")); Map<String,Object> delta = map(ch.get("delta")); result.append(str(delta.get("content")));
                    if (delta.containsKey("tool_calls")) for (Object rawCall : list(delta.get("tool_calls"))) {
                        Map<String,Object> tc = map(rawCall); int i = (int)num(tc.get("index")); Map<String,Object> accumulated = tools.get(i);
                        if (accumulated == null) { accumulated = obj("id", "", "type", "function", "function", obj("name", "", "arguments", "")); tools.put(i, accumulated); }
                        if (tc.containsKey("id")) accumulated.put("id", tc.get("id")); if (tc.get("function") instanceof Map) { Map<String,Object> f = map(tc.get("function")), af = map(accumulated.get("function")); for (String k : new String[]{"name", "arguments"}) af.put(k, str(af.get(k)) + str(f.get(k))); }
                    }
                }
            }
        }
        if (!terminal || (!anthropic && finish.isEmpty())) throw new Gateway.Failure(502, "truncated_response", "Provider stream ended without a terminal event");
        if (anthropic) {
            List<Object> bs = arr(); for (Map<String,Object> block : blocks.values()) { String partial = str(block.remove("_partial")); if ("tool_use".equals(block.get("type")) && !partial.isEmpty()) block.put("input", map(parse(partial))); bs.add(block); } response.put("content", bs); response.put("usage", usage); return response;
        }
        Map<String,Object> m = obj("role", "assistant", "content", result.length() == 0 && !tools.isEmpty() ? null : result.toString()); if (!tools.isEmpty()) m.put("tool_calls", new ArrayList<Object>(tools.values())); response.put("choices", arr(obj("index", 0, "message", m, "finish_reason", finish))); response.put("usage", usage); return response;
    }
}
