package com.qoder2api.hub;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.cert.Certificate;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import javax.net.ssl.HttpsURLConnection;
import static com.qoder2api.hub.Json.*;

/** Offline JVM fixtures, including the real loopback route. No real release or APK is requested. */
public final class AppUpdatesTest {
    private static int checks;
    private static final String SECRET = "untrusted-body-or-user-key-must-not-leak";
    private static final String BASE = "https://github.com/renatozapelini/Al-Code-Assistant-Free/releases/";
    // As fixtures acompanham a versão instalada para o teste não envelhecer a cada release.
    private static final String CURRENT = AppUpdates.CURRENT_VERSION;
    private static final String NEWER = bump(CURRENT);
    private static String bump(String version) {
        int dot = version.lastIndexOf('.');
        return version.substring(0, dot + 1) + (Integer.parseInt(version.substring(dot + 1)) + 1);
    }
    private static void check(boolean value, String label) { checks++; if (!value) throw new AssertionError(label); }
    private static void eq(Object actual, Object expected, String label) { check(Objects.equals(actual, expected), label + ": expected " + expected + ", got " + actual); }
    private static byte[] bytes(String text) { return text.getBytes(StandardCharsets.UTF_8); }
    private static String download(String version) { return BASE + "download/v" + version + "/Code-Assistants-v" + version + ".apk"; }
    private static Map<String,Object> release(String version) {
        return obj("tag_name", "v" + version, "draft", false, "prerelease", false, "html_url", "https://evil.example/" + SECRET,
            "assets", arr(obj("name", "Code-Assistants-v" + version + ".apk", "size", 12345, "browser_download_url", download(version))));
    }
    private static Map<String,Object> asset(Map<String,Object> release) { return map(list(release.get("assets")).get(0)); }
    private static Map<String,Object> contract(Map<String,Object> result) {
        check(result.get("ok") instanceof Boolean, "ok boolean");
        eq(result.get("currentVersion"), CURRENT, "configured current version");
        check(result.get("available") instanceof Boolean, "available boolean");
        check(result.get("checkedAt") instanceof Number, "checkedAt timestamp");
        check(!str(result.get("message")).isEmpty(), "message explains outcome");
        check(!stringify(result).contains(SECRET), "no raw upstream fields, errors or keys");
        if (!yes(result.get("ok"))) {
            eq(result.get("available"), false, "failure never offers download");
            check(!str(result.get("error")).isEmpty(), "failure code");
            check(!result.containsKey("latestVersion") && !result.containsKey("downloadUrl") && !result.containsKey("releaseUrl"), "no stale or unverified URLs");
        } else {
            check(!result.containsKey("error"), "success has no error");
            check(!str(result.get("latestVersion")).isEmpty(), "validated version");
        }
        return result;
    }
    private static Map<String,Object> inspect(Fake response) throws Exception {
        Source source = new Source(response); Map<String,Object> result = contract(new AppUpdates(source, () -> 1000L).check());
        eq(source.hits.get(), 1, "single metadata request");
        check(response.disconnected.get(), "connection closed");
        return result;
    }
    private static Map<String,Object> inspect(Object fixture) throws Exception { return inspect(new Fake(stringify(fixture))); }
    private static void rejected(Fake response, String code) throws Exception {
        Map<String,Object> result = inspect(response); eq(result.get("ok"), false, "fixture rejected"); eq(result.get("error"), code, "sanitized failure code");
    }
    private static void noApk(Object fixture) throws Exception { eq(inspect(fixture).get("error"), "no_compatible_apk", "no matching APK"); }

