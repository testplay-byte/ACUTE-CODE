package expo.modules.acutenet

import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.X509TrustManager

/**
 * acute-net — the ACUTE companion's networking floor (R106-S4a).
 *
 * TWO exported functions, one purpose: every byte between the phone and the
 * desktop sidecar rides through this module, so that TLS CERTIFICATE PINNING
 * (the TOFU trust model, LINKING-PROTOCOL.md §2/§5) is enforced at the
 * native socket layer, never in JS.
 *
 *   request(options) → Promise<{status, headers, bodyText}>
 *   openSse(options) → eventId   (long-lived streaming request, parsed as SSE
 *                                 server-side, delivered through the module's
 *                                 "data" | "error" | "close" events, each
 *                                 payload tagged with its eventId)
 *   closeSse(eventId)            (cancel a stream; the JS side owns reconnect
 *                                 logic — Kotlin just streams + reports)
 *
 * TLS DISCIPLINE (the whole point — R3 §1.9): when `pinSha256` is provided
 * (64 hex chars, no colons), the call installs a per-call X509TrustManager
 * that accepts EXACTLY a leaf certificate whose DER SHA-256 equals the pin
 * (constant-time compare; any mismatch is a hard TLS failure) and a
 * HostnameVerifier that accepts everything — the pin subsumes hostname
 * checking (the desktop's certificate carries IP SANs anyway). When
 * `pinSha256` is ABSENT, OkHttp's DEFAULT verification (standard CAs) is
 * used — the Cloudflare-tunnel path, R3 §4. There is never a global
 * trust-all: the pin overrides are per-client, constructed per call.
 */
class AcuteNetModule : Module() {

  private val nextEventId = AtomicInteger(1)
  private val sseCalls = ConcurrentHashMap<Int, Call>()
  private val clientCache = ConcurrentHashMap<String, OkHttpClient>()

  /** All event emissions hop through the main thread — one guaranteed-safe
   * path to sendEvent, whatever OkHttp dispatcher thread the stream reads on. */
  private val mainHandler = Handler(Looper.getMainLooper())

