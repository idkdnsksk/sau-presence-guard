# Соответствие техническому заданию

Источник требований: [страница задачи Astana Hub](https://astanahub.com/en/tech_task/antifrod-dlia-otmetki-poseshchaemosti-dinamicheskii-qr-i-proverka-geolokatsii) и [официальный PDF](https://cdn.astanahub.com/media/%D0%A2%D0%97_%D0%B0%D0%BD%D1%82%D0%B8%D1%84%D1%80%D0%BE%D0%B4_%D0%BF%D0%BE%D1%81%D0%B5%D1%89%D0%B0%D0%B5%D0%BC%D0%BE%D1%81%D1%82%D1%8C.pdf). Снимок требований сделан 3 ноября 2026 года.

В таблице нет выдуманных ролей или сценариев. Используются термины ТЗ: ведущий, участник, занятие и место проведения (в PDF также используется слово «площадка»).

| Требование ТЗ | Реализация | Как проверить |
|---|---|---|
| QR создаётся на сервере, содержит занятие и время, не подделывается | Компактный подписанный HMAC-SHA-256 token содержит `sessionId`, `hostId`, `tokenId`, `issuedAt`, `expiresAt`, версию и key ID. Подпись сравнивается constant-time. Каждый выданный token ID фиксируется в БД. | `backend/src/security/qr.ts`; тесты `signed dynamic QR`; экран «QR ведущего». |
| QR меняется каждые N секунд, интервал настраивается; старый скриншот не проходит | Для места отдельно задаются `qr_interval_s` и `qr_ttl_s`. Демо: обновление 10 с, TTL 15 с. Проверка срока идёт по времени сервера, а не телефона. | Счётчик на экране ведущего; тест `rejects a screenshot after 15 seconds`; раздел «Правила». |
| Отметка только в окне расписания | Сервер вычисляет окно `starts_at - before` … `ends_at + after`. Вне окна не выдаётся QR, а check-in отклоняется повторно на сервере. | Тест `does not issue QR outside the server-side schedule window`; поля окна в настройках. |
| Одна отметка участника на занятие, повтор идемпотентен | Уникальность `(session_id, participant_id)` обеспечивается индексом БД. `INSERT OR IGNORE` и повторное чтение возвращают исходную запись с `idempotent=true`. | Тест `keeps one immutable attendance for repeated scans`. |
| Координаты и радиус места; сравнение участника с местом и телефоном ведущего | При выдаче QR сохраняется свежая foreground-позиция ведущего. При check-in считаются две Haversine-дистанции: участник→место и участник→ведущий. | `backend/src/domain/geo.ts`, `risk-engine.ts`; сценарий «Вне места проведения»; тест `rejects a participant far from both venue and host`. |
| Учитывать точность GPS; слабый сигнал в помещении — подозрительно, не автоматический отказ | Для границы используется консервативная дистанция `max(0, measured - accuracy)`. Превышение порога accuracy добавляет `LOW_GPS_ACCURACY` и статус `suspicious`, но не `rejected`. | Сценарий «Слабый GPS в помещении»; тест `sends weak indoor GPS to review instead of falsely rejecting it`. |
| Mock location, root/jailbreak, эмулятор; Play Integrity и App Attest | Flutter plugin собирает системные сигналы; Android вызывает Standard Play Integrity с request hash; iOS создаёт App Attest key, attestation и assertions со счётчиком. Backend проверяет verdict, приложение, freshness, payload binding и replay. Demo attestation запрещена в production. | `mobile/android`, `mobile/ios`, `backend/src/security/attestation.ts`; сценарии mock/emulator/root; production-настройка в `INTEGRATION.md`. |
| Результат `accepted` / `suspicious` / `rejected` с причинами | Risk engine возвращает статус, стабильные machine codes, русские заголовки, описание, evidence и risk score. Отклонённые попытки также остаются в журнале. | Экран результата участника; `attendance_attempts`; тесты всех трёх веток. |
| Правила: общий device у несвязанных участников, дальние координаты, невозможный скачок | Псевдонимный hash установки сопоставляется между группами за 24 ч; анализируется двойная дистанция; скорость между недавними попытками выявляет физически невозможный скачок. | Тесты `flags one installation shared across unrelated groups` и `flags an impossible jump between two valid venues`; `risk-engine.ts`. |
| Подозрительные отметки видны ведущему/администратору; подтвердить/отклонить; история не затирается | Ролевая очередь ограничивает ведущего его занятиями. Review меняет текущий статус, но сохраняет `original_status` и добавляет строку в append-only `review_history` плюс audit event. | Экран «Проверка»; тест `lets a host review ... and preserves append-only history`. |
| Интервал, радиус и окно настраиваются отдельно для каждого места | API и UI редактируют participant radius, host radius, QR interval, QR TTL, before/after window и GPS accuracy threshold на конкретном месте. Все изменения аудируются. | Экран «Правила»; тест `updates per-venue QR, radius and check-in settings with an audit event`. |

## Сквозные требования

| Требование | Реализация |
|---|---|
| Все решения на сервере | Клиент передаёт только входные сигналы. Подпись QR, расписание, геозоны, integrity verdict, история и итоговый статус вычисляются backend-модулем. |
| Flutter-экраны | `HostQrPanel` автоматически обновляет QR; `AttendanceScanner` сканирует и запускает один foreground check-in; итог возвращается как `CheckInOutcome`. |
| Административный интерфейс | В runnable demo есть обзор, очередь, правила места и аудит. Backend endpoints готовы для подключения к существующей админке. |
| Геолокация только при отметке | В Flutter нет stream/background permission. `getCurrentPosition` вызывается только при выдаче QR ведущим и при скане участником. |
| Минимизация персональных данных | Device ID не передаётся: хранится SHA-256 случайного installation secret. Нет фонового трекинга и внешней карты. Retention и размещение описаны в `SECURITY_AND_PRIVACY.md`. |
| Автотесты | Скриншот/TTL, подмена подписи, mock GPS, эмулятор, root, слабая точность, удалённая точка, общий device, скачок, идемпотентность, расписание, review history и role isolation. |
| Краткая документация | Этот файл, `ARCHITECTURE.md`, `INTEGRATION.md`, `SECURITY_AND_PRIVACY.md`, `TEST_PLAN.md` и OpenAPI-контракт. |
| Встраивание вместо отдельного сервиса | Доменный код не зависит от сетевого вызова между сервисами. `qr`, `geo`, `risk-engine` и persistence mapping переносятся внутрь текущего backend-монолита; Flutter plugin добавляется в текущее приложение. Автономный Fastify/SQLite нужен только для воспроизводимой проверки без доступа к закрытому репозиторию заказчика. |

## Честная граница решения

Нельзя гарантированно отличить live-трансляцию QR человеку, который физически находится в той же разрешённой геозоне и использует настоящее доверенное устройство. ТЗ существенно снижает этот риск коротким TTL, координатами ведущего, Play Integrity/App Attest и историческими сигналами. Для ещё более строгого режима можно добавить server-push challenge, Bluetooth proximity или ручное подтверждение ведущим, но это уже расширение ТЗ и отдельный UX-компромисс.
