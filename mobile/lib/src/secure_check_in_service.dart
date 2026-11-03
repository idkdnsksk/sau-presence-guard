import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:geolocator/geolocator.dart';
import 'api_client.dart';
import 'device_trust_service.dart';
import 'models.dart';

class SecureCheckInService {
  SecureCheckInService({required this.api, DeviceTrustService? deviceTrust})
      : deviceTrust = deviceTrust ?? DeviceTrustService();

  final PresenceGuardApi api;
  final DeviceTrustService deviceTrust;

  Future<CheckInOutcome> checkIn(String rawQrToken) async {
    final qr = QrEnvelope.fromRaw(rawQrToken);
    // Foreground location is requested exactly here. No stream or background permission is used.
    final location = await _currentLocation();
    final device = await deviceTrust.collect();
    var challenge = await api.challenge(qr.sessionId, device);
    var challengeValue = challenge['challenge'] as String;
    var clientData = _canonicalClientData(challengeValue, rawQrToken, location, device);
    Map<String, Object> integrity;

    if (Platform.isAndroid) {
      final requestHash = base64UrlEncode(sha256.convert(utf8.encode(clientData)).bytes).replaceAll('=', '');
      final token = await deviceTrust.playIntegrityToken(requestHash);
      integrity = <String, Object>{
        'provider': 'play_integrity',
        'challenge': challengeValue,
        'token': token,
      };
    } else if (Platform.isIOS) {
      var evidence = await deviceTrust.appAttestEvidence(challengeValue, clientData);
      if (evidence['mode'] == 'registration') {
        await api.registerAppleKey(
          sessionId: qr.sessionId,
          device: device,
          challenge: challengeValue,
          keyId: evidence['keyId'] as String,
          attestation: evidence['attestation'] as String,
        );
        await deviceTrust.markAppleKeyRegistered();
        challenge = await api.challenge(qr.sessionId, device);
        challengeValue = challenge['challenge'] as String;
        clientData = _canonicalClientData(challengeValue, rawQrToken, location, device);
        evidence = await deviceTrust.appAttestEvidence(challengeValue, clientData);
      }
      integrity = <String, Object>{
        'provider': 'app_attest',
        'challenge': challengeValue,
        'keyId': evidence['keyId'] as String,
        'assertion': evidence['assertion'] as String,
        'clientData': clientData,
      };
    } else {
      throw UnsupportedError('Поддерживаются только Android и iOS');
    }

    return api.checkIn(qrToken: rawQrToken, location: location, device: device, integrity: integrity);
  }

  Future<LocationEvidence> _currentLocation() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      throw const GuardApiException('LOCATION_DISABLED', 'Включите геолокацию для отметки');
    }
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
    if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
      throw const GuardApiException('LOCATION_PERMISSION_DENIED', 'Разрешите геолокацию только во время использования');
    }
    final position = await Geolocator.getCurrentPosition(
      locationSettings: const LocationSettings(accuracy: LocationAccuracy.best, timeLimit: Duration(seconds: 12)),
    );
    return LocationEvidence(
      latitude: position.latitude,
      longitude: position.longitude,
      accuracyM: position.accuracy,
      recordedAt: position.timestamp.toUtc(),
      isMocked: position.isMocked,
    );
  }

  String _canonicalClientData(
    String challenge,
    String qrToken,
    LocationEvidence location,
    DeviceEvidence device,
  ) => jsonEncode(<String, Object>{
        'challenge': challenge,
        'qrToken': qrToken,
        'location': <String, Object>{
          'latitude': location.latitude.toStringAsFixed(6),
          'longitude': location.longitude.toStringAsFixed(6),
          'accuracyM': location.accuracyM.toStringAsFixed(2),
          'recordedAt': location.recordedAt.toUtc().toIso8601String(),
          'isMocked': location.isMocked,
        },
        'device': <String, Object>{
          'installationIdHash': device.installationIdHash,
          'platform': device.platform,
        },
      });
}
