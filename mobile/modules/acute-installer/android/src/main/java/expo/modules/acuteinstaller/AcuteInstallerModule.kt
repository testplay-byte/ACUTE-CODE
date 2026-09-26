package expo.modules.acuteinstaller

import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.IOException

/**
 * acute-installer — the ACUTE companion's APK update floor (R124, item 1:
 * "an update functionality for the Android application too… download the
 * latest version and be able to install the APK").
 *
 * FIVE+ONE exported functions, one purpose — the whole APK update lifecycle on
 * the phone, native so that the big file never crosses the JS bridge:
 *
 *   downloadApk({url, headers?, fileName}) → Promise<{path, size, bytes}>
 *       A STREAMING download into the app's PRIVATE cache dir
 *       (cacheDir/updates/<fileName>), reporting live progress through the
 *       module's "progress" event ({url, received, total, fraction}) so the
 *       UI can drive a real determinate bar (the owner's "no animation while
 *       it is processing" rule, R123, applies to downloads too). The body is
 *       written straight to disk — an APK never materializes in memory, and
 *       never as a base64 string.
 *   cancelDownload()
 *       Cancels the in-flight download (the promise rejects with code
 *       "canceled"; the partial file is deleted).
 *   deleteDownloadedApk({path}) → Promise<Boolean> (R130-D)
 *       Discards one cached update file — the owner's "delete it from
 *       there" affordance after a download lands. The path is validated
 *       against the module's own updates dir; a missing file still
 *       resolves TRUE (discarded is discarded).
 *   installApk({path}) → Promise<void>
 *       Fires the system package installer: the cached APK is handed to
 *       Android through a FileProvider content:// URI (the only sanctioned
 *       way to share a private file with another process) with
 *       ACTION_VIEW + "application/vnd.android.package-archive" +
 *       FLAG_GRANT_READ_URI_PERMISSION. The promise resolves once the
 *       intent is HANDED OFF (the installer UI itself belongs to the OS —
 *       the user confirms there, which is exactly the confirmation step an
 *       APK install deserves).
 *   canRequestInstalls() → Promise<Boolean>
 *       Honest answer to "may this app install packages?" — Android 8+
 *       requires the per-app "Install unknown apps" grant
 *       (REQUEST_INSTALL_PACKAGES); without it the install intent would
 *       dead-end in the OS's own refusal.
 *   openInstallPermissionSettings()
 *       Sends the user to THIS app's page in the system's "Install unknown
 *       apps" screen (ACTION_MANAGE_UNKNOWN_APP_SOURCES) — the one-tap path
 *       from a failed install to the grant.
 *
 * WHY A SEPARATE MODULE (not a third function on acute-net): acute-net's
 * whole identity is the TOFU PIN — every byte to the DESKTOP rides pinned
 * TLS. An APK comes from GitHub over ordinary public CA TLS; bolting that
 * onto the pinned floor would dilute its one job. This module uses OkHttp's
 * DEFAULT verification (standard CAs) exactly like a browser download, and
 * says so here.
 *
 * OkHttp is provided transitively by React Native's `api` dependency
 * (RN 0.86 pins okhttp 4.9.x) — `compileOnly` in build.gradle keeps this
 * module from forcing a version, same discipline as acute-net. androidx.core
 * (FileProvider) likewise ships with every Expo app.
 */
class AcuteInstallerModule : Module() {

  /** The single in-flight download (the updater UI is single-flight by
   * design — one APK at a time; a second downloadApk call while one runs
   * rejects with "busy" instead of silently racing two partial files). */
  private var activeCall: Call? = null

  /** Event emissions hop through the main thread — one guaranteed-safe path
   * to sendEvent, whatever OkHttp dispatcher thread the body reads on (the
   * AcuteNetModule discipline). */
  private val mainHandler = Handler(Looper.getMainLooper())

  /** The download client: generous timeouts (a 57 MB APK on slow mobile
   * data is minutes, not seconds), NO retry-on-failure at this layer — the
   * JS surface owns retry policy so the UI can say what it is doing. */
  private val client by lazy {
    OkHttpClient.Builder()
      .connectTimeout(java.util.concurrent.TimeUnit.SECONDS.toMillis(30), java.util.concurrent.TimeUnit.MILLISECONDS)
      .readTimeout(java.util.concurrent.TimeUnit.SECONDS.toMillis(120), java.util.concurrent.TimeUnit.MILLISECONDS)
      .build()
  }

