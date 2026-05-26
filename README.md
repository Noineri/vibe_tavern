<div align="center">
  <h1>Claw Tavern</h1>
  <p><strong>A lightweight, self-hosted AI releplay platform</strong></p>
  
  [![Version](https://img.shields.io/github/v/release/Noineri/rp_platform)](https://github.com/Noineri/rp_platform/releases)
  [![License](https://img.shields.io/github/license/Noineri/rp_platform)](LICENSE)
  [![Downloads](https://img.shields.io/github/downloads/Noineri/rp_platform/total)](https://github.com/Noineri/rp_platform/releases)
  [![Last Commit](https://img.shields.io/github/last-commit/Noineri/rp_platform)](https://github.com/Noineri/rp_platform/commits)
  
  [![Bun](https://img.shields.io/badge/Bun-v1.3.14-green.svg)](https://bun.sh)
</div>

## What is Claw Tavern?

Claw Tavern is a local-first AI roleplay platform for building characters, managing lore and personas, assembling prompts, and chatting through OpenAI-compatible providers.

The project is currently in **Phase 1: Minimum Viable Roleplay**. The core chat loop works, and development is focused on reaching a stable Beta-1 experience.

>[!NOTE]
>Claw Tavern is in active development, so breaking changes or bugs are to be expected. Don't forget to make a backups of your data directory before any update

The project already supports the basic local RP workflow: character import and creation, provider profiles, prompt assembly, SQLite-backed chats, and common message actions. Current work focuses on completing the Beta-1 roleplay experience, improving the character editor, onboarding, prompt presets, UI polish, provider handling, and hardening.

## Quick Start

Claw Tavern is a web app, so it support any OS. Just choose method that you like from list below

### Linux:

#### Option 1. Directly run this project with bun

Install bun, grab latest [Release](https://github.com/Noineri/rp_platform/releases) or clone this repo with git, then:

```bash
bun install
bun run dev
```
#### Option 2. Docker compose

This repo include ```docker-compose.yml``` file. So just start the container

```bash
docker compose up -d
```

### Windows

#### Option 1. Launch this project with .bat file

Just launch ```Start RP Platfrom.bat```

#### Opetion 2. Standalone executable

Download latest executable from [Releases](https://github.com/Noineri/rp_platform/releases) and install Claw Tavern

>[!NOTE]
>This option is experimental. It works but definitely need more tests. 

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

## Known Limits

- Local single-user developer runtime, not a production SaaS.
- No authentication, roles, or multi-user server boundary.
- Main live generation path is OpenAI-compatible provider flow.
- Streaming, provider routing, memory consolidation, and agentic tooling are planned for later phases.
- Beta-1 testing, logging, and hardening are still in progress.
