# Claw Tavern

Локальный developer-prototype chat-first платформы для AI roleplay. Репозиторий собран как TypeScript npm-workspaces monorepo: web-клиент на React/Vite в `apps/web`, API на Node.js в `services/api`, общие доменные модели, контракты, prompt pipeline, импорт и хранение вынесены в `packages/*`. Текущий frontend entrypoint — [apps/web/src/app.tsx](../rp_platform/apps/web/src/app.tsx), собранный вокруг [useRpPlatformApp()](../rp_platform/apps/web/src/hooks/use-rp-platform-app.ts:63). В текущем состоянии репо уже умеет импортировать карточки персонажей из PNG/JSON, подключать lorebook JSON, собирать prompt, хранить чаты и профили провайдеров локально и отправлять генерацию в OpenAI-compatible API.

## Быстрый старт

### Что нужно

- Node.js современной версии с поддержкой встроенного `node:sqlite` для персистентного режима
- npm

### Установка и запуск

```bash
npm install
npm run dev
```

После запуска доступны:

- web: `http://localhost:4173`
- API: `http://127.0.0.1:8787`
- healthcheck: `http://127.0.0.1:8787/health`

Альтернативы:

```bash
npm run dev:web
npm run dev:api
npm run build
npm run typecheck
```

Для Windows есть `Start RP Platform.bat`: батник переходит в корень репо, при отсутствии `node_modules` запускает `npm install`, выставляет `VITE_RP_API_URL=http://127.0.0.1:8787`, пишет логи в `logs/` и поднимает общий launcher.

### Быстрый сценарий проверки

1. Открой `http://localhost:4173`.
2. Импортируй PNG character card или JSON character card — это создаст первый chat.
3. При необходимости прикрепи lorebook JSON к текущему персонажу.
4. Сохрани provider profile, подключи его и выбери model.
5. После этого можно отправлять сообщения и смотреть prompt trace в UI.

## Технические подробности реализации

### Структура workspace

- `apps/web` — SPA на React/Vite. Содержит app shell, play/build режимы, импорт персонажей, настройки провайдера, prompt trace и клиент для API.
- `services/api` — локальный HTTP API без внешнего веб-фреймворка. Здесь находятся runtime, маршрутизация, orchestration чатов, импортов и вызовов провайдера.
- `packages/domain` — доменные сущности и идентификаторы: character, persona, lorebook, chat, branch, message, prompt trace и связанные типы.
- `packages/api-contracts` — DTO и API-контракты между frontend и backend.
- `packages/prompt-pipeline` — сборка prompt layers, macro support, lore activation, compaction и итоговый payload для модели.
- `packages/db` — `ChatSessionStore`, in-memory и SQLite реализации, миграции и schema.
- `packages/import-export` — импорт character card v3 и SillyTavern lorebook JSON в внутренние сущности.

### Как устроен запуск в dev

`npm run dev` запускает `scripts/dev-supervisor.cjs`. Launcher:

1. Проверяет, что порты API и web свободны.
2. Поднимает Vite для `apps/web`.
3. Собирает API-стек через `npm run build:api-stack`.
4. Запускает собранный `services/api`.
5. Ждёт готовность `http://127.0.0.1:8787/health` и `http://localhost:4173`.
6. Пишет отдельные логи launcher, API и web в `logs/`.

### Web-клиент

Frontend сосредоточен вокруг [apps/web/src/app.tsx](../rp_platform/apps/web/src/app.tsx), [apps/web/src/hooks/use-rp-platform-app.ts](../rp_platform/apps/web/src/hooks/use-rp-platform-app.ts) и [apps/web/src/app-client.ts](../rp_platform/apps/web/src/app-client.ts).

- UI стартует пустым, пока не импортирован первый персонаж.
- Есть режимы play и build.
- Импорт PNG делается на клиенте: из PNG вытаскивается embedded metadata, затем нормализованный JSON отправляется в backend.
- Импорт JSON идёт в backend через `/api/import/json`.
- Настройки подключения к провайдеру хранятся как provider profiles; UI умеет их создавать, загружать, удалять, подключать и обновлять список моделей.
- Для live-generation нужен сохранённый и успешно подключённый provider profile с выбранной model; без этого отправка сообщений отключена.

### API и runtime

API реализован в [services/api/src/dev-server.ts](../rp_platform/services/api/src/dev-server.ts) как один Node HTTP server.

Что уже есть в API:

- `/health`
- операции с provider profiles
- загрузка сохранённого профиля, подключение профиля и загрузка списка моделей
- импорт character/lorebook JSON
- обновление данных персонажа
- chat/message/branch операции для прототипного runtime