  override fun definition() = ModuleDefinition {
    Name("AcuteNet")
    Events("data", "error", "close")

    // ── request(options) → Promise<{status, headers, bodyText}> ──────────
    AsyncFunction("request") { options: Map<String, Any?>, promise: Promise ->
      val call = try {
        buildCall(options, sse = false)
      } catch (e: IllegalArgumentException) {
        promise.reject("bad-argument", e.message ?: "invalid request options", e)
        return@AsyncFunction
      } catch (e: Exception) {
        promise.reject("bad-argument", e.message ?: "could not build the request", e)
        return@AsyncFunction
      }
      call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
          if (call.isCanceled()) {
            promise.reject("canceled", "the request was canceled", e)
          } else {
            val kind = classifyNetworkError(e)
            val message = e.message ?: "network request failed"
            promise.reject(kind, message, e)
          }
        }

        override fun onResponse(call: Call, response: Response) {
          response.use {
            val bodyText = try {
              it.body?.string() ?: ""
            } catch (e: IOException) {
              promise.reject(classifyNetworkError(e), e.message ?: "failed to read the response body", e)
              return
            }
            // Duplicate header names (Set-Cookie etc.) are joined with ", " —
            // the JS side types headers as Record<string, string>.
            val headers = LinkedHashMap<String, String>()
            for ((name, value) in it.headers) {
              val existing = headers[name]
              headers[name] = if (existing == null) value else "$existing, $value"
            }
            val result: Map<String, Any?> = mapOf(
              "status" to it.code,
              "headers" to headers,
              "bodyText" to bodyText,
            )
            promise.resolve(result)
          }
        }
      })
    }

    // ── openSse(options) → eventId ────────────────────────────────────────
    Function("openSse") { options: Map<String, Any?> ->
      val eventId = nextEventId.getAndIncrement()
      val call = buildCall(options, sse = true)
      sseCalls[eventId] = call
      call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
          sseCalls.remove(eventId)
          val kind = if (call.isCanceled()) "canceled" else classifyNetworkError(e)
          val message = e.message ?: "the stream failed before connecting"
          emitError(eventId, kind, message, null)
          emitClose(eventId)
        }

        override fun onResponse(call: Call, response: Response) {
          if (!response.isSuccessful) {
            // The error envelope is JSON, not SSE — surface the status + a
            // capped body excerpt, then close. Never emit "data".
            val excerpt = try {
              response.body?.string()?.take(512) ?: ""
            } catch (_: IOException) {
              ""
            }
            val status = response.code
            response.close()
            sseCalls.remove(eventId)
            val suffix = if (excerpt.isBlank()) "" else ": $excerpt"
            emitError(eventId, "http", "server answered HTTP $status$suffix", status)
            emitClose(eventId)
            return
          }
          readSseBody(eventId, call, response)
        }
      })
      eventId
    }

    // ── closeSse(eventId) — cancel a live stream (JS owns reconnect) ──────
    Function("closeSse") { eventId: Double ->
      val id = eventId.toInt()
      sseCalls.remove(id)?.cancel()
      Unit
    }

    // ── teardown: a module must never leak live sockets past its lifetime ─
    OnDestroy {
      for (call in sseCalls.values) {
        call.cancel()
      }
      sseCalls.clear()
    }
  }

  // ── options → OkHttp Call ─────────────────────────────────────────────────

  /**
   * Build the OkHttp call from the JS options bag. `sse = true` marks the
   * long-lived streaming profile: no call/read timeouts (the stream is
   * expected to stay open for the whole turn; the JS connection manager owns
   * reconnect + close), only the connect timeout applies.
   */
  private fun buildCall(options: Map<String, Any?>, sse: Boolean): Call {
    val url = options["url"] as? String
      ?: throw IllegalArgumentException("options.url is required")
    if (!url.startsWith("https://")) {
      // TLS is mandatory: the device token must never ride plaintext.
      throw IllegalArgumentException("options.url must be an https:// URL")
    }
    val method = (options["method"] as? String)?.uppercase() ?: "GET"
    val headers = options["headers"] as? Map<*, *> ?: emptyMap<Any?, Any?>()
    val bodyText = options["bodyText"] as? String
    val timeoutMs = (options["timeoutMs"] as? Number)?.toLong() ?: DEFAULT_TIMEOUT_MS
    val pinHex = options["pinSha256"] as? String

    val pinBytes = if (pinHex == null) {
      null
    } else {
      hexToBytes32(pinHex)
        ?: throw IllegalArgumentException("options.pinSha256 must be 64 hex characters (no colons)")
    }

    val client = clientFor(pinBytes, timeoutMs, sse)

    val builder = Request.Builder()
      .url(url)
      .method(method, requestBodyFor(method, bodyText))
    for ((k, v) in headers) {
      if (k is String && v is String) {
        builder.header(k, v)
      }
    }
    if (bodyText != null && headers.keys.none { (it as? String)?.equals("content-type", ignoreCase = true) == true }) {
      builder.header("content-type", "application/json")
    }
    return client.newCall(builder.build())
  }

  /** OkHttp's body rules, made honest up front: a body only rides the
   * body-capable methods, and the body-requiring methods always get one. */
  private fun requestBodyFor(method: String, bodyText: String?): RequestBody? {
    val bodyCapable = method != "GET" && method != "HEAD"
    val bodyRequired = method == "POST" || method == "PUT" || method == "PATCH" || method == "PROPFIND"
    if (bodyText != null && !bodyCapable) {
      throw IllegalArgumentException("options.bodyText is not allowed with $method requests")
    }
    if (bodyText == null && bodyRequired) {
      throw IllegalArgumentException("options.bodyText is required for $method requests")
    }
    return if (bodyText != null) bodyText.toRequestBody(null) else null
  }

  /**
   * Per-profile OkHttpClient, cached by (pin, timeout, sse-ness). The pin
   * overrides are per-client — never a global trust-all. When `pin` is null
   * OkHttp's DEFAULT verification (standard CAs — the tunnel path) runs.
   */
  private fun clientFor(pin: ByteArray?, timeoutMs: Long, sse: Boolean): OkHttpClient {
    val key = "${pin?.joinToString("") { "%02x".format(it) } ?: "nopin"}|$timeoutMs|$sse"
    clientCache[key]?.let { return it }
    val builder = OkHttpClient.Builder()
      .connectTimeout(timeoutMs.coerceAtMost(MAX_CONNECT_TIMEOUT_MS), TimeUnit.MILLISECONDS)
      .retryOnConnectionFailure(false)
    if (sse) {
      // Long-lived stream: no read/call timeout. OkHttp streams bodies
      // natively (no response buffering); gzip is transparent.
      builder.readTimeout(0, TimeUnit.MILLISECONDS)
      builder.callTimeout(0, TimeUnit.MILLISECONDS)
    } else {
      builder.callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
    }
    if (pin != null) {
      val trustManager = PinnedTrustManager(pin)
      val sslContext = SSLContext.getInstance("TLS")
      sslContext.init(null, arrayOf<X509TrustManager>(trustManager), SecureRandom())
      builder.sslSocketFactory(sslContext.socketFactory, trustManager)
      // The pin subsumes hostname checking (R3 §1.9): the pinned fingerprint
      // IS the identity. The desktop cert also carries IP SANs, but we never
      // rely on that here.
      builder.hostnameVerifier(HostnameVerifier { _, _ -> true })
    }
    val client = builder.build()
    if (clientCache.size >= CLIENT_CACHE_LIMIT) {
      clientCache.clear()
    }
    clientCache[key] = client
    return client
  }

  // ── SSE body reader — the desktop client's semantics, ported ──────────────

  /**
   * Reads the response body as a server-sent-event stream and emits "data"
   * events. Ports the desktop's frame-splitting semantics (src/lib/api.ts):
   * frames are separated by a blank line, `data:` lines within a frame are
   * joined with "\n", `:` comment lines (heartbeats) are ignored, and the
   * `event:` field rides the payload when present. `id:`/`retry:` lines are
   * ignored (the phone never needs Last-Event-ID for v1).
   */
  private fun readSseBody(eventId: Int, call: Call, response: Response) {
    val source = try {
      response.body?.source()
    } catch (e: IOException) {
      sseCalls.remove(eventId)
      response.close()
      emitError(eventId, classifyNetworkError(e), e.message ?: "the stream body was unavailable", null)
      emitClose(eventId)
      return
    }
    if (source == null) {
      sseCalls.remove(eventId)
      response.close()
      emitError(eventId, "http", "the stream carried no body", null)
      emitClose(eventId)
      return
    }
    try {
      var eventName: String? = null
      val dataLines = ArrayList<String>()
      while (true) {
        val line = source.readUtf8Line() ?: break // null = stream ended
        when {
          line.isEmpty() -> {
            // Frame boundary — flush what accumulated.
            if (dataLines.isNotEmpty()) {
              emitData(eventId, eventName, dataLines.joinToString("\n"))
            }
            dataLines.clear()
            eventName = null
          }
          line.startsWith(":") -> { /* comment / heartbeat — ignored per the SSE spec */ }
          line.startsWith("data:") -> dataLines.add(stripFieldValue(line, 5))
          line.startsWith("event:") -> eventName = stripFieldValue(line, 6)
          // id:, retry: and unknown fields are ignored.
        }
      }
      // The HTTP stream ended. Per the desktop client's R43 lesson this is a
      // silent death unless a terminal frame arrived — but that judgment is
      // the JS consumer's (it knows which frames are terminal); Kotlin's
      // contract is just: stream ended ⇒ "close" event.
      sseCalls.remove(eventId)
      emitClose(eventId)
    } catch (e: IOException) {
      sseCalls.remove(eventId)
      val kind = if (call.isCanceled()) "canceled" else classifyNetworkError(e)
      emitError(eventId, kind, e.message ?: "the stream ended with an error", null)
      emitClose(eventId)
    } finally {
      response.close()
    }
  }

  // ── event emission (main thread) ─────────────────────────────────────────

  private fun emitData(eventId: Int, eventName: String?, data: String) {
    val body = LinkedHashMap<String, Any?>()
    body["eventId"] = eventId
    body["data"] = data
    if (eventName != null) {
      body["event"] = eventName
    }
    mainHandler.post { sendEvent("data", body) }
  }

  private fun emitError(eventId: Int, kind: String, message: String, status: Int?) {
    val body = LinkedHashMap<String, Any?>()
    body["eventId"] = eventId
    body["kind"] = kind
    body["message"] = message
    if (status != null) {
      body["status"] = status
    }
    mainHandler.post { sendEvent("error", body) }
  }

  private fun emitClose(eventId: Int) {
    val body = LinkedHashMap<String, Any?>()
    body["eventId"] = eventId
    mainHandler.post { sendEvent("close", body) }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** "data: x" / "data:x" → "x" — one optional leading space after the colon
   * (the SSE spec, and the desktop's parseSseDataBlock, spelled the same). */
  private fun stripFieldValue(line: String, prefixLength: Int): String {
    val rest = line.substring(prefixLength)
    return if (rest.startsWith(" ")) rest.substring(1) else rest
  }

  /** 64 hex chars (case-insensitive) → 32 bytes, or null when malformed. */
  private fun hexToBytes32(hex: String): ByteArray? {
    if (hex.length != 64) return null
    val out = ByteArray(32)
    for (i in 0 until 32) {
      val hi = hex[i * 2].digitToIntOrNull(16) ?: return null
      val lo = hex[i * 2 + 1].digitToIntOrNull(16) ?: return null
      out[i] = ((hi shl 4) or lo).toByte()
    }
    return out
  }

  /**
   * Map a transport failure to the coarse kind the JS layer reasons about:
   * "tls" (a REAL certificate/pin mismatch — the honest re-pair signal),
   * "network" (unreachable/timeout/aborted handshake — the honest retry
   * signal), else "unknown".
   *
   * ROUND-109 (the reliability fix): a bare SSLException is NO LONGER
   * "tls" — OkHttp wraps aborted/reset handshakes (flaky LAN, roaming
   * Wi-Fi) in SSLException too, and those were being classified as
   * fatal-never-retry "host offline until rescan". ONLY a
   * CertificateException in the cause chain (the PinnedTrustManager's
   * mismatch verdict, or the system trust manager's) is "tls"; every other
   * TLS-shaped failure is retry-shaped "network".
   */
  private fun classifyNetworkError(e: Throwable?): String {
    var c: Throwable? = e
    while (c !== null) {
      if (c is CertificateException) return "tls"
      c = c.cause
    }
    return when (e) {
      is SSLException -> "network"
      is ConnectException, is NoRouteToHostException, is UnknownHostException,
      is SocketTimeoutException, is java.io.InterruptedIOException -> "network"
      else -> "unknown"
    }
  }

  private companion object {
    const val DEFAULT_TIMEOUT_MS = 15_000L
    const val MAX_CONNECT_TIMEOUT_MS = 30_000L
    const val CLIENT_CACHE_LIMIT = 8
  }
}

/**
 * The TOFU trust manager: accepts EXACTLY the pinned leaf. Constant-time
 * compare (MessageDigest.isEqual) — a mismatch is a hard TLS failure, and
 * nothing about the comparison leaks timing structure.
 */
private class PinnedTrustManager(private val pin: ByteArray) : X509TrustManager {

  override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
    // The phone never presents client certificates — refuse, honestly.
    throw CertificateException("client certificates are not accepted")
  }

  override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
    if (chain.isEmpty()) {
      throw CertificateException("the server presented an empty certificate chain")
    }
    val digest = MessageDigest.getInstance("SHA-256").digest(chain[0].encoded)
    if (!MessageDigest.isEqual(digest, pin)) {
      throw CertificateException("the certificate fingerprint does not match the pinned fingerprint")
    }
  }

  override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
}