  /** Where cached APKs live: cacheDir/updates/. The OS may reclaim cache
   * under storage pressure (correct — a stale half-downloaded APK is
   * garbage, and the updater re-downloads on demand). */
  private val updatesDir: File
    get() = File(appContext.reactContext?.cacheDir ?: File(appContext.reactContext?.filesDir, "updates"), "updates")

  override fun definition() = ModuleDefinition {
    Name("AcuteInstaller")
    Events("progress")

    // ── downloadApk({url, headers?, fileName}) → {path, size, bytes} ──────
    AsyncFunction("downloadApk") { options: Map<String, Any?>, promise: Promise ->
      val url = options["url"] as? String
      val fileName = options["fileName"] as? String
      if (url.isNullOrBlank() || fileName.isNullOrBlank()) {
        promise.reject("bad-argument", "downloadApk needs a non-empty url and fileName", null)
        return@AsyncFunction
      }
      if (activeCall != null) {
        promise.reject("busy", "a download is already running", null)
        return@AsyncFunction
      }

      @Suppress("UNCHECKED_CAST")
      val rawHeaders = options["headers"] as? Map<String, String> ?: emptyMap()

      val dir = updatesDir.apply { mkdirs() }
      // A fileName from our own JS layer, but sanitized anyway — this is a
      // path segment handed to the filesystem.
      val safeName = fileName.replace(Regex("[^A-Za-z0-9._-]"), "_")
      val target = File(dir, safeName)
      // A previous attempt's partial file must never be appended to.
      if (target.exists()) target.delete()

      val request = Request.Builder()
        .url(url)
        .apply { rawHeaders.forEach { (k, v) -> header(k, v) } }
        .build()

      val call = client.newCall(request)
      activeCall = call
      call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
          activeCall = null
          // The partial file is garbage either way (canceled or failed).
          target.delete()
          if (call.isCanceled()) {
            promise.reject("canceled", "the download was canceled", e)
          } else {
            promise.reject("network", e.message ?: "the download failed", e)
          }
        }

        override fun onResponse(call: Call, response: Response) {
          response.use { res ->
            if (!res.isSuccessful) {
              activeCall = null
              target.delete()
              promise.reject(
                "http-" + res.code,
                "the download failed with HTTP ${res.code}",
                null
              )
              return
            }
            val total = res.body?.contentLength() ?: -1L
            try {
              val sink = java.io.FileOutputStream(target)
              val source = res.body?.byteStream()
              if (source == null) {
                sink.close()
                activeCall = null
                target.delete()
                promise.reject("network", "the response carried no body", null)
                return
              }
              val buffer = ByteArray(64 * 1024)
              var received = 0L
              var lastReportedFraction = -1.0
              // For the unknown-total path (no Content-Length): byte
              // progress reported every 512 KB instead of fractions.
              var lastReportedBytes = 0L
              source.use { input ->
                sink.use { out ->
                  while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    out.write(buffer, 0, read)
                    received += read.toLong()
                    // Throttle progress events to ~1% steps — a per-chunk
                    // event would flood the bridge worse than the download
                    // floods the socket.
                    if (total > 0) {
                      val fraction = received.toDouble() / total.toDouble()
                      if (fraction - lastReportedFraction >= 0.01) {
                        lastReportedFraction = fraction
                        emitProgress(url, received, total, fraction)
                      }
                    } else if (received - lastReportedBytes >= 512L * 1024L) {
                      lastReportedBytes = received
                      emitProgress(url, received, -1L, -1.0)
                    }
                  }
                }
              }
              activeCall = null
              // The file is only a real deliverable if non-empty.
              if (received <= 0) {
                target.delete()
                promise.reject("network", "the download produced an empty file", null)
                return
              }
              emitProgress(url, received, if (total > 0) total else received, 1.0)
              promise.resolve(
                mapOf(
                  "path" to target.absolutePath,
                  "size" to received,
                )
              )
            } catch (e: IOException) {
              activeCall = null
              target.delete()
              promise.reject("network", e.message ?: "writing the download failed", e)
            }
          }
        }
      })
    }

    // ── cancelDownload() — the honest stop button for the bar ────────────
    AsyncFunction("cancelDownload") { promise: Promise ->
      val call = activeCall
      if (call != null) {
        call.cancel()
        promise.resolve(true)
      } else {
        promise.resolve(false)
      }
    }

    // ── installApk({path}) — hand the APK to the OS installer ────────────
    AsyncFunction("installApk") { options: Map<String, Any?>, promise: Promise ->
      val path = options["path"] as? String
      if (path.isNullOrBlank()) {
        promise.reject("bad-argument", "installApk needs a path", null)
        return@AsyncFunction
      }
      val file = File(path)
      if (!file.exists() || file.length() <= 0) {
        promise.reject("bad-argument", "the APK file is missing or empty: $path", null)
        return@AsyncFunction
      }
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("no-context", "the app context is gone", null)
        return@AsyncFunction
      }
      mainHandler.post {
        try {
          // The content:// URI — the ONLY sanctioned way to hand a private
          // cache file to another process. Authority lives in the manifest
          // via plugins/with-android-apk-installer.js; the path whitelist
          // lives in res/xml/acute_installer_paths.xml.
          val authority = context.packageName + ".acuteinstaller"
          val uri = FileProvider.getUriForFile(context, authority, file)
          val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
          context.startActivity(intent)
          promise.resolve(null)
        } catch (e: Exception) {
          promise.reject(
            "install-failed",
            e.message ?: "could not start the package installer",
            e
          )
        }
      }
    }

    // ── canRequestInstalls() — the honest "may we install?" probe ────────
    AsyncFunction("canRequestInstalls") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("no-context", "the app context is gone", null)
        return@AsyncFunction
      }
      // REQUEST_INSTALL_PACKAGES is an install-time manifest permission
      // (added by the plugin); the RUNTIME grant the user controls is
      // canRequestPackageInstalls() on Android 8+. Below 8 the permission
      // model did not gate sideloads — "sources" was a global toggle.
      val allowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.packageManager.canRequestPackageInstalls()
      } else {
        true
      }
      promise.resolve(allowed)
    }

    // ── deleteDownloadedApk({path}) — discard a cached update (R130-D: the
    // owner's "the user will also be given an option to cancel it from there
    // or delete it from there") — deletes the one cached file; a missing
    // file still resolves TRUE (discarded is discarded). The path is
    // validated to live UNDER the module's own updates dir — a caller can
    // never aim this at an arbitrary file. ──
    AsyncFunction("deleteDownloadedApk") { options: Map<String, Any?>, promise: Promise ->
      val path = options["path"] as? String
      if (path.isNullOrBlank()) {
        promise.reject("bad-argument", "deleteDownloadedApk needs a path", null)
        return@AsyncFunction
      }
      val target = File(path)
      val root = updatesDir.canonicalFile
      if (!target.canonicalFile.startsWith(root)) {
        promise.reject("bad-path", "the path is outside the updates cache", null)
        return@AsyncFunction
      }
      try {
        if (target.exists()) {
          target.delete()
        }
        promise.resolve(true)
      } catch (e: Exception) {
        promise.reject("delete-failed", e.message ?: "could not delete the cached APK", e)
      }
    }

    // ── openInstallPermissionSettings() — the one-tap grant path ─────────
    AsyncFunction("openInstallPermissionSettings") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("no-context", "the app context is gone", null)
        return@AsyncFunction
      }
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        promise.resolve(false)
        return@AsyncFunction
      }
      mainHandler.post {
        try {
          val intent = Intent(
            android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            android.net.Uri.parse("package:" + context.packageName)
          ).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
          context.startActivity(intent)
          promise.resolve(true)
        } catch (e: Exception) {
          promise.reject(
            "settings-failed",
            e.message ?: "could not open the install-permission screen",
            e
          )
        }
      }
    }
  }

  /** Progress events ride the main thread (AcuteNet's discipline). */
  private fun emitProgress(url: String, received: Long, total: Long, fraction: Double) {
    mainHandler.post {
      sendEvent(
        "progress",
        mapOf(
          "url" to url,
          "received" to received,
          "total" to total,
          "fraction" to fraction,
        )
      )
    }
  }
}
