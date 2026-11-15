package com.qoder2api.hub;

import android.app.Application;
import android.os.Handler;
import android.os.Looper;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** One private, loopback gateway shared by living activities; jobs never start the gateway. */
public final class HubApplication extends Application {
    private final ExecutorService lifecycle = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private Gateway gateway;
    // Keep the same durable state lock even while an old worker finishes after stop().
    private HubState sharedState;
    private int owners;

    public interface GatewayCallback {
        void ready(Gateway gateway);
        void failed(String message);
    }
    @Override public void onCreate() {
        super.onCreate();
        ReminderScheduler.restore(this);
    }
    public void acquireGateway(final GatewayCallback callback) {
        lifecycle.execute(() -> {
            try {
                if (gateway == null) {
                    if (sharedState == null) {
                        List<Object> presets;
                        try (InputStream in = getAssets().open("provider-presets.json")) {
                            presets = Json.list(Json.parse(readAsset(in)));
                        }
                        sharedState = new HubState(new File(getFilesDir(), "code-assistants"), presets);
                    }
                    Gateway candidate = new Gateway(sharedState, this::openTrustedAsset);
                    try {
                        int port = candidate.start();
                        if (port != 8790) throw new IOException("O gateway local deve escutar na porta 8790.");
                        gateway = candidate;
                    } catch (Exception failure) {
                        candidate.stop();
                        throw failure;
                    }
                }
                owners++;
                final Gateway running = gateway;
                main.post(() -> callback.ready(running));
            } catch (Exception failure) {
                // Never display provider keys, account state or raw exception contents.
                main.post(() -> callback.failed("Não foi possível iniciar o servidor local. Verifique os recursos do APK e se a porta 8790 está livre."));
            }
        });
    }
    public void releaseGateway() {
        lifecycle.execute(() -> {
            if (owners > 0) owners--;
            if (owners == 0 && gateway != null) {
                Gateway stopping = gateway;
                gateway = null;
                try { stopping.stop(); } catch (RuntimeException ignored) {}
            }
        });
    }
    private InputStream openTrustedAsset(String path) throws IOException {
        if (path == null || path.isEmpty() || path.startsWith("/") || path.contains("\\")
            || path.matches(".*[\\x00-\\x1f\\x7f].*")) throw new IOException("Invalid asset path");
        for (String segment : path.split("/")) {
            if ("..".equals(segment) || ".".equals(segment)) throw new IOException("Invalid asset path");
        }
        InputStream input = getAssets().open(path);
        if (!path.endsWith(".html")) return input;
        String html;
        try (InputStream in = input) { html = readAsset(in); }
        // Android's JS interface is frame-wide. No frames/objects/workers or remote scripts
        // are allowed, including data/blob frames which do not hit shouldInterceptRequest.
        java.util.regex.Matcher head = java.util.regex.Pattern.compile("(?i)<head(?:\\s[^>]*)?>").matcher(html);
        if (!head.find()) throw new IOException("Trusted HTML asset requires a head element");
        String policy = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; "
            + "script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
            + "font-src 'self' data:; connect-src 'self'; frame-src 'none'; child-src 'none'; "
            + "worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\">";
        String secured = html.substring(0, head.end()) + policy + html.substring(head.end());
        return new ByteArrayInputStream(secured.getBytes(StandardCharsets.UTF_8));
    }
    private static String readAsset(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = in.read(buffer)) != -1) {
            if (out.size() + count > 4 * 1024 * 1024) throw new IOException("Trusted asset exceeds limit");
            out.write(buffer, 0, count);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }
}
