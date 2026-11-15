package com.qoder2api.hub;

import java.io.*;
import java.net.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.LongSupplier;
import java.util.regex.*;
import javax.net.ssl.HttpsURLConnection;
import static com.qoder2api.hub.Json.*;

/** Public release metadata only. Never downloads, installs or forwards application credentials. */
final class AppUpdates {
    static final String CURRENT_VERSION = "3.1.0";
    static final String RELEASES_URL = "https://api.github.com/repos/renatozapelini/Ai/releases";
    static final int TIMEOUT_MS = 8000, BODY_LIMIT = 1024 * 1024;
    static final long APK_LIMIT = 100L * 1024 * 1024, SUCCESS_TTL = 3600000, FAILURE_TTL = 300000;
    private static final String REPOSITORY_URL = "https://github.com/renatozapelini/Ai/releases/";
    private static final Pattern TAG = Pattern.compile("^v(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$");
    private static final Version INSTALLED = Version.tag("v" + CURRENT_VERSION);
    private static final ScheduledThreadPoolExecutor DEADLINES = new ScheduledThreadPoolExecutor(1, task -> {
        Thread thread = new Thread(task, "app-updates-deadline"); thread.setDaemon(true); return thread;
    });
    static { DEADLINES.setRemoveOnCancelPolicy(true); }

    // Package-private fixture seams; the production endpoint is fixed, never a request/setting URL.
    interface ConnectionSource { HttpsURLConnection open() throws IOException; }
    private final ConnectionSource connections;
    private final LongSupplier clock;
    private Map<String,Object> cached;
    private long cachedAt;

    AppUpdates() {
        this(() -> (HttpsURLConnection)new URL(RELEASES_URL).openConnection(), System::currentTimeMillis);
    }
    AppUpdates(ConnectionSource connections, LongSupplier clock) {
        this.connections = Objects.requireNonNull(connections); this.clock = Objects.requireNonNull(clock);
    }

    synchronized Map<String,Object> check() {
        long now = clock.getAsLong();
        long ttl = cached != null && yes(cached.get("ok")) ? SUCCESS_TTL : FAILURE_TTL;
        if (cached != null && now >= cachedAt && now - cachedAt < ttl) return new LinkedHashMap<>(cached);
        Map<String,Object> result;
        try {
            byte[] bytes = fetch(); now = clock.getAsLong(); result = parsePayload(bytes, now);
        } catch (UpdateFailure e) {
            now = clock.getAsLong(); result = failure(e.code, e.getMessage(), now);
        } catch (SocketTimeoutException e) {
            now = clock.getAsLong(); result = failure("timeout", "Consulta de releases excedeu 8 segundos; atualização não confirmada.", now);
        } catch (Exception e) {
            now = clock.getAsLong(); result = failure("unavailable", "Não foi possível consultar releases públicos; atualização não confirmada.", now);
        }
        cached = result; cachedAt = now;
        return new LinkedHashMap<>(cached);
    }

