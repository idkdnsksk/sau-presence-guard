# Контекст заказчика и принятые решения

## Что подтверждено источниками

- Заказчик задачи — ТОО `SAU APP`, а сама задача просит встроить защиту посещаемости в существующие backend и Flutter-приложение: [Astana Hub](https://astanahub.com/en/tech_task/antifrod-dlia-otmetki-poseshchaemosti-dinamicheskii-qr-i-proverka-geolokatsii).
- Публичное интервью CTO описывает SAU Super App, короткие MVP-циклы, Flutter-клиент и преимущественно Java backend: [Digital Business, 10 октября 2025](https://digitalbusiness.kz/2025-10-10/v-startapah-cto-prevrashchaetsya-v-product-owner-cto-sau-super-app-o-rabote-na-nebolshih-proektah-i-tehnicheskoy-kulture/).
- Публичное iOS-приложение связано с `SAU APP & Jump Kazakhstan`: [Jump SuperApp в App Store](https://apps.apple.com/kz/app/jump-superapp/id6742018399).

Снимок публичной информации сделан 3 ноября 2026 года. Эти сведения использованы только для совместимости интеграции. Они не подменяют ТЗ.

## Что это изменило в проекте

- Flutter оформлен как plugin, который добавляется в существующее приложение без замены `MainActivity`/`AppDelegate`.
- Backend разбит на переносимые security/domain-модули и REST-контракт. Fastify/SQLite — runnable reference; при доступе к репозиторию эти модули переносятся внутрь Java backend без отдельного production-сервиса.
- UI и данные намеренно нейтральны: ведущий, участник, занятие, место проведения. Спортивные роли, названия площадок и тренеры не предполагаются.
- API выдаёт стабильные reason codes, чтобы существующий клиент мог локализовать тексты и собирать аналитику.
- MVP запускается одной командой и показывает все приёмочные сценарии без реальных signing credentials.

## Чего проект не предполагает

- Нет предположения, что ведущий — тренер.
- Нет привязки к баскетболу, конкретной арене или конкретному филиалу.
- Нет требования менять текущую авторизацию, расписание или административную систему заказчика.
- Нет внешнего картографического сервиса и фонового трекинга.
