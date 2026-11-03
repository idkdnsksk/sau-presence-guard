import 'dart:convert';

class LocationEvidence {
  const LocationEvidence({
    required this.latitude,
    required this.longitude,
    required this.accuracyM,
    required this.recordedAt,
    required this.isMocked,
  });

  final double latitude;
  final double longitude;
  final double accuracyM;
  final DateTime recordedAt;
  final bool isMocked;

  Map<String, Object> toJson() => <String, Object>{
        'latitude': latitude,
        'longitude': longitude,
        'accuracyM': accuracyM,
        'recordedAt': recordedAt.toUtc().toIso8601String(),
        'isMocked': isMocked,
      };
}

class DeviceEvidence {
  const DeviceEvidence({
    required this.installationIdHash,
    required this.platform,
    required this.isEmulator,
    required this.isRooted,
    required this.isJailbroken,
  });

  final String installationIdHash;
  final String platform;
  final bool isEmulator;
  final bool isRooted;
  final bool isJailbroken;

  Map<String, Object> toJson() => <String, Object>{
        'installationIdHash': installationIdHash,
        'platform': platform,
        'isEmulator': isEmulator,
        'isRooted': isRooted,
        'isJailbroken': isJailbroken,
      };
}

class RiskReason {
  const RiskReason({required this.code, required this.title, required this.detail, required this.severity});

  factory RiskReason.fromJson(Map<String, dynamic> json) => RiskReason(
        code: json['code'] as String? ?? 'UNKNOWN',
        title: json['title'] as String? ?? 'Проверка',
        detail: json['detail'] as String? ?? '',
        severity: json['severity'] as String? ?? 'warning',
      );

  final String code;
  final String title;
  final String detail;
  final String severity;
}

class CheckInOutcome {
  const CheckInOutcome({
    required this.status,
    required this.reasons,
    required this.riskScore,
    this.attendanceId,
    this.idempotent = false,
  });

  factory CheckInOutcome.fromApi(Map<String, dynamic> json) {
    final data = (json['attendance'] ?? json['result']) as Map<String, dynamic>;
    return CheckInOutcome(
      status: data['status'] as String,
      reasons: ((data['reasons'] as List<dynamic>?) ?? const <dynamic>[])
          .map((dynamic item) => RiskReason.fromJson(item as Map<String, dynamic>))
          .toList(growable: false),
      riskScore: (data['riskScore'] as num?)?.toInt() ?? 0,
      attendanceId: data['id'] as String?,
      idempotent: data['idempotent'] as bool? ?? false,
    );
  }

  final String status;
  final List<RiskReason> reasons;
  final int riskScore;
  final String? attendanceId;
  final bool idempotent;
}

class GuardApiException implements Exception {
  const GuardApiException(this.code, this.message, {this.details});
  final String code;
  final String message;
  final Object? details;

  @override
  String toString() => '$code: $message';
}

class QrEnvelope {
  const QrEnvelope({required this.token, required this.sessionId});

  factory QrEnvelope.fromRaw(String token) {
    final parts = token.split('.');
    if (parts.length != 3) throw const FormatException('Неверный формат QR');
    final normalized = base64Url.normalize(parts[1]);
    final payload = jsonDecode(utf8.decode(base64Url.decode(normalized))) as Map<String, dynamic>;
    final sessionId = payload['sessionId'] as String?;
    if (sessionId == null || sessionId.isEmpty) throw const FormatException('QR не содержит занятие');
    // Payload is used only for routing to the challenge endpoint. The server verifies its signature.
    return QrEnvelope(token: token, sessionId: sessionId);
  }

  final String token;
  final String sessionId;
}
