# Готовые значения для формы Astana Hub

## Product status

`MVP`

Не выбирать `Idea`, `Finished product` или `All of the above`: сейчас готов проверяемый MVP, а production-интеграция в закрытые репозитории заказчика требует доступа.

## Product launch date

`03/11/2026`

Это дата публикации рабочего HTTPS-стенда.

## Presentation (description) of the product

SAU Presence Guard - рабочий MVP антифрода для отметки посещаемости по динамическому QR и геолокации. Backend выпускает короткоживущий подписанный QR, проверяет его по времени сервера и расписанию, сравнивает координаты участника с местом проведения и свежей позицией ведущего с учётом GPS accuracy, проверяет Play Integrity / App Attest и device-сигналы, после чего возвращает accepted, suspicious или rejected с конкретными причинами. Спорные отметки попадают в ручной разбор, а исходный статус, решение и действия сохраняются в audit trail. Подготовлены OpenAPI, Flutter plugin с Android/iOS bridges, инструкция интеграции в существующий Java backend и 26 автоматических сценариев. Публичный стенд: https://sau-presence-guard.vercel.app

Загрузить файл:

`output/presentation/SAU_Presence_Guard_Mukhambet_Gazi.pptx`

## Similar implemented case

Загрузить файл:

`output/pdf/SAU_Presence_Guard_Implemented_Case.pdf`

Файл честно описывает текущий runnable MVP как реализованный кейс и не приписывает автору несуществующего стороннего заказчика.

## Estimated cost

`200 000 ₸`

В сумму входит перенос модуля в текущий Java backend и Flutter-приложение, подключение к существующим авторизации, расписанию, группам и БД, настройка release Play Integrity / App Attest и пилотная проверка.

## Implementation timeline

`10 рабочих дней после предоставления доступа к репозиториям, тестовой среде и release credentials. Проверяемый автономный MVP уже доступен.`

## Note

Автор: Мұхамбет Ғази, gazimukhambet@gmail.com. Демо: https://sau-presence-guard.vercel.app. Исходный код: https://github.com/idkdnsksk/sau-presence-guard. Решение собрано строго вокруг терминов ТЗ: ведущий, участник, занятие и место проведения. Автономный Fastify/SQLite используется только как воспроизводимый приёмочный стенд; production-модуль переносится внутрь текущего Java backend и Flutter-приложения заказчика. Реальная проверка Play Integrity / App Attest в release требует package name, bundle ID, signing и credentials заказчика. Персональные координаты запрашиваются только в момент отметки; background tracking не используется.

## Подтверждения

- Отметить `I am familiar with the 'Publication rules'`.
- Отметить `I grant the right to publish specified data on the astanahub.com portal`.

## Контакты

- Автор: `Мұхамбет Ғази`
- Email: `gazimukhambet@gmail.com`
- Демо: `https://sau-presence-guard.vercel.app`
- GitHub: `https://github.com/idkdnsksk/sau-presence-guard`
