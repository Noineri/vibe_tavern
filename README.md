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

>[!NOTE]
>Claw Tavern is in active development, so breaking changes or bugs are to be expected. Don't forget to make a backups of your data directory before any update

The project already supports the basic local RP workflow: character creationa and import, provider profiles, prompt assembly, and common message actions. Current work focuses on completing the Beta-1 roleplay experience, improving the character editor, onboarding, prompt presets, UI polish, provider handling, and hardening.

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

## Known Limits

- Local single-user developer runtime, not a production SaaS.
- No authentication, roles, or multi-user server boundary.
- Main live generation path is OpenAI-compatible provider flow.
- Streaming, provider routing, memory consolidation, and agentic tooling are planned for later phases.
- Beta-1 testing, logging, and hardening are still in progress.

## Acknowledgments

Created with amazing open-source projects:

- [Bun](https://bun.sh)
- [Drizzle ORM](https://orm.drizzle.team)
- [React](https://react.dev)
- [Hono](https://hono.dev/)
- [Tailwind CSS](https://tailwindcss.com)
- [Vercel AI SDK](https://ai-sdk.dev/)

<div align="center">
  <p>We, the Claw Tavern team, hope that you enjoy reloplaying in our rp platform</p>
  <p>
    <a href="https://github.com/Noineri/rp_platform">GitHub</a> •
    <a href="https://github.com/Noineri/rp_platform/issues">Issues</a> •
    <a href="https://github.com/Noineri/rp_platform/discussions">Discussions</a>
  </p>
</div>