    private static void parsingAndSemver() throws Exception {
        Map<String,Object> draft = release("3.99.0"), pre = release("3.98.0"); draft.put("draft", true); pre.put("prerelease", true);
        Map<String,Object> result = inspect(arr(release("3.9.99"), draft, release("3.0.99"), pre, release("3.10.1"), release("3.10.0")));
        eq(result.get("latestVersion"), "3.10.1", "numeric minor selection, not release order");
        eq(result.get("available"), true, "newer available");
        eq(result.get("downloadUrl"), download("3.10.1"), "only browser download URL");
        eq(result.get("releaseUrl"), BASE + "tag/v3.10.1", "canonical generated release URL");
        eq(inspect(arr(release("3.2.9"), release("3.3.10"))).get("latestVersion"), "3.3.10", "numeric patch selection");
        String huge = "3.123456789012345678901234567890.0";
        eq(inspect(arr(release("3.999.999"), release(huge))).get("latestVersion"), "3.999.999", "oversized semver rejected consistently with UI");
        eq(inspect(arr(release("3.99.99"), release("4.0.0"))).get("latestVersion"), "4.0.0", "future major version available");
        result = inspect(arr(release(CURRENT)));
        eq(result.get("ok"), true, "current APK validated"); eq(result.get("available"), false, "equal version not an update");
        check(!result.containsKey("downloadUrl"), "no current-version download prompt");
        check(str(result.get("message")).contains("Somente o APK"), "current outcome scoped to validated list, not falsely up to date");
        noApk(arr(release("3.0.99"))); noApk(arr(release("2.99.99"))); noApk(arr(draft, pre));
        for (String tag : new String[]{"3.3.1", "v3.01.1", "v3.2.01", "v3.3.1-beta", "v3.3.1+build", "v3.1", "v3.-1.0", "v3.3.1/../x", "v3.3.1%2f..", "v3.3.1?x", "v3.3.1\n"}) {
            Map<String,Object> bad = release(NEWER); bad.put("tag_name", tag); noApk(arr(bad));
        }
        for (String flag : new String[]{"draft", "prerelease"}) {
            Map<String,Object> bad = release(NEWER); bad.remove(flag); noApk(arr(bad));
            bad.put(flag, "false"); noApk(arr(bad));
        }
        rejected(new Fake("[]"), "empty_releases");
    }

    private static void assetsAndUrls() throws Exception {
        for (Object assets : new Object[]{null, arr(), obj(), "assets", arr(null, 1, obj("name", "other.apk"))}) {
            Map<String,Object> bad = release(NEWER); bad.put("assets", assets); noApk(arr(bad));
        }
        Map<String,Object> missing = release(NEWER); missing.remove("assets"); noApk(arr(missing));
        for (String name : new String[]{"app.apk", "Ai-v3.3.1.apk", "Code-Assistants.apk", "Code-Assistants-v3.2.0.apk", "code-assistants-v3.3.1.apk", "../Code-Assistants-v3.3.1.apk", "Code-Assistants-v3.3.1.apk.zip"}) {
            Map<String,Object> bad = release(NEWER); asset(bad).put("name", name); noApk(arr(bad));
        }
        String canonical = download(NEWER);
        for (Object url : new Object[]{null, 42, canonical.replace("https:", "http:"), canonical.replace("github.com", "github.com.evil.example"),
            canonical.replace("github.com", "api.github.com"), canonical.replace("github.com", "GITHUB.COM"),
            canonical.replace("github.com", "user@github.com"), canonical.replace("github.com", "github.com:443"),
            canonical.replace("github.com", "github.com:8443"), canonical + "?token=" + SECRET, canonical + "#apk",
            canonical.replace("/Al-Code-Assistant-Free/", "/Other/"), canonical.replace("/renatozapelini/", "/another/"),
            canonical.replace("/v" + NEWER + "/", "/v" + NEWER + "/../" + NEWER + "/"), canonical.replace("/v" + NEWER + "/", "/v" + NEWER + "/%2e%2e/" + NEWER + "/"),
            canonical.replace("/v" + NEWER + "/", "/v" + NEWER + "%2f/"), canonical.replace("/v" + NEWER + "/", "//" + NEWER + "/"),
            canonical.replace("/v" + NEWER + "/", "/v" + bump(NEWER) + "/"), canonical.replace("/Al-Code-Assistant-Free/", "/%41l-Code-Assistant-Free/"), canonical.replace("github.com/", "github.com\\"), canonical + "\n"}) {
            Map<String,Object> bad = release(NEWER); asset(bad).put("browser_download_url", url); noApk(arr(bad));
        }
        for (Object size : new Object[]{null, "12345", 0, -1, 1.5, AppUpdates.APK_LIMIT + 1}) {
            Map<String,Object> bad = release(NEWER); asset(bad).put("size", size); noApk(arr(bad));
        }
        Map<String,Object> max = release(NEWER); asset(max).put("size", AppUpdates.APK_LIMIT);
        eq(inspect(arr(max)).get("available"), true, "100 MB inclusive");
        Map<String,Object> duplicate = release(NEWER); list(duplicate.get("assets")).add(copy(asset(duplicate))); noApk(arr(duplicate));
        Map<String,Object> mixed = release(NEWER); list(mixed.get("assets")).add(null); list(mixed.get("assets")).add(obj("name", "Other-App.apk"));
        eq(inspect(arr(null, obj(), mixed)).get("latestVersion"), NEWER, "unrelated/null entries ignored");
        Map<String,Object> noNewApk = release("3.4.0"); noNewApk.put("assets", null);
        eq(inspect(arr(noNewApk, release(NEWER))).get("latestVersion"), NEWER, "largest validated APK, not unverified tag");
    }

