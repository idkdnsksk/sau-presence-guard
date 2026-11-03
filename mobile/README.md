# sau_presence_guard Flutter plugin

Встраиваемый поток защищённой отметки посещаемости для существующего Flutter-приложения.

## Компоненты

- `HostQrPanel` — foreground GPS ведущего, серверный QR и автоматическое обновление;
- `AttendanceScanner` — QR scanner, блокировка повторного чтения и вызов одного check-in flow;
- `SecureCheckInService` — foreground location, device evidence, challenge, attestation и check-in;
- `PresenceGuardApi` — небольшой REST adapter на текущий bearer token;
- Android bridge — Standard Play Integrity, emulator/root signals;
- iOS bridge — App Attest registration/assertion, simulator/jailbreak signals.

## Подключение

```yaml
dependencies:
  sau_presence_guard:
    path: packages/sau_presence_guard
```

Plugin использует Flutter v2 embedding и регистрируется автоматически. Менять `MainActivity` или `AppDelegate` не нужно.

Полная release-настройка, permissions и примеры — в `../docs/INTEGRATION.md`.

## Важные свойства

- payload QR разбирается на клиенте только чтобы узнать `sessionId`; подпись и claims доверенно проверяет только backend;
- installation ID — SHA-256 случайного секрета из secure storage, а не аппаратный ID;
- GPS запрашивается только во время явного действия, streams/background tracking отсутствуют;
- canonical payload связывает challenge, полный QR, координату и installation hash с Play Integrity/App Attest assertion;
- demo attestation в plugin отсутствует.

## Проверка в репозитории заказчика

```text
flutter pub get
flutter analyze
flutter test
```

Затем проверить release builds через Google Play internal testing и TestFlight на физических устройствах. Реальные platform verdict зависят от package/bundle, signing и console credentials заказчика.
