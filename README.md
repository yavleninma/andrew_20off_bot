# Telegram Signal Assistant MVP

Быстрый бот-сигнальщик для ручного повторения сделок.

## Что делает

- Получает сделки из источника (`simulated` для теста, `tinkoff` как адаптер).
- `sandbox` режим для гарантированных тестовых сигналов.
- Шлет сигнал в Telegram.
- Кнопки `Повторил` / `Игнор`.
- При `Повторил` принимает `/fill <signalId> <price> <qty>`.
- Также поддерживает `/fillsum <signalId> <price> <amountRub>` (ввод суммы в рублях).
- Команда `/testsignal` отправляет тестовый сигнал вручную.
- Считает `commissionSaved`, `slippageCost`, `netEffect`.

## Быстрый старт

1. Установи зависимости:
   - `npm install`
2. Создай `.env` на основе `.env.example`.
3. Запусти:
   - `npm run dev`
4. Напиши боту `/start`.
5. Введи пароль:
   - `/auth <BOT_ACCESS_PASSWORD>`
6. Для мгновенной проверки:
   - `/testsignal`

## Минимум, что нужно от друга

- Личный Telegram (чат с ботом).
- Пароль доступа (`BOT_ACCESS_PASSWORD`), который ты ему скажешь.
- Если используете реальный источник, токен доступа к Tinkoff API.

## Зачем был нужен TELEGRAM_CHAT_ID раньше

Сейчас он не обязателен: бот сам авторизует чат по `/auth`.
`ALLOWED_CHAT_IDS` оставлен как опциональный способ белого списка.

## Smoke-тест за 2 минуты

- В `.env` поставить `SOURCE_MODE=simulated`.
- Для стабильной проверки лучше `SOURCE_MODE=sandbox`.
- Запустить `npm run dev`.
- Написать `/auth <пароль>`.
- Дождаться сигнала в Telegram.
- Нажать `Повторил`, затем отправить:
  - `/fill <signalId> 123.45 10`
- Или вводом суммы:
  - `/fillsum <signalId> 123.45 10000`
- Убедиться, что бот подтвердил запись действия.

## Примечание по Tinkoff

В `src/sources/tinkoff-placeholder.ts` уже подключен боевой poller через `tinkoff-invest-api`:
- автоопределение `accountId` (или задай `TINKOFF_ACCOUNT_ID`),
- чтение новых buy/sell операций через `getOperationsByCursor`,
- маппинг FIGI -> ticker.

### Как включить реальные сделки

1. В `.env` поставь:
   - `SOURCE_MODE=tinkoff`
   - `TINKOFF_TOKEN=<токен друга>`
   - (опционально) `TINKOFF_ACCOUNT_ID=<id-счета>`
2. Перезапусти:
   - `npm run dev`
3. В логах будет:
   - masked token
   - источник токена (`.env -> TINKOFF_TOKEN`)
   - выбранный/заданный accountId

## Tinkoff API: куда идти

- Портал разработчика: [https://developer.tbank.ru/invest/](https://developer.tbank.ru/invest/)
- Кабинет/приложения: [https://developer.tbank.ru/](https://developer.tbank.ru/)
- Документация Invest API: [https://developer.tbank.ru/invest/services/](https://developer.tbank.ru/invest/services/)
- Песочница T-Bank: [https://developer.tbank.ru/docs/intro/other/sandbox](https://developer.tbank.ru/docs/intro/other/sandbox)

## Инструкция для друга (очень коротко)

1. Открой настройки инвестиций: [https://www.tbank.ru/invest/settings/](https://www.tbank.ru/invest/settings/)
2. Выпусти токен T-Invest API (лучше read-only для старта).
3. Скопируй токен сразу (повторно он обычно не показывается).
4. Пришли тебе токен и `accountId` (если знает), либо только токен.
5. Ты вставляешь токен в `.env` -> `TINKOFF_TOKEN`.

Справка:
- Токены и типы доступа: [https://developer.tbank.ru/invest/intro/intro/token](https://developer.tbank.ru/invest/intro/intro/token)
- Начало работы: [https://developer.tbank.ru/invest/intro/intro/](https://developer.tbank.ru/invest/intro/intro/)