    private static void payloadAndHttp() throws Exception {
        for (String text : new String[]{"", " ", "null", "{}", "{\"message\":\"" + SECRET + "\"}", "{\"error\":\"" + SECRET + "\"}", "[", "[] trailing", "[1e999]", "[{\"draft\":false,\"draft\":false}]", "[NaN]", "[Infinity]"}) {
            rejected(new Fake(text), "invalid_payload");
        }
        String deep = "0"; for (int i = 0; i < 66; i++) deep = "[" + deep + "]";
        rejected(new Fake(deep), "invalid_payload");
        rejected(new Fake(new byte[]{(byte)0xc3, 0x28}), "invalid_payload");
        String nonfinite = stringify(arr(release(NEWER))).replace("12345", "1e999"); rejected(new Fake(nonfinite), "invalid_payload");
        byte[] large = new byte[AppUpdates.BODY_LIMIT + 1]; Arrays.fill(large, (byte)' ');
        Fake chunked = new Fake(large); chunked.length = -1; rejected(chunked, "body_too_large");
        Fake declared = new Fake("[]"); declared.length = AppUpdates.BODY_LIMIT + 1L; rejected(declared, "body_too_large"); eq(declared.bodyReads, 0, "oversized content length rejected before read");
        byte[] exact = new byte[AppUpdates.BODY_LIMIT]; Arrays.fill(exact, (byte)' ');
        byte[] valid = bytes(stringify(arr(release(NEWER)))); System.arraycopy(valid, 0, exact, 0, valid.length);
        eq(inspect(new Fake(exact)).get("available"), true, "exact 1 MB accepted");
        Fake truncated = new Fake("[]"); truncated.length = 100; rejected(truncated, "truncated_response");
        Fake html = new Fake("<html>" + SECRET); html.type = "text/html"; rejected(html, "invalid_response");
        Fake gzip = new Fake("[]"); gzip.encoding = "gzip"; rejected(gzip, "invalid_response");
        Fake vendor = new Fake(stringify(arr(release(NEWER)))); vendor.type = "application/vnd.github+json; charset=utf-8";
        eq(inspect(vendor).get("available"), true, "GitHub JSON media type");
        for (int status : new int[]{301, 302, 303, 307, 308, 401, 403, 404, 429, 500, 204}) {
            Fake error = new Fake("{\"message\":\"" + SECRET + "\"}"); error.status = status;
            rejected(error, status < 400 && status >= 300 ? "redirect_refused" : "http_" + status);
            eq(error.bodyReads, 0, "error/redirect body not read"); check(!error.getInstanceFollowRedirects(), "redirects disabled");
        }
        Fake timeout = new Fake("[]"); timeout.problem = new SocketTimeoutException(SECRET); rejected(timeout, "timeout");
        Fake broken = new Fake("[]"); broken.problem = new IOException(SECRET); rejected(broken, "unavailable");
        Fake wrongEndpoint = new Fake("[]", new URL("https://evil.example/releases")); rejected(wrongEndpoint, "invalid_endpoint");
        eq(wrongEndpoint.requests, 0, "fixed endpoint checked before request");
    }

