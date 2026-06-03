<div align="center">

# 🍻 Vibe Tavern

**Modern self-hosted platform for AI-roleplaying**

[![Version](https://img.shields.io/github/v/release/Noineri/vibe_tavern)](https://github.com/Noineri/vibe_tavern/releases)
[![License](https://img.shields.io/github/license/Noineri/vibe_tavern)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/Noineri/vibe_tavern/total)](https://github.com/Noineri/vibe_tavern/releases)

[Русский](./README.ru.md) · **English**

---

Simple installation and startup on any platform: **Windows** • **Linux** • **Docker-container**

Single `.exe` for Windows. Experimental **Android** version for Termux.

</div>

---

## What is Vibe Tavern?

Vibe Tavern — self-hosted AI-roleplaying web app developed with [Bun](https://bun.sh) + [React](https://react.dev). You can create characters, manage lore, build prompts and chat through any OpenAI-compatible API. Simple UI which doesn't force you to understand a clutter of settings.

> **Status:** 🛠️ Beta-2. Basic roleplaying functionality tested and stable. [What is not yet ready →](#what-is-not-yet-ready)

> [!NOTE]
> Vibe Tavern in active development, so bugs, incomplete features and breaking changes are to be expected. Don't forget to make backups of your data directory before any updates.

---

## Key features

### 💬 Chat

- **Nothing superfluous** - just you and the character. Switch chats, personalities, prompts presets and AI models from quick access without distracting yourself from communication.
- **Streaming and reasoning** — the reasoning blocks are collapsed by default so as not to interfere with the main chat flow. However, you can open them up and see that the reasoning look stylish.
- **Swipes of response options** — desktop animation of slides + a mobile carousel of three panels. Built-in token counting and model label for a specific swipe.
- **Tokens counting directly in UI** — keep track of the context budget without opening the settings, right in the chat input! A color display is implemented, as well as a pop-up window showing what takes up and how much.
- **Stylish colorscheme** - optimized for long reading (at least the dark theme. Who even uses the light theme?).

### 🧠 Context compaction

- **Visual feedback on tokens** — "Without compaction: 12,753t → Saved 11,814t (93%)".
- **Auto-compact** — background compaction based on the "set up and forget" principle every N messages.
- **Range compaction** — each one covers a certain range of messages, which can be enabled/disabled individually.
- **Managing the number of messages in a context** - model can only look at the last N messages, and use the rest of the context for something else.

### ✍️ Script editor

- A full-featured JS script editor with syntax highlighting, search, and line numbering.
- Too hard to write scripts yourself? Use a template! The template doesn't fit? MAKE the built-in AI assistant rewrite it!

### 🔍 Prompt Tracer

- You can see how the prompt was builded — layer by layer.
- The number of tokens per layer, the injection depth, and the activation source.

### 📦 SillyTavern compatible

- Characters cards import (V2/V3 PNG).
- Import of lorebooks, chat histories, and preset prompts.
- Bulk import — select ST directory and import all at once.
- Full ST macro support (`{{user}}`, `{{char}}`, `{{if}}`, `{{setvar}}`, `{{roll}}` etc.).

### 📱 Access from smartphone

- Open **Mobile Access** in the web UI and scan the QR code → chat from your phone on the same LAN or through Tailscale/VPN.
- The QR/copy URL includes the current access token in `#token=...`; the browser stores it locally and sends it with API requests.
- Remote API access is fail-closed: LAN/Tailscale clients need the current token, while local `127.0.0.1` access stays passwordless.
- Optional TLS.
- Android ARM64 build for Termux.

### 🛠️ For advanced users

- **Lorebooks engine** — keywords activation, AND/OR/NOT logic, cooldown, groups weights, recursion, scanning depth, WI anchors.
- **Scripts** — `node:vm` sandbox with Janitor AI compatible API.
- **Macro engine** — AST-based recursive descent parser, nested blocks `{{if}}`, variables, dice rolls.
- **5 providers types** — OpenAI-compat (for example OpenRouter, DeepSeek, Groq, xAI, Mistral, Xiaomi MiMo, ZAI etc.), Anthropic, Google, Ollama, llama.cpp.
- **Model-aware samplers** — stop sequences, custom sampler controls, and fail-closed logit bias that only enables for known provider/model tokenizer pairs.
- **Prompts presets** — full control over system prompt, jailbreak, author's note, and custom depth injections.

---

## Quick start

### Windows

#### Option 1:

Download and run latest `.exe` from [Releases](https://github.com/Noineri/vibe_tavern/releases), Vibe Tavern will open in your browser.

> [!NOTE]
> Windows executable is still experimental. It works but requires more testing. If something broke, try `.bat` file option:

#### Option 2:

Download zip archive from [Releases](https://github.com/Noineri/vibe_tavern/releases), extract it and run `Start RP Platform.bat`

### Linux / macOS

```bash
git clone https://github.com/Noineri/vibe_tavern.git
cd vibe_tavern
bash ./Vibe_Tavern.sh
```

`Vibe_Tavern.sh` will check bun installation, updates, create data backup a launch Vibe Tavern

### Docker

```bash
docker compose up -d
```

### Android (Termux)

APK build for Termux — automates most installation precess, but require some special access granted. Look at [Android installation guide](docs/android-setup.md).

---

## SillyTavern comparison

|                       | SillyTavern           | Vibe Tavern                                     |
| --------------------- | --------------------- | ----------------------------------------------- |
| **Frontend**          | jQuery + vanilla JS   | React 19                                        |
| **Backend**           | Express               | Hono (14KB gzipped)                             |
| **DB**                | JSON-files            | SQLite                                          |
| **Editor**            | Generic `<textarea>`  | Auto-resize textareas, CodeMirror 6 for scripts |
| **Compaction**        | Third-party extension | Built-in (with visual feedback)                 |
| **Prompt Tracer**     | Third-party extension | Built-in                                        |
| **Smartphones**       | Manual connection     | QR-code, one click access                       |
| **Cards importing**   | ✅ V2/V3              | ✅ V2/V3 + bulk import                          |
| **Macro**             | ✅ Full               | ✅ Full ST-compatible                           |
| **Standalone binary** | ❌                    | ✅ `bun build --compile`                        |
| **Plugins**           | 300+                  | ❌ (planned)                                    |
| **Group chats**       | ✅                    | ❌ (planned)                                    |
| **Image generation**  | ✅ A1111/ComfyUI      | ❌ (planned)                                    |
| **TTS**               | ✅                    | ❌ (planned)                                    |
| **Community**         | 159K weekly users     | Just begins                                     |

---

## What is not yet ready

Vibe Tavern in Beta-2 stage. That's what's missing so far:

- **Plugins** — extensions system not implemented yet.
- **Group chats** — only your character + your persona.
- **Image generation** — no A1111/ComfyUI integration.
- **TTS / STT** — no voice support.
- **Vector/RAG** — no embedding-based search (but the usual activation of lorebooks works).
- **Lack of edge-cases tests** — main flows have been tested, but unusual combinations can break something.

If you encounter a bug, [create issue](https://github.com/Noineri/vibe_tavern/issues). This will help a lot.

---

## Stack

| Layer        | Technology                                                                       |
| ------------ | -------------------------------------------------------------------------------- |
| Runtime      | [Bun](https://bun.sh) — fast all-in-one JavaScript, TypeScript & JSX toolkit     |
| Backend      | [Hono](https://hono.dev/) — type-safe RPC, 14KB                                  |
| Frontend     | [React 19](https://react.dev) + [Tailwind CSS 4](https://tailwindcss.com)        |
| DB           | SQLite via [Drizzle ORM](https://orm.drizzle.team)                               |
| AI streaming | [Vercel AI SDK](https://ai-sdk.dev/) — unified interface for different providers |
| Language     | TypeScript                                                                       |

**Monorepo structure:**

```
vibe_tavern/
├── packages/domain/          # Types, ID, constants (without dependencies)
├── packages/api-contracts/   # Zod-schemas, common to frontend and backend
├── packages/db/              # Drizzle storages
├── packages/prompt-pipeline/ # Pure build function, macro engine
├── packages/import-export/   # Cards and chat parsers
├── services/api/             # Backend (Hono + AI-requests)
└── apps/web/                 # Frontend SPA (React 19)
```

---

## Contributing

We welcome any contributions — code, translations, documentation, bug reports, or ideas.

Find instructions for local launch and guidelines in [CONTRIBUTING.md](../CONTRIBUTING.md).

**Where You can start:**

- 🌍 Translations
- 🐛 Bug-reports
- 📖 Improved documentation and user guides
- 🎨 CSS-themes

---

## License

[AGPL-3.0](LICENSE)

---

<div align="center">

**[Download](https://github.com/Noineri/vibe_tavern/releases)** ·
**[Report a bug](https://github.com/Noineri/vibe_tavern/issues)** ·
**[Discuss](https://github.com/Noineri/vibe_tavern/discussions)**

Built by AI agents on pure vibes 🍻

</div>
