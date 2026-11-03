# План проверки

## Автоматическая проверка

```powershell
npm ci
npm run check
npm audit --omit=dev
```

Ожидается: strict TypeScript без ошибок, 26/26 тестов, production build и 0 известных production-уязвимостей npm.

Покрытые сценарии:

- валидный QR → accepted;
- повтор → та же attendance, `idempotent=true`;
- QR старше TTL → rejected и запись попытки;
- изменение одного символа подписи → `QR_SIGNATURE_INVALID`;
- mock location участника → rejected;
- mock location ведущего → QR не выдаётся;
- ведущий далеко от места → QR не выдаётся;
- emulator → rejected;
- root и jailbreak → suspicious;
- слабая GPS accuracy → suspicious, не false reject;
- немного за радиусом → suspicious;
- явно далеко от места и ведущего → rejected;
- устаревшая координата → rejected;
- QR вне окна расписания не выдаётся;
- участник не из группы не получает challenge;
- одна установка у разных групп → suspicious;
- невозможный скачок между городами → suspicious;
- ведущий разбирает suspicious, original status сохраняется;
- параметры места изменяются и аудируются;
- участник не видит административную очередь.

## Ручная демонстрация за 5 минут

1. `Copy-Item .env.example .env`, затем `npm ci` и `npm run dev`.
2. Открыть `http://localhost:8080`.
3. В «QR ведущего» показать реальный QR и дождаться его автоматической смены.
4. В «Отметиться» выполнить «Все проверки пройдены» — получить accepted.
5. Выполнить «Слабый GPS» — получить suspicious, открыть «Проверка», подтвердить с комментарием.
6. Выполнить mock, удалённую точку и emulator — получить rejected с разными причинами.
7. В «Правила» изменить интервал/радиус/окно; сохранить.
8. В «Журнал» показать выдачу QR, решения, review и изменение правил.
9. Открыть `/openapi.json` и `docs/TZ_COMPLIANCE.md`.

Каждый demo-участник отдельный, поэтому сценарии не конфликтуют с правилом «одна отметка на занятие».

## Проверка реальных устройств перед production

### Android

- release build установлен через Google Play internal testing;
- physical clean device → valid Play Integrity и accepted;
- emulator → rejected;
- tampered/unrecognized build → integrity failure;
- включённый mock provider → rejected;
- отключённая геолокация/permission → понятная ошибка без check-in;
- повтор после accepted → та же attendance;
- screenshot через 16+ секунд → expired;
- плохой indoor GPS → suspicious, не rejected.

### iOS

- production/TestFlight build на physical device;
- первая попытка регистрирует App Attest key, следующая использует assertion;
- повтор assertion/sign count → rejected;
- simulator → rejected/unsupported;
- key reset/reinstall обрабатывается повторной регистрацией;
- foreground-only permission и отсутствие background indicator.

## Нагрузочная и эксплуатационная проверка

- целевая одновременная выдача QR и check-in на реальных пиках заказчика;
- два параллельных check-in одного участника → одна attendance;
- два параллельных review → только одно изменение;
- несколько backend instances с общей БД;
- ротация QR key ID без массового отказа;
- временная недоступность Google API не маркируется как fraud и видна в мониторинге;
- backup/restore сохраняет App Attest counters и review history.

## Приёмочные артефакты

- вывод `npm run check`;
- вывод `npm audit --omit=dev`;
- скриншоты пяти разделов демо;
- OpenAPI и матрица ТЗ;
- результаты Android internal testing и iOS TestFlight — после передачи signing credentials заказчиком.
