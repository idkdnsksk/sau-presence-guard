package kz.sau.presence_guard

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import com.google.android.play.core.integrity.StandardIntegrityManager
import com.google.android.play.core.integrity.StandardIntegrityManagerFactory
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File

class SauPresenceGuardPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    private lateinit var context: Context
    private lateinit var channel: MethodChannel
    private var tokenProvider: StandardIntegrityManager.StandardIntegrityTokenProvider? = null
    private var preparing = false
    private val waiting = mutableListOf<Pair<String, MethodChannel.Result>>()

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, "kz.sau.presence_guard/device_trust")
        channel.setMethodCallHandler(this)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
        waiting.clear()
        tokenProvider = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "getDeviceSecuritySignals" -> result.success(
                mapOf(
                    "isEmulator" to isProbablyEmulator(),
                    "isRooted" to isProbablyRooted(),
                    "isJailbroken" to false,
                )
            )
            "getPlayIntegrityToken" -> {
                val requestHash = call.argument<String>("requestHash")
                if (requestHash.isNullOrBlank()) result.error("INVALID_REQUEST_HASH", "requestHash is required", null)
                else requestIntegrityToken(requestHash, result)
            }
            else -> result.notImplemented()
        }
    }

    private fun requestIntegrityToken(requestHash: String, result: MethodChannel.Result) {
        val prepared = tokenProvider
        if (prepared != null) {
            requestFromProvider(prepared, requestHash, result)
            return
        }
        waiting.add(requestHash to result)
        if (preparing) return
        preparing = true
        val cloudProjectNumber = cloudProjectNumber()
        if (cloudProjectNumber == null || cloudProjectNumber == 0L) {
            finishPreparationError("PLAY_INTEGRITY_CONFIG", "CLOUD_PROJECT_NUMBER is not configured")
            return
        }
        val manager = StandardIntegrityManagerFactory.create(context)
        val request = StandardIntegrityManager.PrepareIntegrityTokenRequest.builder()
            .setCloudProjectNumber(cloudProjectNumber)
            .build()
        manager.prepareIntegrityToken(request)
            .addOnSuccessListener { provider ->
                tokenProvider = provider
                preparing = false
                val pending = waiting.toList()
                waiting.clear()
                pending.forEach { (hash, callback) -> requestFromProvider(provider, hash, callback) }
            }
            .addOnFailureListener { error ->
                finishPreparationError("PLAY_INTEGRITY_PREPARE_FAILED", error.localizedMessage ?: "Preparation failed")
            }
    }

    private fun requestFromProvider(
        provider: StandardIntegrityManager.StandardIntegrityTokenProvider,
        requestHash: String,
        result: MethodChannel.Result,
    ) {
        val request = StandardIntegrityManager.StandardIntegrityTokenRequest.builder()
            .setRequestHash(requestHash)
            .build()
        provider.request(request)
            .addOnSuccessListener { response -> result.success(response.token()) }
            .addOnFailureListener { error ->
                // A provider may expire; clear it so the next attempt prepares a fresh provider.
                tokenProvider = null
                result.error("PLAY_INTEGRITY_FAILED", error.localizedMessage, null)
            }
    }

    private fun finishPreparationError(code: String, message: String) {
        preparing = false
        val pending = waiting.toList()
        waiting.clear()
        pending.forEach { (_, callback) -> callback.error(code, message, null) }
    }

    private fun cloudProjectNumber(): Long? {
        val flags = PackageManager.GET_META_DATA
        val appInfo = context.packageManager.getApplicationInfo(context.packageName, flags)
        return appInfo.metaData?.get("kz.sau.presence_guard.CLOUD_PROJECT_NUMBER")?.toString()?.toLongOrNull()
    }

    private fun isProbablyEmulator(): Boolean =
        Build.FINGERPRINT.startsWith("generic") ||
            Build.FINGERPRINT.lowercase().contains("emulator") ||
            Build.MODEL.contains("google_sdk") ||
            Build.MODEL.lowercase().contains("emulator") ||
            Build.MANUFACTURER.lowercase().contains("genymotion") ||
            Build.HARDWARE.lowercase().contains("goldfish") ||
            Build.HARDWARE.lowercase().contains("ranchu") ||
            Build.PRODUCT.lowercase().contains("sdk")

    private fun isProbablyRooted(): Boolean {
        if (Build.TAGS?.contains("test-keys") == true) return true
        val paths = arrayOf(
            "/system/app/Superuser.apk", "/system/bin/su", "/system/xbin/su", "/sbin/su",
            "/vendor/bin/su", "/data/local/bin/su", "/data/local/xbin/su", "/data/adb/magisk",
        )
        return paths.any { File(it).exists() }
    }
}
