# Встраивание в существующий backend и Flutter

ТЗ требует не отдельный production-сервис, а код внутри текущего решения. Автономный Node/SQLite backend в этом архиве — исполняемая спецификация и приёмочный стенд. Ниже — границы переноса в репозиторий SAU APP.

## 1. Контракт с текущими сущностями

Сопоставить без дублирования:

| Модуль | Существующая сущность заказчика |
|---|---|
| `users.id`, role | Текущий аккаунт и RBAC/JWT |
| `sessions` | Текущее занятие/событие и расписание |
| `group_id` | Текущая связь участника с группой занятия |
| `venues` | Текущее место/филиал + новые anti-fraud настройки |
| `attendances` | Текущая запись посещаемости |

Добавить таблицы/колонки из `backend/src/db.ts`: `qr_issues`, `integrity_challenges`, `app_attest_keys`, `attendance_attempts`, `review_history`, `audit_log`, `original_status`, reason JSON и risk score. Уникальный индекс `(session_id, participant_id)` обязателен на уровне БД.

## 2. Перенос в Java backend

Публичное интервью указывает Java как основной backend-стек, поэтому рекомендуемый перенос такой:

1. `security/qr.ts` → Spring service с `Mac.getInstance("HmacSHA256")`, `SecureRandom` и constant-time `MessageDigest.isEqual`.
2. `domain/geo.ts` и `risk-engine.ts` → чистые Java services без HTTP/DB side effects.
3. SQL из `db.ts` → Flyway/Liquibase migration и текущие JPA/jOOQ repositories.
4. Route handlers из `app.ts` → текущие controllers; principal берётся из существующей security context, не из demo-token.
5. `AttestationService` → Google API client и App Attest verifier внутри текущего backend. Проверять package/bundle, timestamp, request hash, app recognition, device integrity, App Attest counter.
6. Все записи попытки/attendance/audit выполнять в одной `@Transactional` операции. Конфликт уникального индекса трактовать как идемпотентный повтор.

Порядок проверок и reason codes сохраняются. Это позволяет сначала прогнать одинаковые contract tests на reference backend и Java-реализации, затем переключить Flutter base URL без изменения UX.

## 3. Flutter plugin

Добавить локальную зависимость в существующий `pubspec.yaml`:

```yaml
dependencies:
  sau_presence_guard:
    path: packages/sau_presence_guard
```

Создать API-клиент на текущей авторизации:

```dart
final api = PresenceGuardApi(
  baseUrl: Uri.parse(environment.apiBaseUrl),
  authToken: () => authRepository.accessToken(),
);

final checkIn = SecureCheckInService(api: api);
```

Экран ведущего:

```dart
HostQrPanel(api: api, sessionId: session.id)
```

Экран участника:

```dart
AttendanceScanner(
  service: checkIn,
  onCompleted: (outcome) => context.go('/attendance/result', extra: outcome),
)
```

`CheckInOutcome.status` имеет только `accepted`, `suspicious`, `rejected`; `reasons` содержит стабильный code и готовый текст. В production UI лучше локализовать по code.

## 4. Android release

Следовать официальному потоку [Standard Play Integrity requests](https://developer.android.com/google/play/integrity/standard).

В манифесте host app указать Google Cloud project number:

```xml
<application>
  <meta-data
    android:name="kz.sau.presence_guard.CLOUD_PROJECT_NUMBER"
    android:value="123456789012" />
</application>
```

Backend environment:

```text
GOOGLE_PLAY_PACKAGE_NAME=<фактический applicationId>
GOOGLE_APPLICATION_CREDENTIALS=<путь к service-account JSON>
```

Необходимы Play Console linking, release build из Google Play и API access для service account. Debug/emulator не является доказательством production-integrity.

Plugin использует Standard API: provider готовится один раз, а каждый check-in получает новый token с `requestHash = SHA256(canonical payload)`. Backend сверяет hash, package name, свежесть, `PLAY_RECOGNIZED`, `MEETS_DEVICE_INTEGRITY` и licensing verdict.

## 5. iOS release

Следовать официальному процессу [Establishing your app’s integrity](https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity).

1. Включить App Attest capability для bundle ID и target.
2. Проверить entitlement:

```xml
<key>com.apple.developer.devicecheck.appattest-environment</key>
<string>production</string>
```

3. Настроить backend:

```text
APPLE_TEAM_ID=<Apple Team ID>
APPLE_BUNDLE_ID=<фактический bundle id>
APPLE_ALLOW_DEVELOPMENT=false
```

Первый check-in регистрирует App Attest key через одноразовый challenge; следующие запросы подписывают canonical payload. Backend хранит public key и атомарно увеличивает sign count, поэтому replay assertion отклоняется.

## 6. Геолокация и разрешения

Android нужны `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` и camera permission, которую добавляет scanner package. iOS `Info.plist`:

```xml
<key>NSCameraUsageDescription</key>
<string>Камера нужна для сканирования QR занятия.</string>
<key>NSLocationWhenInUseUsageDescription</key>
<string>Геолокация проверяется только во время отметки посещаемости.</string>
```

Не добавлять background location. Не запускать position stream. Перед запросом разрешения показать короткий экран цели и срока хранения данных.

## 7. Production environment

Минимум:

```text
NODE_ENV=production
DEMO_MODE=false
ALLOW_DEMO_ATTESTATION=false
AUTH_SECRET=<отдельный secret 32+ chars, только для reference auth>
QR_SIGNING_SECRET=<случайный secret из secret manager>
QR_SIGNING_KEY_ID=v1
ALLOWED_ORIGINS=https://<admin-origin>
```

В Java backend `AUTH_SECRET` reference-стенда не переносится: используется текущая авторизация. QR signing secret хранится в KMS/secret manager, имеет владельца и план ротации.

## 8. Порядок безопасного rollout

1. Перенести schema и domain services, прогнать contract tests.
2. Добавить Flutter plugin за feature flag.
3. Внутренний pilot: verdict считать, но не блокировать; сравнить false positives по accuracy/device.
4. Включить `suspicious` и очередь ручной проверки.
5. Включить hard reject для подписи/TTL/mock/emulator/integrity failure.
6. Настроить алерты на рост `PLAY_INTEGRITY_UNAVAILABLE`, reject rate и очередь без решения.

## 9. Что требуется от заказчика для финального merge

- доступ к backend и Flutter repositories;
- реальные entity/DB schema и auth principal;
- package name, bundle ID, Team ID и signing setup;
- Google Cloud/Play Integrity credentials;
- production policy: retention, роли доступа, допустимые радиусы и окно;
- тестовые аккаунты ведущего, участника и администратора.
