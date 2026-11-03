import 'dart:async';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../api_client.dart';
import '../models.dart';

class HostQrPanel extends StatefulWidget {
  const HostQrPanel({super.key, required this.api, required this.sessionId, this.title = 'QR занятия'});

  final PresenceGuardApi api;
  final String sessionId;
  final String title;

  @override
  State<HostQrPanel> createState() => _HostQrPanelState();
}

class _HostQrPanelState extends State<HostQrPanel> with WidgetsBindingObserver {
  Timer? _timer;
  String? _token;
  DateTime? _refreshAt;
  DateTime? _expiresAt;
  Object? _error;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _timer = Timer.periodic(const Duration(milliseconds: 250), (_) => _tick());
    unawaited(_refresh());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_refresh());
  }

  void _tick() {
    if (!mounted) return;
    if (_refreshAt != null && DateTime.now().toUtc().isAfter(_refreshAt!)) unawaited(_refresh());
    setState(() {});
  }

  Future<void> _refresh() async {
    if (_loading) return;
    _loading = true;
    try {
      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.best, timeLimit: Duration(seconds: 12)),
      );
      final result = await widget.api.issueHostQr(
        widget.sessionId,
        LocationEvidence(
          latitude: position.latitude,
          longitude: position.longitude,
          accuracyM: position.accuracy,
          recordedAt: position.timestamp.toUtc(),
          isMocked: position.isMocked,
        ),
      );
      if (!mounted) return;
      setState(() {
        _token = result['token'] as String;
        _refreshAt = DateTime.parse(result['refreshAt'] as String);
        _expiresAt = DateTime.parse(result['expiresAt'] as String);
        _error = null;
      });
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      _loading = false;
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now().toUtc();
    final seconds = _refreshAt == null ? 0 : (_refreshAt!.difference(now).inMilliseconds / 1000).clamp(0, 99).ceil();
    final expired = _expiresAt != null && now.isAfter(_expiresAt!);
    return Semantics(
      label: 'Динамический QR занятия',
      child: Card(
        clipBehavior: Clip.antiAlias,
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: <Widget>[
            Text(widget.title, style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 6),
            const Text('Код подписан сервером и обновляется автоматически.'),
            const SizedBox(height: 22),
            if (_token != null && !expired)
              DecoratedBox(
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(20)),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: QrImageView(data: _token!, version: QrVersions.auto, size: 250, eyeStyle: const QrEyeStyle(eyeShape: QrEyeShape.square)),
                ),
              )
            else if (_error != null)
              Padding(padding: const EdgeInsets.all(32), child: Text('QR недоступен: $_error', textAlign: TextAlign.center))
            else
              const Padding(padding: EdgeInsets.all(70), child: CircularProgressIndicator()),
            const SizedBox(height: 14),
            Text('Обновление через $seconds сек', style: Theme.of(context).textTheme.labelLarge),
          ]),
        ),
      ),
    );
  }
}