    private static void cachingAndHeaders() throws Exception {
        AtomicLong time = new AtomicLong(1000); Source source = new Source(new Fake(stringify(arr(release(NEWER)))));
        AppUpdates client = new AppUpdates(source, time::get); Map<String,Object> first = contract(client.check());
        Fake sent = source.next;
        eq(sent.getRequestMethod(), "GET", "metadata GET only");
        eq(sent.getConnectTimeout(), 8000, "8 second connect timeout"); eq(sent.getReadTimeout(), 8000, "8 second read timeout");
        check(!sent.getUseCaches() && !sent.getDoOutput(), "no implicit HTTP cache or upload");
        Map<String,List<String>> headers = sent.getRequestProperties();
        eq(headers.keySet(), new HashSet<>(Arrays.asList("Accept", "User-Agent", "X-GitHub-Api-Version", "Accept-Encoding")), "only public metadata headers; no tokens or user keys");
        eq(sent.getRequestProperty("Accept"), "application/vnd.github+json", "GitHub accept");
        eq(sent.getRequestProperty("User-Agent"), "Code-Assistants/" + CURRENT, "identifying user agent");
        eq(sent.getRequestProperty("X-GitHub-Api-Version"), "2022-11-28", "pinned API version");
        first.put("downloadUrl", "https://evil.example/" + SECRET);
        time.set(1000 + AppUpdates.SUCCESS_TTL - 1); contract(client.check()); eq(source.hits.get(), 1, "success cache lasts one hour");
        source.next = new Fake("[]"); source.next.status = 404; time.incrementAndGet();
        Map<String,Object> failed = contract(client.check()); eq(source.hits.get(), 2, "recheck at one hour"); eq(failed.get("error"), "http_404", "expired success replaced by failure, no stale availability");
        eq(failed.get("checkedAt"), time.get(), "timestamp of latest completed check");
        source.next = new Fake(stringify(arr(release(NEWER))));
        time.addAndGet(AppUpdates.FAILURE_TTL - 1); eq(client.check(), failed, "failure cache unchanged before five minutes"); eq(source.hits.get(), 2, "failure retry throttled");
        time.incrementAndGet(); eq(contract(client.check()).get("latestVersion"), NEWER, "retry at five minutes"); eq(source.hits.get(), 3, "failure retried once");
        time.set(0); client.check(); eq(source.hits.get(), 4, "backwards clock does not extend cache");
        source.next = new Fake(stringify(arr(release(NEWER))));
        eq(contract(client.check(true)).get("latestVersion"), NEWER, "manual force bypasses the failure cache");
        eq(source.hits.get(), 5, "force performs a fresh metadata request");
        eq(contract(client.check()).get("latestVersion"), NEWER, "forced result becomes the new cache");
        eq(source.hits.get(), 5, "no extra request after a forced refresh");
        Source concurrent = new Source(new Fake(stringify(arr(release(NEWER))))); AppUpdates shared = new AppUpdates(concurrent, () -> 1L);
        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            List<Future<Map<String,Object>>> futures = new ArrayList<>();
            for (int i = 0; i < 16; i++) futures.add(pool.submit(() -> shared.check()));
            for (Future<Map<String,Object>> future : futures) contract(future.get(3, TimeUnit.SECONDS));
            eq(concurrent.hits.get(), 1, "concurrent checks share cache");
        } finally { pool.shutdownNow(); }
    }

    private static void totalDeadline() throws Exception {
        Fake stalled = new Fake("[]"); stalled.stall = true; stalled.length = -1;
        long started = System.nanoTime(); rejected(stalled, "timeout");
        long elapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        check(elapsed >= 7500 && elapsed < 11000, "8 second total deadline terminates a stalled body");
    }

    private static final class Reply {
        final int status; final Map<String,Object> json;
        Reply(int status, Map<String,Object> json) { this.status = status; this.json = json; }
    }
    private static Reply request(Gateway gateway, String method, String session, Map<String,Object> overrides) throws Exception {
        return request(gateway, method, session, overrides, "/api/app/updates");
    }
    private static Reply request(Gateway gateway, String method, String session, Map<String,Object> overrides, String path) throws Exception {
        Map<String,Object> headers = obj("Host", "127.0.0.1:8790", "Origin", "http://127.0.0.1:8790", "Sec-Fetch-Site", "same-origin");
        if (session != null) headers.put("X-App-Session", session);
        headers.putAll(overrides);
        StringBuilder wire = new StringBuilder(method + " " + path + " HTTP/1.1\r\n");
        for (Map.Entry<String,Object> h : headers.entrySet()) if (h.getValue() != null) wire.append(h.getKey()).append(": ").append(h.getValue()).append("\r\n");
        wire.append("Content-Length: 0\r\n\r\n");
        try (Socket socket = new Socket("127.0.0.1", 8790)) {
            socket.setSoTimeout(12000); socket.getOutputStream().write(bytes(wire.toString())); socket.getOutputStream().flush();
            String text = new String(Gateway.readBounded(socket.getInputStream(), 1024 * 1024), StandardCharsets.UTF_8);
            int end = text.indexOf("\r\n\r\n"); check(end >= 0, "complete protected route reply");
            check(text.contains("Cache-Control: no-store"), "private endpoint never cached by browser");
            return new Reply(Integer.parseInt(text.split(" ", 3)[1]), map(parse(text.substring(end + 4))));
        }
    }
    private static void protectedRoute(Path parent) throws Exception {
        Path directory = Files.createTempDirectory(parent, "app-updates-state-");
        AtomicLong time = new AtomicLong(1000); Source source = new Source(new Fake(stringify(arr(release(NEWER)))));
        HubState state = new HubState(directory.toFile(), arr());
        Map<String,Object> stored = state.snapshot(); list(stored.get("providers")).add(obj("id", "fixture", "apiKey", SECRET)); state.commit(stored);
        String original = HubState.read(directory.resolve("hub-state.json").toFile(), 1000000);
        Gateway gateway = new Gateway(state, path -> { throw new FileNotFoundException(); }, new AppUpdates(source, time::get));
        try {
            gateway.start();
            eq(request(gateway, "GET", null, obj()).status, 401, "update endpoint requires session");
            eq(request(gateway, "GET", "invalid", obj()).status, 401, "wrong session rejected");
            eq(request(gateway, "GET", gateway.sessionToken(), obj("Origin", "https://evil.example")).status, 403, "foreign origin rejected");
            eq(request(gateway, "GET", gateway.sessionToken(), obj("Sec-Fetch-Site", "cross-site")).status, 403, "cross-site rejected");
            eq(request(gateway, "GET", gateway.sessionToken(), obj("Host", "evil.example")).status, 403, "foreign host rejected");
            eq(request(gateway, "GET", gateway.sessionToken(), obj("Referer", "https://evil.example/")).status, 403, "foreign referer rejected");
            eq(source.hits.get(), 0, "unauthorized callers never contact GitHub");
            Reply valid = request(gateway, "GET", gateway.sessionToken(), obj()); eq(valid.status, 200, "authenticated update route");
            eq(contract(valid.json).get("downloadUrl"), download(NEWER), "route contract");
            eq(request(gateway, "POST", gateway.sessionToken(), obj()).status, 404, "GET only, no install action");
            eq(source.hits.get(), 1, "one metadata check only");
            check(!stringify(source.next.getRequestProperties()).contains(gateway.sessionToken()), "local session never forwarded");
            source.next = new Fake("{\"message\":\"" + SECRET + "\"}"); source.next.status = 404;
            time.addAndGet(AppUpdates.SUCCESS_TTL);
            Reply failed = request(gateway, "GET", gateway.sessionToken(), obj()); eq(failed.status, 503, "failed upstream has unavailable HTTP status");
            eq(contract(failed.json).get("error"), "http_404", "route preserves sanitized failure contract");
            Reply forced = request(gateway, "GET", gateway.sessionToken(), obj(), "/api/app/updates?force=1");
            eq(forced.status, 503, "manual force still reports honest failure status");
            eq(source.hits.get(), 3, "force=1 bypasses the failure cache");
            eq(request(gateway, "GET", gateway.sessionToken(), obj(), "/api/app/updates?force=0").status, 400, "only force=1 is a valid query");
            eq(request(gateway, "GET", gateway.sessionToken(), obj(), "/api/app/updates?x=1").status, 400, "unknown query rejected");
            eq(source.hits.get(), 3, "invalid queries never reach GitHub");
            eq(HubState.read(directory.resolve("hub-state.json").toFile(), 1000000), original, "checks do not mutate keys or app state");
        } finally {
            gateway.stop();
            try (java.util.stream.Stream<Path> paths = Files.walk(directory)) {
                for (Path path : (Iterable<Path>)paths.sorted(Comparator.reverseOrder())::iterator) Files.delete(path);
            }
        }
    }

    private static final class Source implements AppUpdates.ConnectionSource {
        final AtomicInteger hits = new AtomicInteger(); volatile Fake next;
        Source(Fake next) { this.next = next; }
        public HttpsURLConnection open() { hits.incrementAndGet(); return next; }
    }
    private static final class Fake extends HttpsURLConnection {
        final byte[] body; int status = 200, bodyReads, requests; long length;
        String type = "application/json", encoding; IOException problem; boolean stall;
        final AtomicBoolean disconnected = new AtomicBoolean(); final CountDownLatch closed = new CountDownLatch(1);
        Fake(String body) throws Exception { this(bytes(body)); }
        Fake(byte[] body) throws Exception { this(body, new URL(AppUpdates.RELEASES_URL)); }
        Fake(String body, URL url) { this(bytes(body), url); }
        Fake(byte[] body, URL url) { super(url); this.body = body; this.length = body.length; }
        public int getResponseCode() throws IOException { requests++; if (problem != null) throw problem; return status; }
        public long getContentLengthLong() { return length; }
        public String getContentType() { return type; }
        public String getHeaderField(String name) { return name.equalsIgnoreCase("Content-Encoding") ? encoding : name.equalsIgnoreCase("Location") ? "https://evil.example/" + SECRET : null; }
        public InputStream getInputStream() {
            bodyReads++;
            if (!stall) return new ByteArrayInputStream(body);
            return new InputStream() {
                public int read() throws IOException {
                    try { if (!closed.await(12, TimeUnit.SECONDS)) throw new IOException("Fixture deadline did not fire"); }
                    catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException(SECRET); }
                    throw new IOException(SECRET);
                }
            };
        }
        public InputStream getErrorStream() { throw new AssertionError("Must not read untrusted GitHub error body"); }
        public void connect() {}
        public void disconnect() { disconnected.set(true); closed.countDown(); }
        public boolean usingProxy() { return false; }
        public String getCipherSuite() { return "fixture"; }
        public Certificate[] getLocalCertificates() { return new Certificate[0]; }
        public Certificate[] getServerCertificates() { return new Certificate[0]; }
    }

    public static void main(String[] args) throws Exception {
        parsingAndSemver(); assetsAndUrls(); payloadAndHttp(); cachingAndHeaders(); totalDeadline();
        protectedRoute(args.length == 0 ? Paths.get(System.getProperty("java.io.tmpdir")) : Paths.get(args[0]));
        System.out.println("AppUpdatesTest: " + checks + " checks passed (offline HTTPS fixtures + authenticated loopback endpoint)");
    }
}
