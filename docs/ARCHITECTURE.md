# Архитектура решения

## Главный принцип

Телефон не решает, засчитывать посещение или нет. Он получает QR, координату и device attestation, а backend сверяет все сигналы в одной транзакционно согласованной модели. Поэтому изменение Flutter-клиента или системного времени телефона не обходит правила.

```text
Ведущий                         Участник                         Backend-модуль
   │ foreground GPS               │                                  │
   ├──── issue QR ───────────────────────────────────────────────────►│
   │                              │          schedule + host geo      │
   │◄── signed QR, TTL, refresh ─────────────────────────────────────┤
   │                              │                                  │
   │        QR на экране          │                                  │
   │◄─────────────────────────────┤ scan                             │
   │                              ├──── one-use challenge ──────────►│
   │                              │◄── challenge + expiry ───────────┤
   │                              ├──── GPS + device + attestation ─►│
   │                              │     QR bound into request hash   │
   │                              │                                  ├─ signature / TTL / issue log
   │                              │                                  ├─ server schedule
   │                              │                                  ├─ venue + host distance + accuracy
   │                              │                                  ├─ Play Integrity / App Attest
   │                              │                                  ├─ device/location history
   │                              │◄── status + reason codes ────────┤
```

## Слои

- `backend/src/security/qr.ts` — формат и проверка динамического QR.
- `backend/src/security/attestation.ts` — одноразовые challenge, Google Play Integrity и Apple App Attest.
- `backend/src/domain/geo.ts` — Haversine и учёт accuracy.
- `backend/src/domain/risk-engine.ts` — детерминированные правила и причины.
- `backend/src/app.ts` — REST, role checks, идемпотентность и транзакции.
- `backend/src/db.ts` — автономная SQLite-модель стенда; встраивается через текущие repositories заказчика.
- `mobile/` — Flutter API client, widgets и автоматически регистрируемые native bridges.
- `backend/src/public/` — проверочный кабинет, а не обязательный production frontend.

## Данные

- `qr_issues`: факт серверной выдачи, TTL и позиция ведущего.
- `integrity_challenges`: короткоживущие одноразовые nonce, связанные с участником, занятием, установкой и платформой.
- `app_attest_keys`: публичный ключ и монотонный sign count.
- `attendance_attempts`: каждая попытка, включая отклонённые.
- `attendances`: единственная итоговая отметка участника на занятие.
- `review_history`: неизменяемая последовательность ручных решений.
- `audit_log`: выдача QR, расчёт статуса, review и изменение настроек.

## Почему два геосравнения

Одна координата места не доказывает, что ведущий действительно находится там сейчас. Поэтому QR выдаётся только со свежей позицией ведущего, а участник сравнивается и с настроенным местом, и с этой позицией. GPS accuracy вычитается из измеренной дистанции, чтобы плохой сигнал в помещении не создавал ложный жёсткий отказ.

## Статусы

- `accepted`: все обязательные проверки прошли, предупреждений нет.
- `suspicious`: отметка сохранена, но есть слабая accuracy, root/jailbreak, мягкое превышение геозоны, общий device или скачок; нужна проверка.
- `rejected`: подпись/TTL/integrity не прошли, mock/emulator обнаружен, координаты явно далеки, время/данные устарели или занятие вне окна. Попытка остаётся в аудите, но attendance не создаётся.

## Масштабирование и перенос

SQLite выбран только для запуска одним `npm run dev`. В production таблицы переносятся в текущую БД, а уникальность `(session_id, participant_id)` и optimistic update `sign_count` сохраняются. QR и risk engine stateless; challenge, issue log и история требуют общего transaction store. При нескольких инстансах не нужен sticky session.

## Отказоустойчивость

- Решения принимаются fail-closed: непроверенная attestation не превращается в accepted.
- Сетевой сбой Google возвращает явную временную ошибку, а не ложный fraud verdict.
- Challenge одноразовый и живёт 90 секунд.
- QR secret поддерживает key ID для контролируемой ротации; при переносе можно принимать предыдущий key на короткое переходное окно.
- Review обновляет только `suspicious`, поэтому два проверяющих не перетирают решения.
