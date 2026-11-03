import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../models.dart';
import '../secure_check_in_service.dart';

class AttendanceScanner extends StatefulWidget {
  const AttendanceScanner({super.key, required this.service, required this.onCompleted});

  final SecureCheckInService service;
  final ValueChanged<CheckInOutcome> onCompleted;

  @override
  State<AttendanceScanner> createState() => _AttendanceScannerState();
}

class _AttendanceScannerState extends State<AttendanceScanner> {
  final MobileScannerController _controller = MobileScannerController(
    formats: const <BarcodeFormat>[BarcodeFormat.qrCode],
    detectionSpeed: DetectionSpeed.noDuplicates,
  );
  bool _processing = false;
  Object? _error;

  Future<void> _detected(BarcodeCapture capture) async {
    if (_processing) return;
    final value = capture.barcodes.firstOrNull?.rawValue;
    if (value == null || value.isEmpty) return;
    setState(() { _processing = true; _error = null; });
    await _controller.stop();
    try {
      final result = await widget.service.checkIn(value);
      if (!mounted) return;
      widget.onCompleted(result);
    } catch (error) {
      if (!mounted) return;
      setState(() { _error = error; _processing = false; });
      await _controller.start();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Stack(fit: StackFit.expand, children: <Widget>[
        MobileScanner(controller: _controller, onDetect: _detected),
        Center(
          child: Container(
            width: 250,
            height: 250,
            decoration: BoxDecoration(
              border: Border.all(color: const Color(0xFFCBFF4D), width: 3),
              borderRadius: BorderRadius.circular(24),
            ),
          ),
        ),
        Positioned(
          left: 24,
          right: 24,
          bottom: 32,
          child: DecoratedBox(
            decoration: BoxDecoration(color: Colors.black.withValues(alpha: .72), borderRadius: BorderRadius.circular(16)),
            child: Padding(
              padding: const EdgeInsets.all(15),
              child: _processing
                  ? const Row(mainAxisAlignment: MainAxisAlignment.center, children: <Widget>[
                      SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
                      SizedBox(width: 10), Text('Проверяем QR, место и устройство…', style: TextStyle(color: Colors.white)),
                    ])
                  : Text(_error == null ? 'Наведите камеру на QR ведущего' : 'Ошибка: $_error', textAlign: TextAlign.center, style: const TextStyle(color: Colors.white)),
            ),
          ),
        ),
      ]);
}
