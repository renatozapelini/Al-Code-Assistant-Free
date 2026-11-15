package com.qoder2api.hub;

import java.util.*;

/** Small strict JSON implementation shared by Android and the dependency-free JVM tests. */
public final class Json {
    private Json() {}
    public static Map<String,Object> obj(Object... pairs) {
        Map<String,Object> m = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) m.put((String)pairs[i], pairs[i + 1]);
        return m;
    }
    public static List<Object> arr(Object... values) { return new ArrayList<>(Arrays.asList(values)); }
    @SuppressWarnings("unchecked") public static Map<String,Object> map(Object v) {
        if (!(v instanceof Map)) throw new IllegalArgumentException("Expected JSON object");
        return (Map<String,Object>)v;
    }
    @SuppressWarnings("unchecked") public static List<Object> list(Object v) {
        if (!(v instanceof List)) throw new IllegalArgumentException("Expected JSON array");
        return (List<Object>)v;
    }
    public static String str(Object v) { return v instanceof String ? (String)v : ""; }
    public static String text(Map<String,Object> m, String k, String fallback) {
        String s = str(m.get(k)); return s.isEmpty() ? fallback : s;
    }
    public static long num(Object v) { return v instanceof Number ? ((Number)v).longValue() : 0; }
    public static boolean yes(Object v) { return Boolean.TRUE.equals(v); }
    public static Object copy(Object v) { return parse(stringify(v)); }
    public static Object parse(String s) {
        Parser p = new Parser(s); Object v = p.value(0); p.ws();
        if (p.i != s.length()) throw new IllegalArgumentException("Trailing JSON data");
        return v;
    }
    public static String stringify(Object v) {
        StringBuilder b = new StringBuilder(); write(b, v, 0); return b.toString();
    }
    private static void write(StringBuilder b, Object v, int depth) {
        if (depth > 64) throw new IllegalArgumentException("JSON nesting exceeds 64");
        if (v == null) b.append("null");
        else if (v instanceof String) {
            b.append('"');
            for (char c : ((String)v).toCharArray()) {
                switch (c) {
                    case '"': b.append("\\\""); break;
                    case '\\': b.append("\\\\"); break;
                    case '\n': b.append("\\n"); break;
                    case '\r': b.append("\\r"); break;
                    case '\t': b.append("\\t"); break;
                    default: if (c < 32) b.append(String.format(Locale.ROOT, "\\u%04x", (int)c)); else b.append(c);
                }
            }
            b.append('"');
        } else if (v instanceof Number) {
            double n = ((Number)v).doubleValue();
            if (Double.isNaN(n) || Double.isInfinite(n)) throw new IllegalArgumentException("Non-finite JSON number");
            b.append(v);
        } else if (v instanceof Boolean) b.append(v);
        else if (v instanceof Map) {
            b.append('{'); boolean first = true;
            for (Map.Entry<String,Object> e : map(v).entrySet()) {
                if (!first) b.append(','); first = false;
                write(b, e.getKey(), depth + 1); b.append(':'); write(b, e.getValue(), depth + 1);
            }
            b.append('}');
        } else if (v instanceof List) {
            b.append('['); boolean first = true;
            for (Object x : list(v)) { if (!first) b.append(','); first = false; write(b, x, depth + 1); }
            b.append(']');
        } else throw new IllegalArgumentException("Not a JSON value");
    }
    private static final class Parser {
        final String s; int i;
        Parser(String s) { this.s = s; }
        void ws() { while (i < s.length() && " \t\r\n".indexOf(s.charAt(i)) >= 0) i++; }
        IllegalArgumentException error() { return new IllegalArgumentException("Invalid JSON at offset " + i); }
        Object value(int depth) {
            if (depth > 64) throw new IllegalArgumentException("JSON nesting exceeds 64");
            ws(); if (i >= s.length()) throw error(); char c = s.charAt(i);
            if (c == '"') return string();
            if (c == '{') {
                i++; Map<String,Object> m = obj(); ws(); if (take('}')) return m;
                do {
                    ws(); if (i >= s.length() || s.charAt(i) != '"') throw error(); String k = string();
                    ws(); if (!take(':') || m.containsKey(k)) throw error(); m.put(k, value(depth + 1)); ws();
                    if (take('}')) return m;
                } while (take(',')); throw error();
            }
            if (c == '[') {
                i++; List<Object> a = arr(); ws(); if (take(']')) return a;
                do { a.add(value(depth + 1)); ws(); if (take(']')) return a; } while (take(',')); throw error();
            }
            if (s.startsWith("true", i)) { i += 4; return true; }
            if (s.startsWith("false", i)) { i += 5; return false; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            int start = i; take('-');
            if (take('0')) { if (i < s.length() && Character.isDigit(s.charAt(i))) throw error(); }
            else { if (i >= s.length() || s.charAt(i) < '1' || s.charAt(i) > '9') throw error(); digits(); }
            boolean decimal = false;
            if (take('.')) { decimal = true; int p = i; digits(); if (p == i) throw error(); }
            if (take('e') || take('E')) { decimal = true; if (!take('+')) take('-'); int p = i; digits(); if (p == i) throw error(); }
            try {
                String n = s.substring(start, i);
                if (!decimal) return Long.parseLong(n);
                double d = Double.parseDouble(n); if (Double.isInfinite(d) || Double.isNaN(d)) throw error(); return d;
            } catch (NumberFormatException e) { throw error(); }
        }
        void digits() { while (i < s.length() && s.charAt(i) >= '0' && s.charAt(i) <= '9') i++; }
        boolean take(char c) { if (i < s.length() && s.charAt(i) == c) { i++; return true; } return false; }
        String string() {
            i++; StringBuilder b = new StringBuilder();
            while (i < s.length()) {
                char c = s.charAt(i++); if (c == '"') return b.toString(); if (c < 32) throw error();
                if (c != '\\') { b.append(c); continue; }
                if (i >= s.length()) throw error(); c = s.charAt(i++);
                switch (c) {
                    case '"': case '\\': case '/': b.append(c); break;
                    case 'b': b.append('\b'); break; case 'f': b.append('\f'); break;
                    case 'n': b.append('\n'); break; case 'r': b.append('\r'); break; case 't': b.append('\t'); break;
                    case 'u':
                        if (i + 4 > s.length()) throw error();
                        try { b.append((char)Integer.parseInt(s.substring(i, i + 4), 16)); } catch (NumberFormatException e) { throw error(); }
                        i += 4; break;
                    default: throw error();
                }
            }
            throw error();
        }
    }
}