Основная orchestration-логика находится в [services/api/src/prototype-session-runtime.ts](../rp_platform/services/api/src/prototype-session-runtime.ts), [services/api/src/live-chat-orchestrator.ts](../rp_platform/services/api/src/live-chat-orchestrator.ts) и [services/api/src/provider-orchestrator.ts](../rp_platform/services/api/src/provider-orchestrator.ts).

- Runtime собирает snapshot состояния для UI.
- Импортированный character card автоматически создаёт chat.
- Lorebook привязывается к текущему character/chat.
- Prompt trace сохраняется и возвращается в UI.
- Профили провайдеров хранятся в общем store вместе с остальными данными прототипа.

### Prompt pipeline

`packages/prompt-pipeline` отвечает за подготовку запроса к модели.

- Собирает prompt layers из character base, system prompt, persona, scenario, lore и истории.
- Активирует lore entries по ключам из недавнего текста.
- Поддерживает macros вроде `{{char}}` и `{{user}}`.
- Содержит compaction/token accounting слой, но часть этой логики пока прототипная и использует упрощённые оценки.

### Интеграция с провайдером

Вызов внешней модели идёт через orchestrator-слой и provider manager в [services/api/src/provider-orchestrator.ts](../rp_platform/services/api/src/provider-orchestrator.ts) и [services/api/src/providers/manager.ts](../rp_platform/services/api/src/providers/manager.ts).

- Для списка моделей используется OpenAI-compatible endpoint `GET /models`.
- Для генерации используется OpenAI-compatible endpoint `POST /chat/completions`.
- Реально подключённый adapter сейчас один: `openai_compat`.
- Типы для `anthropic`, `google` и `cohere` уже заведены, но полноценные adapters пока не подключены.

### Хранение данных

По умолчанию runtime использует SQLite.

- Файл БД по умолчанию: `data/prototype.sqlite`.
- Если выставить `RP_PLATFORM_CHAT_STORE=memory`, runtime перейдёт на in-memory store.
- Если инициализация SQLite падает, runtime автоматически откатывается на in-memory режим.
- SQLite schema и migrations лежат в `packages/db`.

### Импорт данных

Поддерживаемые сейчас сценарии:

- PNG character card -> metadata читается на frontend, затем отправляется как JSON на backend.
- JSON character card -> импортируется как `chara_card_v3`.
- SillyTavern lorebook JSON -> импортируется как lorebook и связывается с текущим character.

Импортные преобразования вынесены в `packages/import-export`, чтобы форматный parsing не смешивался с UI и HTTP-слоем.

### Полезные переменные окружения

Только реально используемые переменные из текущего кода:

- `RP_PLATFORM_API_HOST` — host API, по умолчанию `127.0.0.1`
- `RP_PLATFORM_API_PORT` — port API, по умолчанию `8787`
- `RP_PLATFORM_API_URL` — полный URL API для launcher
- `RP_PLATFORM_WEB_URL` — URL web dev server, по умолчанию `http://localhost:4173`
- `RP_PLATFORM_LAUNCH_TIMEOUT_MS` — timeout ожидания готовности launcher
- `RP_PLATFORM_OPEN_BROWSER` — `0` отключает автооткрытие браузера
- `RP_PLATFORM_LOG_DIR` — каталог логов launcher
- `RP_PLATFORM_LOG_FILE` — файл лога launcher
- `RP_PLATFORM_CHAT_STORE` — `sqlite` или `memory`
- `RP_PLATFORM_DB_PATH` — путь к SQLite-файлу, по умолчанию `data/prototype.sqlite`
- `VITE_RP_API_URL` — base URL, который использует frontend для вызова API
- `VITE_RP_DEFAULT_PROVIDER_LABEL` — дефолтное имя провайдера в UI
- `VITE_RP_DEFAULT_BASE_URL` — дефолтный base URL провайдера в UI
- `VITE_RP_DEFAULT_MODEL` — дефолтная model в UI

`Start RP Platform.bat` умеет подхватывать значения из внешнего `..\mcp\.env` и маппить `NANO_GPT_BASE_URL`/`NANO_GPT_MODEL` в `VITE_RP_DEFAULT_*`, но сам репозиторий не содержит и не должен содержать секреты.

### Текущее состояние и ограничения

Репозиторий уже пригоден для локальной разработки прототипа, но это не production-ready система.

- Нет аутентификации, ролей, multi-user сценариев и server-side secret management.
- API реализован как один локальный Node HTTP server, без production-инфраструктуры.
- Главная внешняя интеграция сейчас — только OpenAI-compatible provider flow.
- Часть логики явно помечена как prototype: локальный runtime, упрощённая compaction/token estimation и некоторые fallback-поведения.
- Основной сценарий репо сейчас — локальная разработка и проверка импортов, prompt assembly, trace и provider integration, а не готовый SaaS.
