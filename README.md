# Claw Tavern

Claw Tavern is a local-first AI roleplay platform for building characters, managing lore and personas, assembling prompts, and chatting through OpenAI-compatible providers.

The project is currently in **Phase 1: Minimum Viable Roleplay**. The core chat loop works, and development is focused on reaching a stable Beta-1 experience.

## Current Status

Claw Tavern is in active development.

The project already supports the basic local RP workflow: character import and creation, provider profiles, prompt assembly, SQLite-backed chats, and common message actions. Current work focuses on completing the Beta-1 roleplay experience, improving the character editor, onboarding, prompt presets, UI polish, provider handling, and hardening.

## Quick Start

Requirements:

- Node.js with `node:sqlite` support
- npm

Install dependencies and start the local dev environment:

```bash
npm install
npm run dev
```

After startup:

- Web app: `http://localhost:4173`
- API: `http://127.0.0.1:8787`
- API healthcheck: `http://127.0.0.1:8787/health`

On Windows, `Start RP Platform.bat` starts the same local environment, installs dependencies if needed, sets the frontend API URL, and writes logs to `logs/`.

Useful commands:

```bash
npm run dev
npm run dev:web
npm run dev:api
npm run build
npm run typecheck
```

Basic smoke test:

1. Open `http://localhost:4173`.
2. Create or import a character card.
3. Save and activate an OpenAI-compatible provider profile.
4. Select a model.
5. Start a chat and send a message.

Local data is stored in `data/app.sqlite` by default. Runtime logs are written to `logs/`.

## Development Phases

### Phase 1 - Minimum Viable Roleplay

Goal: make the local single-user RP experience complete enough for regular use.

This phase covers the core loop: characters, personas, lorebooks, prompt presets, provider profiles, chat storage, message editing and regeneration, onboarding, import flows, and UI cleanup.

Current status: **WIP**. The main chat loop works, but Beta-1 polish and hardening are still in progress.

### Phase 2 - Advanced Roleplay

Goal: make conversations richer, faster, and more resilient.

Planned work includes streaming responses, memory consolidation, better provider routing, rate-limit handling, provider error UI, and reasoning/thinking block support.

Current status: **planned**.

### Phase 3 - Agentic / Retrieval

Goal: connect the platform to tools, local retrieval, and more agentic workflows.

Planned work includes MCP integration, local retrieval services, tool permissions, parallel dispatch, and more advanced routing.

Current status: **future**.

## Project Layout

- `apps/web` - React/Vite frontend.
- `services/api` - local Node.js HTTP API and runtime orchestration.
- `packages/domain` - shared domain models.
- `packages/api-contracts` - frontend/backend DTO contracts.
- `packages/prompt-pipeline` - prompt assembly and prompt trace logic.
- `packages/db` - SQLite and in-memory storage implementations.
- `packages/import-export` - character, lorebook, and chat import/export helpers.
- `scripts` - local development launcher scripts.

## Configuration

Common environment variables:

- `RP_PLATFORM_API_HOST` - API host, default `127.0.0.1`
- `RP_PLATFORM_API_PORT` - API port, default `8787`
- `RP_PLATFORM_WEB_URL` - web dev URL, default `http://localhost:4173`
- `RP_PLATFORM_CHAT_STORE` - `sqlite` or `memory`
- `RP_PLATFORM_DB_PATH` - SQLite file path, default `data/app.sqlite`
- `VITE_RP_API_URL` - API base URL used by the frontend
- `VITE_RP_DEFAULT_PROVIDER_LABEL` - default provider label shown in the UI
- `VITE_RP_DEFAULT_BASE_URL` - default provider base URL shown in the UI
- `VITE_RP_DEFAULT_MODEL` - default provider model shown in the UI

Do not commit provider API keys or local secrets.

## Planning

The README is only the project entrypoint. Detailed planning lives in:

- `../rp_platform_plan/ROADMAP.md`
- `../rp_platform_plan/agent_tasks/active/DISPATCH.md`

## Known Limits

- Local single-user developer runtime, not a production SaaS.
- No authentication, roles, or multi-user server boundary.
- Main live generation path is OpenAI-compatible provider flow.
- Streaming, provider routing, memory consolidation, and agentic tooling are planned for later phases.
- Beta-1 testing, logging, and hardening are still in progress.