    private byte[] fetch() throws IOException {
        HttpsURLConnection connection = connections.open();
        if (connection == null) throw invalid("unavailable", "Conexão de releases indisponível.");
        AtomicBoolean expired = new AtomicBoolean();
        ScheduledFuture<?> deadline = null;
        try {
            if (!RELEASES_URL.equals(connection.getURL().toExternalForm())) throw invalid("invalid_endpoint", "Endpoint de releases recusado.");
            connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
            connection.setConnectTimeout(TIMEOUT_MS); connection.setReadTimeout(TIMEOUT_MS);
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            connection.setRequestProperty("User-Agent", "Code-Assistants/" + CURRENT_VERSION);
            connection.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");
            connection.setRequestProperty("Accept-Encoding", "identity");
            deadline = DEADLINES.schedule(() -> { expired.set(true); connection.disconnect(); }, TIMEOUT_MS, TimeUnit.MILLISECONDS);
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) throw invalid("redirect_refused", "Redirecionamento de releases recusado; atualização não confirmada.");
            if (status != 200) throw invalid("http_" + status, status == 404
                ? "GitHub retornou HTTP 404 para releases públicos; nenhum APK foi confirmado."
                : "Consulta de releases falhou (HTTP " + status + "); atualização não confirmada.");
            long length = connection.getContentLengthLong();
            if (length > BODY_LIMIT) throw invalid("body_too_large", "Resposta de releases excede 1 MB.");
            String encoding = connection.getHeaderField("Content-Encoding");
            if (encoding != null && !encoding.equalsIgnoreCase("identity")) throw invalid("invalid_response", "Codificação de releases não suportada.");
            String type = str(connection.getContentType()).split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
            if (!type.equals("application/json") && !type.matches("application/[a-z0-9.+-]+\\+json")) throw invalid("invalid_response", "GitHub não retornou JSON de releases.");
            ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[8192];
            try (InputStream in = connection.getInputStream()) {
                int n;
                while ((n = in.read(buffer)) != -1) {
                    if (expired.get()) throw invalid("timeout", "Consulta de releases excedeu 8 segundos; atualização não confirmada.");
                    if (n > BODY_LIMIT - out.size()) throw invalid("body_too_large", "Resposta de releases excede 1 MB.");
                    out.write(buffer, 0, n);
                }
            }
            if (expired.get()) throw invalid("timeout", "Consulta de releases excedeu 8 segundos; atualização não confirmada.");
            if (length >= 0 && length != out.size()) throw invalid("truncated_response", "Resposta de releases incompleta; atualização não confirmada.");
            return out.toByteArray();
        } catch (IOException e) {
            if (expired.get()) throw invalid("timeout", "Consulta de releases excedeu 8 segundos; atualização não confirmada.");
            throw e;
        } finally {
            if (deadline != null) deadline.cancel(false);
            connection.disconnect();
        }
    }

    static Map<String,Object> parsePayload(byte[] bytes, long checkedAt) throws UpdateFailure {
        if (bytes.length > BODY_LIMIT) throw invalid("body_too_large", "Resposta de releases excede 1 MB.");
        Object payload;
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            payload = parse(text);
        } catch (IllegalArgumentException | CharacterCodingException e) {
            throw invalid("invalid_payload", "JSON de releases inválido; atualização não confirmada.");
        }
        if (!(payload instanceof List)) throw invalid("invalid_payload", "GitHub não retornou uma lista de releases; atualização não confirmada.");
        List<Object> releases = list(payload);
        if (releases.isEmpty()) return failure("empty_releases", "A lista pública de releases está vazia; nenhum APK foi confirmado.", checkedAt);
        Version best = null; String bestUrl = null;
        for (Object raw : releases) {
            if (!(raw instanceof Map)) continue;
            Map<String,Object> release = map(raw);
            if (!Boolean.FALSE.equals(release.get("draft")) || !Boolean.FALSE.equals(release.get("prerelease"))) continue;
            Version version = Version.tag(str(release.get("tag_name")));
            if (version == null || version.compareTo(INSTALLED) < 0 || !(release.get("assets") instanceof List)) continue;
            String name = "Code-Assistants-v" + version.value + ".apk";
            String expected = REPOSITORY_URL + "download/v" + version.value + "/" + name;
            int matches = 0; String url = null;
            for (Object item : list(release.get("assets"))) {
                if (!(item instanceof Map)) continue;
                Map<String,Object> asset = map(item);
                if (!name.equals(asset.get("name"))) continue;
                matches++;
                Object size = asset.get("size");
                if (!(size instanceof Number)) continue;
                double amount = ((Number)size).doubleValue();
                if (!Double.isFinite(amount) || amount <= 0 || amount > APK_LIMIT || amount != Math.rint(amount)) continue;
                if (canonicalDownload(asset.get("browser_download_url"), expected)) url = expected;
            }
            if (matches != 1 || url == null) continue;
            if (best == null || version.compareTo(best) > 0) { best = version; bestUrl = url; }
        }
        if (best == null) return failure("no_compatible_apk", "Nenhum release estável >= " + CURRENT_VERSION + " contém um APK Code-Assistants válido na lista consultada; atualização não confirmada.", checkedAt);
        boolean available = best.compareTo(INSTALLED) > 0;
        Map<String,Object> result = obj("ok", true, "currentVersion", CURRENT_VERSION, "latestVersion", best.value,
            "available", available, "releaseUrl", REPOSITORY_URL + "tag/v" + best.value, "checkedAt", checkedAt,
            "message", available ? "APK mais novo validado na lista consultada. Download e instalação dependem de ação humana."
                : "Somente o APK da versão atual foi validado; nenhum APK mais novo confirmado na lista consultada.");
        if (available) result.put("downloadUrl", bestUrl);
        return result;
    }

    private static boolean canonicalDownload(Object raw, String expected) {
        if (!(raw instanceof String) || !expected.equals(raw)) return false;
        try {
            URI uri = new URI((String)raw);
            return "https".equals(uri.getScheme()) && "github.com".equals(uri.getHost()) && uri.getPort() == -1
                && uri.getRawUserInfo() == null && uri.getRawQuery() == null && uri.getRawFragment() == null
                && uri.getRawPath().equals(uri.getPath()) && uri.normalize().equals(uri);
        } catch (URISyntaxException e) { return false; }
    }
    private static Map<String,Object> failure(String code, String message, long checkedAt) {
        return obj("ok", false, "currentVersion", CURRENT_VERSION, "available", false, "checkedAt", checkedAt, "message", message, "error", code);
    }
    private static UpdateFailure invalid(String code, String message) { return new UpdateFailure(code, message); }
    static final class UpdateFailure extends IOException {
        final String code;
        UpdateFailure(String code, String message) { super(message); this.code = code; }
    }
    private static final class Version implements Comparable<Version> {
        final String value, major, minor, patch;
        Version(String major, String minor, String patch) { this.major = major; this.minor = minor; this.patch = patch; this.value = major + "." + minor + "." + patch; }
        static Version tag(String tag) { Matcher match = TAG.matcher(tag); return match.matches() ? new Version(match.group(1), match.group(2), match.group(3)) : null; }
        private static int decimal(String a, String b) { return a.length() == b.length() ? a.compareTo(b) : Integer.compare(a.length(), b.length()); }
        public int compareTo(Version other) { int n = decimal(major, other.major); if (n != 0) return n; n = decimal(minor, other.minor); return n == 0 ? decimal(patch, other.patch) : n; }
    }
}
