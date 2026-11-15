// Zero-dependency ZIP builder (STORE mode with standard CRC-32) for standalone Android Studio APK project export

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildZipBlob(files: { path: string; content: string }[]): Blob {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.path);
    const dataBytes = encoder.encode(file.content);
    const crc = crc32(dataBytes);

    const localHeader = new ArrayBuffer(30 + nameBytes.length);
    const lv = new DataView(localHeader);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    new Uint8Array(localHeader, 30).set(nameBytes);

    const localBytes = new Uint8Array(localHeader);
    localParts.push(localBytes, dataBytes);

    const centralHeader = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(centralHeader);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    new Uint8Array(centralHeader, 46).set(nameBytes);

    centralParts.push(new Uint8Array(centralHeader));
    offset += localBytes.length + dataBytes.length;
  }

  let centralSize = 0;
  for (const part of centralParts) centralSize += part.length;

  const endRecord = new ArrayBuffer(22);
  const ev = new DataView(endRecord);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const blobParts: BlobPart[] = [
    ...localParts.map((u) => new Uint8Array(u)),
    ...centralParts.map((u) => new Uint8Array(u)),
    new Uint8Array(endRecord),
  ];

  return new Blob(blobParts, { type: 'application/zip' });
}

export function downloadQoderAndroidStudioProject(appUrl: string) {
  const cleanUrl = appUrl.replace(/\/+$/, '');
  const files = [
    {
      path: 'settings.gradle.kts',
      content: `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "Qoder2APIHubAndroid"
include(":app")
`,
    },
    {
      path: 'build.gradle.kts',
      content: `plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
`,
    },
    {
      path: 'app/build.gradle.kts',
      content: `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.qoder2api.hub"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.qoder2api.hub"
        minSdk = 26
        targetSdk = 34
        versionCode = 200
        versionName = "2.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
}
`,
    },
    {
      path: 'app/src/main/AndroidManifest.xml',
      content: `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:usesCleartextTraffic="true"
        android:theme="@style/Theme.QoderHub">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:windowSoftInputMode="adjustResize"
            android:configChanges="orientation|screenSize|keyboardHidden">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`,
    },
    {
      path: 'app/src/main/res/values/strings.xml',
      content: `<resources>
    <string name="app_name">Qoder2API Hub</string>
    <string name="hub_url">${cleanUrl}</string>
</resources>
`,
    },
    {
      path: 'app/src/main/res/values/themes.xml',
      content: `<resources>
    <style name="Theme.QoderHub" parent="Theme.Material3.Dark.NoActionBar">
        <item name="android:statusBarColor">#090B0E</item>
        <item name="android:navigationBarColor">#090B0E</item>
        <item name="android:windowBackground">#090B0E</item>
    </style>
</resources>
`,
    },
    {
      path: 'app/src/main/res/drawable/ic_launcher_fg.xml',
      content: `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="512"
    android:viewportHeight="512">
    <path
        android:strokeColor="#10B981"
        android:strokeWidth="26"
        android:pathData="M256,102 A154,154 0 1,1 255.9,102 Z" />
    <path
        android:strokeColor="#34D399"
        android:strokeWidth="28"
        android:strokeLineCap="round"
        android:pathData="M312,312 L398,398" />
    <path
        android:fillColor="#F4F4F5"
        android:pathData="M256,214 A42,42 0 1,1 255.9,214 Z" />
</vector>
`,
    },
    {
      path: 'app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
      content: `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@android:color/black" />
    <foreground android:drawable="@drawable/ic_launcher_fg" />
</adaptive-icon>
`,
    },
    {
      path: 'app/src/main/java/com/qoder2api/hub/QoderCosyEngine.kt',
      content: `package com.qoder2api.hub

import android.util.Base64
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.spec.X509EncodedKeySpec
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Motor nativo COSY (RSA PKCS#1 v1.5 + AES-128-CBC + Base64 customizado Qoder + MD5)
 * embutido em Kotlin puro no APK — sem necessidade de Termux ou Python.
 */
object QoderCosyEngine {
    private const val STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    private const val CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!"
    private const val SERVER_PUB_B64 =
        "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc" +
        "4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l" +
        "6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17" +
        "XcW+ML9FoCI6AOvOzwIDAQAB"

    fun qoderEncode(plain: ByteArray): String {
        val std = Base64.encodeToString(plain, Base64.NO_WRAP)
        val n = std.length
        val a = n / 3
        val rearranged = std.substring(n - a) + std.substring(a, n - a) + std.substring(0, a)
        val sb = StringBuilder(rearranged.length)
        for (ch in rearranged) {
            if (ch == '=') {
                sb.append('$')
            } else {
                val idx = STD_ALPHABET.indexOf(ch)
                sb.append(if (idx >= 0) CUSTOM_ALPHABET[idx] else ch)
            }
        }
        return sb.toString()
    }

    fun deriveMachineId(uid: String): String {
        val digest = MessageDigest.getInstance("MD5")
            .digest("machine:$uid".toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        val h = digest.substring(0, 12) + "4" + digest.substring(13, 16) + "a" + digest.substring(17)
        return "\${h.substring(0, 8)}-\${h.substring(8, 12)}-\${h.substring(12, 16)}-\${h.substring(16, 20)}-\${h.substring(20, 32)}"
    }

    fun rsaEncryptTempKey(tempKey: ByteArray): String {
        val keyBytes = Base64.decode(SERVER_PUB_B64, Base64.DEFAULT)
        val pubKey = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(keyBytes))
        val cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding")
        cipher.init(Cipher.ENCRYPT_MODE, pubKey)
        return Base64.encodeToString(cipher.doFinal(tempKey), Base64.NO_WRAP)
    }

    fun aesCbcEncrypt(plain: ByteArray, key16: ByteArray): String {
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key16, "AES"), IvParameterSpec(key16))
        return Base64.encodeToString(cipher.doFinal(plain), Base64.NO_WRAP)
    }

    fun signBearer(payloadB64: String, cosyKey: String, dateSec: String, body: String, path: String): String {
        val raw = listOf(payloadB64, cosyKey, dateSec, body, path).joinToString("\n")
        val sig = MessageDigest.getInstance("MD5")
            .digest(raw.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return "Bearer COSY.$payloadB64.$sig"
    }

    fun randomTempKey(): ByteArray {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 16).toByteArray(Charsets.UTF_8)
    }
}
`,
    },
    {
      path: 'app/src/main/java/com/qoder2api/hub/LocalHealthServer.kt',
      content: `package com.qoder2api.hub

import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

/**
 * Servidor local leve em 127.0.0.1:8790 dentro do próprio APK (sem Termux)
 * para verificação de saúde e ponte local no aparelho.
 */
class LocalHealthServer(private val port: Int = 8790) {
    @Volatile
    private var running = false
    private var serverSocket: ServerSocket? = null

    fun start() {
        if (running) return
        running = true
        thread(isDaemon = true) {
            try {
                serverSocket = ServerSocket(port, 16, InetAddress.getByName("127.0.0.1"))
                while (running) {
                    val client = serverSocket?.accept() ?: break
                    thread(isDaemon = true) {
                        client.use { sock ->
                            val reader = BufferedReader(InputStreamReader(sock.getInputStream()))
                            val reqLine = reader.readLine() ?: ""
                            val body = if (reqLine.contains("/health")) {
                                """{"ok":true,"runtime":"android-kotlin-native","cosy":true}"""
                            } else {
                                "pong"
                            }
                            val ctype = if (reqLine.contains("/health")) "application/json" else "text/plain"
                            val resp = "HTTP/1.1 200 OK\\r\\nContent-Type: $ctype\\r\\nContent-Length: \${body.toByteArray().size}\\r\\nConnection: close\\r\\n\\r\\n$body"
                            sock.getOutputStream().write(resp.toByteArray(Charsets.UTF_8))
                        }
                    }
                }
            } catch (_: Exception) {
            }
        }
    }

    fun stop() {
        running = false
        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }
    }
}
`,
    },
    {
      path: 'app/src/main/java/com/qoder2api/hub/MainActivity.kt',
      content: `package com.qoder2api.hub

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

class MainActivity : AppCompatActivity() {

    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var webView: WebView
    private val localServer = LocalHealthServer(8790)
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        filePathCallback?.onReceiveValue(uris)
        filePathCallback = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.statusBarColor = Color.parseColor("#090B0E")
        window.navigationBarColor = Color.parseColor("#090B0E")
        localServer.start()

        swipeRefresh = SwipeRefreshLayout(this).apply {
            setColorSchemeColors(Color.parseColor("#10B981"))
            setProgressBackgroundColorSchemeColor(Color.parseColor("#12151B"))
        }

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(Color.parseColor("#090B0E"))
        }

        swipeRefresh.addView(webView)
        setContentView(swipeRefresh)

        swipeRefresh.setOnRefreshListener {
            webView.reload()
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            userAgentString = "$userAgentString Qoder2APIHubAndroid/2.0"
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val url = request?.url?.toString() ?: return false
                if (url.contains("qoder.com") ||
                    url.contains("qoder.com.cn") ||
                    url.contains("github.com")
                ) {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    return true
                }
                return false
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                swipeRefresh.isRefreshing = false
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                this@MainActivity.filePathCallback?.onReceiveValue(null)
                this@MainActivity.filePathCallback = filePathCallback
                val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                }
                fileChooserLauncher.launch(intent)
                return true
            }
        }

        webView.loadUrl(getString(R.string.hub_url))
    }

    override fun onDestroy() {
        localServer.stop()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
`,
    },
    {
      path: 'gradle.properties',
      content: `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
android.nonTransitiveRClass=true
`,
    },
    {
      path: '.github/workflows/build-apk.yml',
      content: `name: Build Qoder2API-Hub APK

on:
  workflow_dispatch:
  push:
    branches: [ main, master ]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up JDK 17
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'

      - name: Setup Android SDK
        uses: android-actions/setup-android@v3

      - name: Setup Gradle
        uses: gradle/actions/setup-gradle@v4
        with:
          gradle-version: '8.7'

      - name: Build Debug APK
        run: gradle assembleDebug --no-daemon

      - name: Upload APK Pronto
        uses: actions/upload-artifact@v4
        with:
          name: Qoder2API-Hub-APK
          path: app/build/outputs/apk/debug/*.apk
`,
    },
    {
      path: 'README.md',
      content: `# Qoder2API-Hub Android (APK Único Autônomo)

Este projeto Kotlin já inclui o motor criptográfico **COSY** nativo em Kotlin (\`QoderCosyEngine.kt\`) e ponte local embutida (\`LocalHealthServer.kt\`), sem exigir Termux, Python ou ferramentas externas.

## Opção 1: Gerar o arquivo .APK na nuvem (sem instalar Android Studio)
1. Crie um repositório (público ou privado) no GitHub e envie os arquivos desta pasta.
2. Abra a aba **Actions** do repositório e execute **Build Qoder2API-Hub APK**.
3. Ao finalizar (~2 minutos), baixe o artefato **Qoder2API-Hub-APK** contendo o \`.apk\` pronto para instalar no celular.

## Opção 2: Compilar localmente no Android Studio
1. Abra esta pasta no **Android Studio** (Hedgehog / Ladybug ou superior).
2. Aguarde a sincronização do Gradle.
3. Clique em **Build > Build Bundle(s) / APK(s) > Build APK(s)**.
4. Instale o arquivo \`app/build/outputs/apk/debug/app-debug.apk\` no seu celular Android.
`,
    },
  ];

  const blob = buildZipBlob(files);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Qoder2API-Hub-AndroidStudio.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
