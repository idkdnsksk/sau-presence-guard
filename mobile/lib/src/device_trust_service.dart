import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:crypto/crypto.dart';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'models.dart';

class DeviceTrustService {
  static const MethodChannel _channel = MethodChannel('kz.sau.presence_guard/device_trust');
  static const FlutterSecureStorage _storage = FlutterSecureStorage();

  Future<DeviceEvidence> collect() async {
    var secret = await _storage.read(key: 'sau_presence_installation_secret');
    if (secret == null) {
      final random = Random.secure();
      secret = base64UrlEncode(List<int>.generate(32, (_) => random.nextInt(256))).replaceAll('=', '');
      await _storage.write(key: 'sau_presence_installation_secret', value: secret);
    }
    final native = await _channel.invokeMapMethod<String, dynamic>('getDeviceSecuritySignals') ?? <String, dynamic>{};
    final info = DeviceInfoPlugin();
    var emulator = native['isEmulator'] as bool? ?? false;
    if (Platform.isAndroid) emulator = emulator || !(await info.androidInfo).isPhysicalDevice;
    if (Platform.isIOS) emulator = emulator || !(await info.iosInfo).isPhysicalDevice;
    return DeviceEvidence(
      installationIdHash: sha256.convert(utf8.encode(secret)).toString(),
      platform: Platform.isAndroid ? 'android' : 'ios',
      isEmulator: emulator,
      isRooted: native['isRooted'] as bool? ?? false,
      isJailbroken: native['isJailbroken'] as bool? ?? false,
    );
  }

  Future<String> playIntegrityToken(String requestHash) async {
    final token = await _channel.invokeMethod<String>('getPlayIntegrityToken', <String, Object>{'requestHash': requestHash});
    if (token == null || token.isEmpty) throw StateError('Play Integrity не вернул токен');
    return token;
  }

  Future<Map<String, dynamic>> appAttestEvidence(String challenge, String clientData) async {
    final result = await _channel.invokeMapMethod<String, dynamic>('getAppAttestEvidence', <String, Object>{
      'challenge': challenge,
      'clientData': clientData,
    });
    if (result == null) throw StateError('App Attest недоступен');
    return result;
  }

  Future<void> markAppleKeyRegistered() => _channel.invokeMethod<void>('markAppAttestRegistered');
}
