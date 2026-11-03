import 'dart:convert';
import 'package:http/http.dart' as http;
import 'models.dart';

typedef AuthTokenProvider = Future<String> Function();

class PresenceGuardApi {
  PresenceGuardApi({required this.baseUrl, required this.authToken, http.Client? client})
      : _client = client ?? http.Client();

  final Uri baseUrl;
  final AuthTokenProvider authToken;
  final http.Client _client;

  Future<Map<String, dynamic>> issueHostQr(String sessionId, LocationEvidence location) => _request(
        'POST',
        '/api/v1/sessions/${Uri.encodeComponent(sessionId)}/qr',
        body: location.toJson(),
      );

  Future<Map<String, dynamic>> challenge(String sessionId, DeviceEvidence device) => _request(
        'POST',
        '/api/v1/integrity/challenge',
        body: <String, Object>{
          'sessionId': sessionId,
          'installationIdHash': device.installationIdHash,
          'platform': device.platform,
        },
      );

  Future<void> registerAppleKey({
    required String sessionId,
    required DeviceEvidence device,
    required String challenge,
    required String keyId,
    required String attestation,
  }) async {
    await _request('POST', '/api/v1/integrity/apple/register', body: <String, Object>{
      'sessionId': sessionId,
      'installationIdHash': device.installationIdHash,
      'challenge': challenge,
      'keyId': keyId,
      'attestation': attestation,
    });
  }

  Future<CheckInOutcome> checkIn({
    required String qrToken,
    required LocationEvidence location,
    required DeviceEvidence device,
    required Map<String, Object> integrity,
  }) async {
    final json = await _request('POST', '/api/v1/attendance/check-in', body: <String, Object>{
      'qrToken': qrToken,
      'location': location.toJson(),
      'device': device.toJson(),
      'integrity': integrity,
    });
    return CheckInOutcome.fromApi(json);
  }

  Future<Map<String, dynamic>> _request(String method, String path, {Map<String, Object>? body}) async {
    final token = await authToken();
    final request = http.Request(method, baseUrl.resolve(path))
      ..headers.addAll(<String, String>{
        'authorization': 'Bearer $token',
        'content-type': 'application/json',
        'accept': 'application/json',
      });
    if (body != null) request.body = jsonEncode(body);
    final streamed = await _client.send(request).timeout(const Duration(seconds: 20));
    final response = await http.Response.fromStream(streamed);
    final decoded = response.body.isEmpty ? <String, dynamic>{} : jsonDecode(response.body) as Map<String, dynamic>;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final error = decoded['error'] as Map<String, dynamic>?;
      throw GuardApiException(
        error?['code'] as String? ?? 'HTTP_${response.statusCode}',
        error?['message'] as String? ?? 'Ошибка сервера',
        details: error?['details'],
      );
    }
    return decoded;
  }
}
