package com.qoder2api.hub;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.Gravity;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Android-only shell. UI assets are served by the in-process Java gateway, never Termux. */
public final class MainActivity extends Activity {
    private static final String HOME = "http://127.0.0.1:8790/";
    private static final int IMPORT_FILE = 30010, EXPORT_ZIP = 30011, NOTIFICATION_PERMISSION = 30012;
    private static final int MAX_ZIP_BYTES = 4 * 1024 * 1024;
    private static final int MAX_BASE64 = ((MAX_ZIP_BYTES + 2) / 3) * 4;
    private final ExecutorService documents = Executors.newSingleThreadExecutor();
    private final Object exportLock = new Object();
    private HubApplication application;
    private WebView webView;
    private volatile Gateway runningGateway;
    private volatile boolean bridgeTrusted;
    private boolean gatewayOwned, starting, destroyed, permissionRequestPending;
    private ValueCallback<Uri[]> fileCallback;
    private byte[] pendingZip;
    private boolean exportBusy;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        application = (HubApplication) getApplication();
        startGateway();
    }
    private void startGateway() {
        if (starting || destroyed) return;
        starting = true;
        showMessage("Iniciando Code Assistants…", false);
        application.acquireGateway(new HubApplication.GatewayCallback() {
            @Override public void ready(Gateway gateway) {
                starting = false;
                if (destroyed) { application.releaseGateway(); return; }
                gatewayOwned = true;
                runningGateway = gateway;
                try { showWebView(); }
                catch (RuntimeException failure) { showFailure("Não foi possível abrir o Android WebView. Verifique se o componente está habilitado."); }
            }
            @Override public void failed(String message) {
                starting = false;
                if (!destroyed) showFailure(message);
            }
        });
    }
    private void showMessage(String message, boolean retry) {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        panel.setPadding(padding, padding, padding, padding);
        panel.setBackgroundColor(Color.rgb(18, 21, 27));
        TextView text = new TextView(this);
        text.setText(message);
        text.setTextColor(Color.WHITE);
        text.setTextSize(17);
        text.setGravity(Gravity.CENTER);
        panel.addView(text);
        if (retry) {
            Button button = new Button(this);
            button.setText("Tentar novamente");
            button.setOnClickListener(view -> startGateway());
            panel.addView(button);
        }
        setContentView(panel);
    }
    private void showFailure(String message) {
        if (destroyed) return;
        destroyWebView();
        releaseGateway();
        showMessage(message, true);
    }
    private void releaseGateway() {
        runningGateway = null;
        if (gatewayOwned) {
            gatewayOwned = false;
            application.releaseGateway();
        }
    }
    private static boolean trusted(Uri uri) {
        return uri != null && "http".equals(uri.getScheme()) && "127.0.0.1:8790".equals(uri.getEncodedAuthority());
    }
    private static boolean trusted(String url) {
        try { return url != null && trusted(Uri.parse(url)); } catch (RuntimeException ignored) { return false; }
    }
    private static boolean externalHttps(Uri uri) {
        return uri != null && "https".equals(uri.getScheme()) && uri.getHost() != null
            && uri.getUserInfo() == null && !uri.toString().matches(".*[\\x00-\\x20\\x7f].*");
    }
    private static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", null,
            new ByteArrayInputStream("Remote resources are not permitted in this WebView.".getBytes(StandardCharsets.UTF_8)));
    }
    private void showWebView() {
        WebView.setWebContentsDebuggingEnabled(false);
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUseWideViewPort(true); // Honor the bundled width=device-width viewport.
        settings.setLoadWithOverviewMode(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setSafeBrowsingEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidApp");
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (trusted(uri)) return false;
                // No remote page ever loads with AndroidApp. Redirects/scripts do not open apps.
                if (request.isForMainFrame() && request.hasGesture() && !request.isRedirect() && externalHttps(uri)) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
                    } catch (ActivityNotFoundException | SecurityException failure) { toast("Nenhum navegador disponível para abrir este link HTTPS."); }
                }
                return true; // Includes http, file, content, intent, javascript and custom schemes.
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // Legacy callback has no trustworthy gesture information: never launches external apps.
                return !trusted(url);
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // Also blocks remote subframes/resources; JS interfaces are otherwise exposed to frames.
                return trusted(request.getUrl()) ? null : blocked();
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (view != webView) return;
                bridgeTrusted = trusted(url);
                if (!bridgeTrusted) {
                    view.stopLoading();
                    showFailure("Navegação bloqueada: somente a interface local é permitida.");
                }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (view == webView && request.isForMainFrame()) showFailure("A interface local não respondeu. Toque em Tentar novamente.");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
                if (view == webView && request.isForMainFrame()) showFailure("Não foi possível carregar a interface incluída no APK. Tente novamente.");
            }
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                showFailure("O Android encerrou o WebView. Toque em Tentar novamente.");
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (!bridgeTrusted || destroyed) { callback.onReceiveValue(null); return true; }
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent select = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
                select.setType("*/*");
                select.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                ArrayList<String> mimeTypes = new ArrayList<>();
                for (String accept : params.getAcceptTypes()) {
                    for (String mime : accept.split(",")) {
                        mime = mime.trim();
                        if (mime.matches("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+*\\-]+") && mimeTypes.size() < 20) mimeTypes.add(mime);
                    }
                }
                if (!mimeTypes.isEmpty()) select.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toArray(new String[0]));
                try { startActivityForResult(select, IMPORT_FILE); }
                catch (ActivityNotFoundException | SecurityException failure) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                    toast("O seletor de documentos do Android não está disponível.");
                }
                return true;
            }
        });
        setContentView(webView);
        webView.loadUrl(HOME);
    }
    private void destroyWebView() {
        bridgeTrusted = false;
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        if (webView != null) {
            WebView old = webView;
            webView = null;
            old.removeJavascriptInterface("AndroidApp");
            old.stopLoading();
            old.setWebChromeClient(null);
            old.setWebViewClient(new WebViewClient());
            old.destroy();
        }
    }
    private void toast(String message) { Toast.makeText(getApplicationContext(), message, Toast.LENGTH_LONG).show(); }
    private void requestNotificationPermissionFromToggle() {
        // This method is invoked only by setReminderEnabled(true), never startup/job/boot.
        if (destroyed || !bridgeTrusted || permissionRequestPending || Build.VERSION.SDK_INT < 33) return;
        if (!Json.yes(Json.map(Json.parse(ReminderScheduler.getSettings(this))).get("enabled"))) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            permissionRequestPending = true;
            try { requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION); }
            catch (RuntimeException failure) { permissionRequestPending = false; toast("Permita notificações nas configurações do Android."); }
        }
    }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == NOTIFICATION_PERMISSION) {
            permissionRequestPending = false;
            ReminderScheduler.restore(this);
        }
    }
    @Override protected void onResume() {
        super.onResume();
        ReminderScheduler.restore(this); // Reopen after force-stop or changed notification settings.
        if (webView != null) webView.onResume();
    }
    @Override protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }
    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }
    @Override protected void onDestroy() {
        destroyed = true;
        destroyWebView();
        releaseGateway();
        synchronized (exportLock) { pendingZip = null; exportBusy = false; }
        documents.shutdown();
        super.onDestroy();
    }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == IMPORT_FILE) {
            ValueCallback<Uri[]> callback = fileCallback;
            fileCallback = null;
            if (callback == null) return;
            LinkedHashSet<Uri> selected = new LinkedHashSet<>();
            if (resultCode == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) addDocument(selected, clip.getItemAt(i).getUri());
                addDocument(selected, data.getData());
            }
            // No native file reads: the frontend enforces content/size limits.
            callback.onReceiveValue(selected.isEmpty() ? null : selected.toArray(new Uri[0]));
        } else if (requestCode == EXPORT_ZIP) {
            final byte[] bytes;
            synchronized (exportLock) { bytes = pendingZip; pendingZip = null; }
            if (bytes == null) { synchronized (exportLock) { exportBusy = false; } return; }
            Uri uri = data == null ? null : data.getData();
            if (resultCode != RESULT_OK || uri == null || !"content".equals(uri.getScheme())) {
                synchronized (exportLock) { exportBusy = false; }
                toast("Exportação cancelada; nenhum ZIP foi salvo pelo aplicativo.");
                return;
            }
            documents.execute(() -> {
                try (OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
                    if (out == null) throw new IOException("Document provider returned no output stream");
                    out.write(bytes);
                    out.flush();
                    // close must succeed before reporting completion.
                } catch (IOException | RuntimeException failure) {
                    runOnUiThread(() -> toast("Falha ao salvar o ZIP. O documento selecionado pode estar incompleto."));
                    synchronized (exportLock) { exportBusy = false; }
                    return;
                }
                synchronized (exportLock) { exportBusy = false; }
                runOnUiThread(() -> toast("ZIP salvo no documento escolhido."));
            });
        }
    }
    private static void addDocument(LinkedHashSet<Uri> selected, Uri uri) {
        if (uri != null && "content".equals(uri.getScheme())) selected.add(uri);
    }
    private static String zipFilename(String filename) {
        String name = filename == null ? "project" : filename.replace('\\', '/');
        name = name.substring(name.lastIndexOf('/') + 1).replaceAll("[^A-Za-z0-9._-]", "_");
        if (name.toLowerCase(Locale.ROOT).endsWith(".zip")) name = name.substring(0, name.length() - 4);
        name = name.replaceAll("^[._-]+|[._-]+$", "");
        if (name.isEmpty()) name = "project";
        if (name.length() > 76) name = name.substring(0, 76);
        return name + ".zip";
    }
    private void openZipDestination(String filename) {
        if (destroyed || !bridgeTrusted) {
            synchronized (exportLock) { pendingZip = null; exportBusy = false; }
            return;
        }
        Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
        save.setType("application/zip");
        save.putExtra(Intent.EXTRA_TITLE, filename);
        try { startActivityForResult(save, EXPORT_ZIP); }
        catch (ActivityNotFoundException | SecurityException failure) {
            synchronized (exportLock) { pendingZip = null; exportBusy = false; }
            toast("Não foi possível abrir o seletor para salvar. Nenhum ZIP foi salvo.");
        }
    }
    public final class AndroidBridge {
        @JavascriptInterface public String getSessionToken() {
            Gateway gateway = runningGateway;
            return bridgeTrusted && gateway != null ? gateway.sessionToken() : "";
        }
        /** Lê a área de transferência para o fluxo "conectar grátis" (só com o app em foco). */
        @JavascriptInterface public String readClipboardText() {
            if (!bridgeTrusted) return "";
            try {
                ClipboardManager manager = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (manager == null || !manager.hasPrimaryClip()) return "";
                ClipData clip = manager.getPrimaryClip();
                if (clip == null || clip.getItemCount() == 0) return "";
                CharSequence text = clip.getItemAt(0).coerceToText(MainActivity.this);
                String value = text == null ? "" : text.toString().trim();
                // Uma chave de API não passa disso; ignora textos gigantes por segurança.
                return value.length() > 4096 ? "" : value;
            } catch (RuntimeException failure) {
                return "";
            }
        }
        @JavascriptInterface public String getReminderSettings() {
            return bridgeTrusted ? ReminderScheduler.getSettings(MainActivity.this) : bridgeError("Interface local indisponível.");
        }
        @JavascriptInterface public String setReminderEnabled(boolean enabled) {
            if (!bridgeTrusted) return bridgeError("Interface local indisponível.");
            String status = ReminderScheduler.setEnabled(MainActivity.this, enabled);
            if (enabled) runOnUiThread(() -> requestNotificationPermissionFromToggle());
            return status;
        }
        @JavascriptInterface public String exportProjectZip(String base64, String filename) {
            if (!bridgeTrusted) return bridgeError("Interface local indisponível.");
            if (base64 == null || base64.length() > MAX_BASE64 || base64.length() < 8 || base64.length() % 4 != 0) {
                return bridgeError("ZIP inválido ou base64 acima do limite de 4 MB.");
            }
            synchronized (exportLock) {
                if (exportBusy) return bridgeError("Uma exportação já está aguardando a escolha do documento.");
                try {
                    // Decoder accepts whitespace; explicitly reject it and non-base64 characters.
                    for (int i = 0; i < base64.length(); i++) {
                        char c = base64.charAt(i);
                        boolean alphabet = c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '+' || c == '/';
                        if (!alphabet && !(c == '=' && i >= base64.length() - 2)) return bridgeError("Base64 inválido.");
                    }
                    byte[] bytes = Base64.decode(base64, Base64.NO_WRAP);
                    if (bytes.length < 4 || bytes.length > MAX_ZIP_BYTES || bytes[0] != 'P' || bytes[1] != 'K'
                        || !((bytes[2] == 3 && bytes[3] == 4) || (bytes[2] == 5 && bytes[3] == 6))) return bridgeError("O conteúdo não é um ZIP.");
                    pendingZip = bytes;
                    exportBusy = true;
                } catch (IllegalArgumentException failure) { return bridgeError("Base64 inválido."); }
            }
            final String safeFilename = zipFilename(filename);
            runOnUiThread(() -> openZipDestination(safeFilename));
            return Json.stringify(Json.obj("ok", true, "queued", true, "message", "Escolha e confirme o documento no Android. O ZIP ainda não foi salvo."));
        }
        private String bridgeError(String message) { return Json.stringify(Json.obj("ok", false, "error", message)); }
    }
}
