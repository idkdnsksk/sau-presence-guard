# SAU Presence Guard — решение по ТЗ Astana Hub

Начните с `README.md`, затем откройте `docs/TZ_COMPLIANCE.md` — там каждый пункт официального ТЗ связан с кодом и проверкой.

Быстрая проверка:

```powershell
npm ci
npm run check
npm run dev
```

Откройте `http://localhost:8080`.

Публичный стенд: `https://sau-presence-guard.vercel.app`.

Репозиторий: `https://github.com/idkdnsksk/sau-presence-guard`.

Структура:

- `backend/` — runnable reference backend и 26 автотестов;
- `mobile/` — Flutter plugin + Android Play Integrity + iOS App Attest;
- `docs/` — соответствие ТЗ, архитектура, интеграция, безопасность, тест-план и OpenAPI;
- `output/` — готовая презентация PPTX и PDF реализованного кейса для формы;
- `docs/SUBMISSION_RU.md` — готовый текст заявки.

Production-граница: Fastify/SQLite даёт воспроизводимый стенд без доступа к закрытому коду заказчика. По ТЗ доменные модули переносятся внутрь существующего backend, а Flutter plugin — внутрь существующего приложения. Demo-auth/attestation запрещены в product-режиме; публичный стенд работает в отдельном `public-demo` с БД в памяти.
