# Telegram Signal Assistant (MVP)

MVP-бот для Telegram, который получает сделки из источника, отправляет сигналы в чат и считает базовую аналитику по действиям пользователя.

## Что уже реализовано

- Источники сигналов:
  - `sandbox` (стабильные синтетические сделки для теста),
  - `simulated` (случайная/постоянная генерация),
  - `tinkoff` (чтение реальных сделок через T-Invest API).
- Telegram-бот на `telegraf`:
  - авторизация в чате по паролю (`/auth <password>`),
  - кнопки `Повторил` и `Игнор`,
  - ручная фиксация повтора через `/fill` и `/fillsum`,
  - `/testsignal` для ручного тестового сигнала.
- Локальная база `SQLite` (`better-sqlite3`) с сохранением:
  - сигналов,
  - действий пользователя,
  - рассчитанных метрик.
- Аналитика:
  - `commissionSaved`,
  - `slippageCost`,
  - `netEffect`,
  - ежедневный digest по cron.

## Быстрый старт (самый простой путь через Docker)

### 1) Что нужно установить

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

### 2) Подготовка

```bash
cp .env.example .env
```

Обязательно заполнить в `.env`:

- `TELEGRAM_BOT_TOKEN`
- `BOT_ACCESS_PASSWORD`

Для первого запуска рекомендуется:

- `SOURCE_MODE=sandbox`

### 3) Запуск в dev (с логами в консоли)

```bash
npm run docker:dev
```

### 4) Запуск в prod (фоново)

```bash
npm run docker:prod
```

Если нужно запустить конкретный образ:

```bash
BOT_IMAGE=ghcr.io/<owner>/andrew_20off_bot:<tag> npm run docker:prod
```

### 5) Остановка

```bash
npm run docker:down
```

### 6) Логи

```bash
npm run docker:logs
```

Логи пишутся в JSON-формате в stdout/stderr.

## Первый запуск бота (для человека без разработки)

1. Открой Telegram и найди своего бота.
2. Отправь `/start`.
3. Введи пароль:
   - `/auth <BOT_ACCESS_PASSWORD>`
4. Для проверки отправь:
   - `/testsignal`
5. На сигнале нажми `Повторил` или `Игнор`.

## Команды бота

- `/start` - старт и подсказки
- `/auth <password>` - авторизация чата
- `/help` - краткая инструкция
- `/testsignal` - тестовый сигнал
- `/fill <signalId> <price> <qty>` - подтвердить повтор с количеством
- `/fillsum <signalId> <price> <amountRub>` - подтвердить повтор с суммой в рублях

## Режимы источника сигналов

В `.env`:

- `SOURCE_MODE=sandbox` - лучший режим для smoke-теста
- `SOURCE_MODE=simulated` - псевдослучайные сигналы
- `SOURCE_MODE=tinkoff` - реальные сделки из T-Bank Invest API

## Как включить реальные сделки (Tinkoff/T-Bank)

1. В `.env`:
   - `SOURCE_MODE=tinkoff`
   - `TINKOFF_TOKEN=<ваш токен>`
   - опционально: `TINKOFF_ACCOUNT_ID=<id счета>`
2. Перезапусти контейнер:
   - `npm run docker:prod`
3. Проверь логи:
   - загрузился токен (в маске),
   - выбран `accountId`.

Ссылки:

- [T-Bank Invest API](https://developer.tbank.ru/invest/)
- [Документация сервисов](https://developer.tbank.ru/invest/services/)
- [Sandbox](https://developer.tbank.ru/docs/intro/other/sandbox)

## Локальный запуск без Docker

```bash
npm install
cp .env.example .env
npm run dev
```

Продакшен-сборка:

```bash
npm run build
npm run start
```

## Переменные окружения (.env)

Минимально обязательные:

- `TELEGRAM_BOT_TOKEN` - токен Telegram-бота
- `BOT_ACCESS_PASSWORD` - пароль для `/auth`

Основные:

- `SOURCE_MODE` - `sandbox | simulated | tinkoff`
- `SIMULATED_EMIT_MODE` - `random | always`
- `DB_PATH` - путь к SQLite (по умолчанию `./data/app.db`)
- `POLL_SECONDS` - интервал опроса источника
- `DAILY_DIGEST_CRON` - cron ежедневной сводки
- `MAIN_ACCOUNT_VALUE` - размер основного портфеля
- `MIRROR_ACCOUNT_VALUE` - размер зеркального портфеля
- `COMMISSION_RATE` - ставка комиссии для расчета эффекта
- `LOG_LEVEL` - уровень логирования (`debug | info | warn | error`)
- `BOT_IMAGE` - опционально, image для `docker compose` в prod

Для Tinkoff:

- `TINKOFF_TOKEN`
- `TINKOFF_ACCOUNT_ID` (опционально)
- `TINKOFF_LOOKBACK_MINUTES`
- `TINKOFF_SKIP_HISTORY_ON_START`

## Где хранятся данные

- База: `./data/app.db`
- Папка `./data` примонтирована в контейнер, поэтому данные не теряются при перезапуске.

## CI/CD (GitHub Actions -> GHCR -> Selectel)

Триггеры деплоя:

- `push` в `main`
- `push` в `master`

Что делает пайплайн:

1. Запускает CI (`npm ci`, `npm run typecheck`, `npm run build`, `npm run smoke`).
2. Собирает Docker image и пушит в GHCR.
3. Подключается по SSH к Selectel.
4. Выполняет `docker compose pull` + `docker compose up -d` с новым `BOT_IMAGE`.

Нужные GitHub Secrets:

- `SELECTEL_HOST`
- `SELECTEL_USER`
- `SELECTEL_SSH_KEY`
- `SELECTEL_PORT` (опционально, по умолчанию `22`)
- `SELECTEL_APP_PATH` (например `/opt/andrew_20off_bot`)
- `GHCR_USERNAME`
- `GHCR_TOKEN`

## Продакшен на Selectel (операционный runbook)

Текущее размещение:

- Сервер: `77.223.98.97`
- Пользователь: `root`
- Путь проекта на сервере: `/opt/andrew_20off_bot`

Быстрое подключение:

```bash
ssh root@77.223.98.97
```

Полезные команды на сервере:

```bash
cd /opt/andrew_20off_bot
docker compose ps
docker compose logs -f bot
docker compose restart bot
BOT_IMAGE=ghcr.io/<owner>/andrew_20off_bot:<tag-or-sha> docker compose --profile prod pull bot
BOT_IMAGE=ghcr.io/<owner>/andrew_20off_bot:<tag-or-sha> docker compose --profile prod up -d bot
docker compose down
```

Ручной fallback-деплой (если Actions временно недоступен):

```bash
ssh root@77.223.98.97 "cd /opt/andrew_20off_bot && echo \"$GHCR_TOKEN\" | docker login ghcr.io -u \"$GHCR_USERNAME\" --password-stdin"
ssh root@77.223.98.97 "cd /opt/andrew_20off_bot && BOT_IMAGE=ghcr.io/<owner>/andrew_20off_bot:<tag-or-sha> docker compose --profile prod pull bot && BOT_IMAGE=ghcr.io/<owner>/andrew_20off_bot:<tag-or-sha> docker compose --profile prod up -d bot"
```

Проверка, что бот жив:

```bash
ssh root@77.223.98.97 "cd /opt/andrew_20off_bot && docker compose ps && docker compose logs --tail=40 bot"
```

## Логи и диагностика

Быстрые команды:

```bash
# последние строки
ssh root@77.223.98.97 "cd /opt/andrew_20off_bot && docker compose logs --tail=120 bot"

# live-лог
ssh root@77.223.98.97 "cd /opt/andrew_20off_bot && docker compose logs -f bot"

# фильтрация ключевых событий
ssh root@77.223.98.97 "cd /opt/andrew_20off_bot && docker compose logs --tail=500 bot | rg 'boot|poll|digest|auth|telegram|fatal|error'"
```

Что проверять первым при инциденте:

1. Статус контейнера (`docker compose ps`).
2. Последние ошибки (`docker compose logs --tail=120 bot`).
3. Что деплой прошел с нужным image tag (в логах GitHub Actions CD).
