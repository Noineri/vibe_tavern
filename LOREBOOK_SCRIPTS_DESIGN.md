# Lorebooks & JS Scripts — Design Document

## TL;DR

Лорбуки и JS-скрипты — две отдельные подсистемы в единой панели **World & Logic** (Build Mode). Пересекаются в одном месте: **скрипты могут читать активированные лор-энтри и модифицировать контекст перед отправкой промпта**. UI — drill-down с двумя табами: Lorebooks и Scripts, scope-фильтрация (global/character/persona/chat).

---

## 1. Current State (what exists)

### Backend
- **Domain types**: `Lorebook`, `LoreEntry`, `LorebookId`, `LoreEntryId`, `LoreScopeType`, `LoreLogic` — все определены в `packages/domain/`
- **DB schema**: `characters.characterBookJson` (text) — единственное хранилище лорбуков. Нет нормализованных таблиц.
- **Stores**: `StoreContainer` с `CharacterStore`, `ChatStore`, `PersonaStore` и т.д. Нет `LorebookStore` или `ScriptStore`.
- **API routes**: CRUD endpoints для lorebook entries уже зарегистрированы в `routes.ts` (`/api/lorebooks/:id/entries`, `/api/lorebooks/:id/test-activation`). Но runtime-методы — заглушки.
- **Pipeline**: `StaticPromptResolver.listActiveLoreEntries()` — **возвращает `[]`** (Phase 1 заглушка). Место для интеграции уже предусмотрено.
- **Prompt layers**: `sourceType: "lore_entry"` уже учитывается в `PromptTrace` и `assemblePrompt()`.

### Frontend
- **Maket (up-to-date)**: `LorebookEditor.tsx` — полноценная World & Logic панель с лорбуками + скриптами. Scope tabs, CRUD, advanced settings, animations. Скрипты: редактор кода, API reference, AI helper, templates, test panel, import.
- **Production frontend**: `apps/web/src/components/LorebookEditor.tsx` — **устаревший**. Базовый entry list + editor. Нет scope, нет скриптов, нет advanced settings, legacy CSS классы (`.lore-layout`, `.lore-sidebar` и т.д.).
- **Production BuildMode**: `BuildTab = "character" | "lorebook" | "trace"` — тип есть, но lorebook таб не подключён (только `char` и `trace` в InternalBuildTab).
- **API client**: `listLoreEntries`, `createLoreEntry`, `updateLoreEntry`, `deleteLoreEntry`, `testLoreActivation` — функции уже в `app-client.ts`.
- **Icons**: Prod icons (`apps/web/src/components/shared/icons.tsx`) — subset maket-иконок. Нет `chat`, `plug` (но добавляются тривиально).

### Maket → Production port assessment

| Maket feature | Port complexity | Notes |
|---|---|---|
| LorebookEditor shell (pick → list → editor drill-down) | **Medium** | Макет использует Tailwind + CSS vars. Прод использует legacy CSS классы (`var(--s2)`, `.lore-layout`). Нужен полный Tailwind-переход. |
| Scope tabs (global/character/persona/chat) | **Low** | Чистый JSX, иконки есть. Нужны данные из API (какие lorebooks привязаны к чему). |
| Lorebook accordion list + CRUD | **Low** | API functions уже в app-client. Логика простая. |
| Entry editor (basic fields) | **Low** | prod уже имеет 80% полей. Maket добавляет: content textarea, test, delete confirm. |
| Advanced settings (7 sections) | **Medium** | Новые поля: constant, probability, role, group, triggers, matchSources, characterFilter. Нужно расширить `LoreEntry` domain type + DB schema + API. |
| Script list + CRUD | **Low** | Новый UI, но паттерн = как lorebooks. Нужен новый `ScriptStore` + API endpoints. |
| Script code editor | **Low→Medium** | Maket: textarea. Prod: CodeMirror 6 (рекомендация). Структура компонента одинаковая. |
| API Reference panel | **Trivial** | Чистый display, нет логики. |
| Test panel (run script) | **Medium** | Maket: `new Function()`. Prod: sandbox endpoint на бекенде. UI одинаковый. |
| AI Helper modal | **Medium** | Maket: mock dropdowns. Prod: реальные провайдеры из `ProviderStore`, streaming SSE. UI shell переносится. |
| Import modal | **Low** | UI переносится, парсинг — backend logic. |
| Animations (lbFadeOut/lbFadeIn/lbSlideIn) | **Low** | Keyframes + state machine. Переносятся как есть. |

**Overall**: Основная работа — не UI, а backend (schema, stores, pipeline integration, sandbox, AI assistant endpoint). UI port относительно прямолинеен, потому что maket и prod используют одинаковые иконки и паттерны.

---

## 2. Database Schema

### 2.1. Design decisions

**Polymorphic FK vs Separate FKs → Separate FKs (вариант B)**

Причины:
- Проект использует SQLite + Drizzle ORM с `references()` и `onDelete: cascade`
- Нигде в проекте нет полиморфных FK — это будет нарушение паттерна
- SQLite foreign keys работают надёжно, дают integrity checks
- cascade при удалении character/persona/chat — автоматом

**Runtime state → json-колонки в `chats`**

Причины:
- Данные обновляются раз за генерацию (не горячий путь)
- Объём маленький (state для скриптов + activation state для лорбуков)
- Отдельная таблица — оверкилл для данных, которые всегда читаются целиком

### 2.2. New tables

```sql
-- Lorebook container
CREATE TABLE lorebooks (
  id TEXT PRIMARY KEY,                          -- lorebook_...
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scope_type TEXT NOT NULL,                     -- global | character | persona | chat
  scan_depth INTEGER NOT NULL DEFAULT 50,
  token_budget INTEGER NOT NULL DEFAULT 1000,
  recursive_scanning INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Owner binding (separate FKs — all NULL for global scope)
  character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  persona_id TEXT REFERENCES personas(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
  extensions_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_lorebooks_character ON lorebooks(character_id);
CREATE INDEX idx_lorebooks_persona ON lorebooks(persona_id);
CREATE INDEX idx_lorebooks_chat ON lorebooks(chat_id);
CREATE INDEX idx_lorebooks_scope ON lorebooks(scope_type);

-- Lorebook entries (fully ST-compatible)
CREATE TABLE lore_entries (
  id TEXT PRIMARY KEY,                          -- lore_entry_...
  lorebook_id TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  keys_json TEXT NOT NULL DEFAULT '[]',
  secondary_keys_json TEXT NOT NULL DEFAULT '[]',
  logic TEXT NOT NULL DEFAULT 'and_any',        -- and_any | and_all | not_any | not_all
  position TEXT NOT NULL DEFAULT 'in_prompt',   -- before_prompt | in_prompt | in_chat | hidden_system
  depth INTEGER NOT NULL DEFAULT 4,
  priority INTEGER NOT NULL DEFAULT 100,
  -- Time windows
  sticky_window INTEGER NOT NULL DEFAULT 0,
  cooldown_window INTEGER NOT NULL DEFAULT 0,
  delay_window INTEGER NOT NULL DEFAULT 0,
  -- Extended ST fields
  constant INTEGER NOT NULL DEFAULT 0,
  probability INTEGER NOT NULL DEFAULT 100,     -- 0-100
  role TEXT NOT NULL DEFAULT 'system',          -- system | user | assistant
  -- Inclusion group
  group_name TEXT NOT NULL DEFAULT '',
  group_weight INTEGER NOT NULL DEFAULT 100,
  prioritize_inclusion INTEGER NOT NULL DEFAULT 0,
  -- Recursion
  exclude_recursion INTEGER NOT NULL DEFAULT 0,
  prevent_recursion INTEGER NOT NULL DEFAULT 0,
  delay_until_recursion INTEGER NOT NULL DEFAULT 0,
  recursion_level INTEGER NOT NULL DEFAULT 0,
  scan_depth_override INTEGER,                  -- NULL = use lorebook default
  -- Matching
  case_sensitive INTEGER NOT NULL DEFAULT 0,
  match_whole_words INTEGER NOT NULL DEFAULT 0,
  character_filter_json TEXT NOT NULL DEFAULT '[]',
  character_filter_exclude INTEGER NOT NULL DEFAULT 0,
  triggers_json TEXT NOT NULL DEFAULT '[]',     -- normal | continue | impersonate | quiet
  match_sources_json TEXT NOT NULL DEFAULT '[]', -- chat_messages | character_desc | persona_desc | character_note | creator_notes
  -- Meta
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_lore_entries_lorebook ON lore_entries(lorebook_id);

-- JS Scripts
CREATE TABLE scripts (
  id TEXT PRIMARY KEY,                          -- script_...
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  scope_type TEXT NOT NULL DEFAULT 'character', -- global | character | persona | chat
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Owner binding (same pattern as lorebooks)
  character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  persona_id TEXT REFERENCES personas(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
  extensions_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_scripts_character ON scripts(character_id);
CREATE INDEX idx_scripts_persona ON scripts(persona_id);
CREATE INDEX idx_scripts_chat ON scripts(chat_id);
CREATE INDEX idx_scripts_scope ON scripts(scope_type);
```

### 2.3. Modified tables

```sql
-- Add runtime state columns to chats
ALTER TABLE chats ADD COLUMN lore_activation_state_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE chats ADD COLUMN script_state_json TEXT NOT NULL DEFAULT '{}';
```

`lore_activation_state_json` format:
```json
{
  "entry_id_1": { "firstActivatedAt": 5, "lastActivatedAt": 12 },
  "entry_id_2": { "firstActivatedAt": 3, "lastActivatedAt": 15 }
}
```

`script_state_json` format:
```json
{
  "script_id_1": {
    "mana": 75,
    "turnCount": 12,
    "lastWeather": "rain"
  }
}
```

### 2.4. Migration: characterBookJson → lorebooks

On app startup, in `createDb()`:

```
for each character where characterBookJson IS NOT NULL:
  parse JSON → extract entries
  create lorebook (scope=character, characterId=char.id)
  create lore_entries for each parsed entry
  set character.characterBookJson = NULL
```

This is a one-time migration. The existing `st-lorebook.ts` parser already handles this format.

---

## 3. Domain Types

### 3.1. Updated entities

```typescript
// packages/domain/src/entities.ts

export interface Lorebook {
  id: LorebookId;
  name: string;
  description: string;
  scopeType: LoreScopeType;
  scanDepth: number;
  tokenBudget: number;
  recursiveScanning: boolean;
  sortOrder: number;
  // Owner binding
  characterId: string | null;
  personaId: string | null;
  chatId: string | null;
  extensions: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface LoreEntry {
  id: LoreEntryId;
  lorebookId: LorebookId;
  title: string;
  content: string;
  keys: string[];
  secondaryKeys: string[];
  logic: LoreLogic;
  position: PromptLayerPosition;
  depth: number;
  priority: number;
  // Time windows
  stickyWindow: number;
  cooldownWindow: number;
  delayWindow: number;
  // Extended ST fields
  constant: boolean;
  probability: number;           // 0-100
  role: LoreEntryRole;           // system | user | assistant
  // Inclusion group
  group: string;
  groupWeight: number;
  prioritizeInclusion: boolean;
  // Recursion
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: boolean;
  recursionLevel: number;
  scanDepthOverride: number | null;
  // Matching
  caseSensitive: boolean;
  matchWholeWords: boolean;
  characterFilter: string[];
  characterFilterExclude: boolean;
  triggers: LoreTriggerType[];
  matchSources: LoreMatchSource[];
  // Meta
  enabled: boolean;
  sortOrder: number;
  metadata: Record<string, unknown>;
}
```

### 3.2. New constants

```typescript
// packages/domain/src/platform-constants.ts

export const LORE_ENTRY_ROLE = {
  system: "system",
  user: "user",
  assistant: "assistant",
} as const;
export type LoreEntryRole = typeof LORE_ENTRY_ROLE[keyof typeof LORE_ENTRY_ROLE];

export const LORE_TRIGGER_TYPE = {
  normal: "normal",
  continue: "continue",
  impersonate: "impersonate",
  quiet: "quiet",
} as const;
export type LoreTriggerType = typeof LORE_TRIGGER_TYPE[keyof typeof LORE_TRIGGER_TYPE];

export const LORE_MATCH_SOURCE = {
  chatMessages: "chat_messages",
  characterDesc: "character_desc",
  personaDesc: "persona_desc",
  characterNote: "character_note",
  creatorNotes: "creator_notes",
} as const;
export type LoreMatchSource = typeof LORE_MATCH_SOURCE[keyof typeof LORE_MATCH_SOURCE];
```

### 3.3. New IDs

```typescript
// packages/domain/src/ids.ts
export type ScriptId = Brand<"ScriptId">;

// platform-constants.ts ENTITY_ID_NAMESPACE
script: "script",
```

### 3.4. Script entity

```typescript
// packages/domain/src/entities.ts

export interface Script {
  id: ScriptId;
  name: string;
  description: string;
  code: string;
  enabled: boolean;
  scopeType: LoreScopeType;
  sortOrder: number;
  characterId: string | null;
  personaId: string | null;
  chatId: string | null;
  extensions: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

---

## 4. Stores

### 4.1. LorebookStore

```typescript
// packages/db/src/stores/lorebook-store.ts

export class LorebookStore {
  constructor(private db: AppDb) {}

  // Lorebook CRUD
  getById(id: string): Promise<Lorebook | null>;
  listByScope(scope: LoreScopeType): Promise<Lorebook[]>;
  listByOwner(scope: LoreScopeType, ownerId: string): Promise<Lorebook[]>;
  listAllActiveForChat(characterId: string, personaId: string, chatId: string): Promise<Lorebook[]>;
  create(data: CreateLorebookData): Promise<Lorebook>;
  update(id: string, data: Partial<CreateLorebookData>): Promise<Lorebook>;
  delete(id: string): Promise<void>;

  // Entry CRUD
  getEntry(entryId: string): Promise<LoreEntry | null>;
  listEntries(lorebookId: string): Promise<LoreEntry[]>;
  createEntry(lorebookId: string, data: CreateLoreEntryData): Promise<LoreEntry>;
  updateEntry(entryId: string, data: Partial<CreateLoreEntryData>): Promise<LoreEntry>;
  deleteEntry(entryId: string): Promise<void>;
  reorderEntries(lorebookId: string, entryIds: string[]): Promise<void>;
}
```

Key method: `listAllActiveForChat()` — loads all lorebooks relevant to a chat:
```
global (owner_type IS NULL)
+ character (characterId = X)
+ persona (personaId = Y)
+ chat (chatId = Z)
```
Returns sorted: global → character → persona → chat.

### 4.2. ScriptStore

```typescript
// packages/db/src/stores/script-store.ts

export class ScriptStore {
  constructor(private db: AppDb) {}

  getById(id: string): Promise<Script | null>;
  listByScope(scope: LoreScopeType): Promise<Script[]>;
  listByOwner(scope: LoreScopeType, ownerId: string): Promise<Script[]>;
  listAllEnabledForChat(characterId: string, personaId: string, chatId: string): Promise<Script[]>;
  create(data: CreateScriptData): Promise<Script>;
  update(id: string, data: Partial<CreateScriptData>): Promise<Script>;
  delete(id: string): Promise<void>;
}
```

### 4.3. StoreContainer update

```typescript
// packages/db/src/persistence.ts — add:
export interface StoreContainer {
  db: AppDb;
  characters: CharacterStore;
  personas: PersonaStore;
  providers: ProviderStore;
  chats: ChatStore;
  presets: PresetStore;
  uiSettings: UiSettingsStore;
  lorebooks: LorebookStore;   // NEW
  scripts: ScriptStore;       // NEW
}
```

---

## 5. Pipeline Integration

### 5.1. Execution order

```
PromptAssemblyService.assembleForChat()
  │
  ├─ 1. StaticPromptResolver — load character, persona, preset (as now)
  │
  ├─ 2. Resolve lorebooks
  │     listAllActiveForChat(charId, personaId, chatId)
  │     → collect all enabled entries
  │
  ├─ 3. Activation matching
  │     For each non-constant entry:
  │       - Check keys against recent messages (scan_depth)
  │       - Apply logic (and_any | and_all | not_any | not_all)
  │       - Check secondary keys
  │       - Check match sources (which text to scan)
  │       - Check triggers (normal | continue | impersonate | quiet)
  │       - Apply time windows (sticky, cooldown, delay) using loreActivationState
  │     Constant entries → always active
  │
  ├─ 4. Token budget + priority sort
  │     Sort by priority (descending), trim if token budget exceeded
  │
  ├─ 5. Execute scripts (before_prompt hook)
  │     Build ScriptContext with:
  │       - chat data (lastMessage, messages, messageCount)
  │       - character data (name, personality, scenario)
  │       - lore.activeEntries (from step 4)
  │       - state (from scriptStateJson)
  │     For each enabled script:
  │       - Run in sandbox with 5s timeout
  │       - Collect mutations to personality/scenario
  │       - Collect state changes
  │     Write back scriptStateJson
  │
  ├─ 6. Build prompt layers
  │     Activated entries → layers (position + depth + priority)
  │     Script injections → additional layers
  │
  └─ 7. assemblePrompt() with full layer set
```

### 5.2. StaticPromptResolver changes

```typescript
// Current (Phase 1):
async listActiveLoreEntries(input): Promise<LoreEntry[]> {
  void input;
  return [];
}

// Phase 2:
async listActiveLoreEntries(input: {
  chatId: ChatId;
  branchId: ChatBranchId;
  recentText: string;
  assemblyMode: AssemblyMode;
}): Promise<LoreEntry[]> {
  // 1. Load lorebooks for this chat
  // 2. Load entries
  // 3. Activation matching
  // 4. Return activated entries
}
```

New method on resolver:
```typescript
async executeScripts(input: {
  chatId: ChatId;
  characterRecord: CharacterRecord;
  personaRecord: PersonaRecord | null;
  messages: Array<{ role: string; content: string }>;
  activeLoreEntries: LoreEntry[];
}): Promise<ScriptExecutionResult> {
  // 1. Load enabled scripts for this chat
  // 2. Build ScriptContext
  // 3. Execute in sandbox
  // 4. Return mutations + state changes
}
```

### 5.3. PromptAssemblyService integration

```typescript
// Current flow:
// getCharacter → getPersona → getPreset → assemblePrompt()

// New flow:
// getCharacter → getPersona → getPreset
// → listActiveLoreEntries (with activation matching)
// → executeScripts (reads active entries, mutates context)
// → assemblePrompt (with lore layers + script injections)
```

The `PromptTrace` already has `activatedLoreEntries: LoreEntryId[]` — this will be populated with real data. New addition: `scriptInjections` in the trace for debugging.

---

## 6. Script Runtime

### 6.1. Sandbox

| Approach | Recommendation |
|---|---|
| `node:vm` | Start here. Simple, built-in. Add timeout. |
| `isolated-vm` | Production hardening later. True V8 isolation. |
| `Bun.sandbox()` | Monitor maturity. Could replace node:vm. |

Phase 2 ships with `node:vm` + 5s timeout.

### 6.2. ScriptContext API

```typescript
interface ScriptContext {
  // Chat data (read-only)
  chat: {
    lastMessage: string;
    last_message: string;          // Janitor alias
    messages: Array<{ message: string; role: string }>;
    messageCount: number;
  };

  // Character data (mutable via +=)
  character: {
    name: string;
    personality: string;           // mutable: += to inject
    scenario: string;              // mutable: += to inject
  };

  // Active lore entries (read-only)
  lore: {
    activeEntries: Array<{
      title: string;
      content: string;
      keys: string[];
    }>;
  };

  // Persistent state per-chat (mutable)
  state: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    increment(key: string, amount?: number): number;
  };

  // Utility functions
  random(): number;
  randomInt(min: number, max: number): number;
  pick<T>(arr: T[]): T;
  weightedPick(items: Array<{ weight: number }>): typeof items[number];
}
```

### 6.3. Janitor compatibility shim

Scripts imported from Janitor AI work as-is. The runtime provides both naming conventions:

```
context.chat.lastMessage     ← canonical
context.chat.last_message    ← Janitor alias (same value)
context.chat.messageCount    ← canonical
context.chat.message_count   ← Janitor alias (same value)
```

No code transformation needed at import time. The shim is in the runtime, not in the script.

### 6.4. State persistence

- Stored in `chats.script_state_json`
- Keyed by script ID: `{ [scriptId]: { [key]: value } }`
- 64KB limit per chat
- Loaded before script execution, saved after

---

## 7. AI Script Assistant

### 7.1. Architecture

The AI assistant for scripts is a **separate LLM call**, independent from the chat pipeline. It reuses existing provider infrastructure.

```
Frontend (Script Editor)
  │
  │ POST /api/scripts/ai-assistant
  │ { providerProfileId, model, prompt, existingCode?, mode }
  │
  ▼ routes.ts → RuntimeApiAdapter
  │
  ▼ ScriptAiAssistantService
  │   ├─ resolveProvider(profileId) → ProviderStore
  │   ├─ buildSystemPrompt(mode, existingCode?)
  │   ├─ mapProfileToSdkModel() → Vercel AI SDK provider
  │   └─ streamText() → SSE
  │
  ▼ Frontend receives SSE → inserts code into editor
```

### 7.2. Endpoint

```
POST /api/scripts/ai-assistant
Content-Type: application/json

Request:
{
  "providerProfileId": "provider_abc123",    // which provider to use
  "model": "gpt-4o",                         // which model
  "mode": "generate" | "refine",
  "prompt": "Track gold coins, deduct on purchase, show balance in personality",
  "existingCode": "..."                       // for refine mode
}

Response: SSE stream (text-delta)
```

### 7.3. System prompt (backend-defined, hardcoded)

```
You are a JavaScript code generator for an RP platform script system.

The script receives a `context` object with these fields:

READ-ONLY:
  context.chat.lastMessage       — last user message (string)
  context.chat.last_message      — alias for Janitor compatibility
  context.chat.messages          — array of { message: string, role: string }
  context.chat.messageCount      — total message count (number)
  context.character.name         — character name (string)
  context.lore.activeEntries     — array of { title, content, keys }

MUTABLE (use += to inject text):
  context.character.personality  — append text to inject into personality
  context.character.scenario     — append text to inject into scenario

PERSISTENT STATE (per-chat):
  context.state.get(key)         — read stored value
  context.state.set(key, value)  — store a value
  context.state.increment(key, n)— increment and return new value

UTILITIES:
  random()                       — 0 to 1
  randomInt(min, max)            — inclusive integer
  pick(array)                    — random element
  weightedPick([{weight: N}, …]) — weighted random selection

RULES:
- Use var, not let/const (ES5 compatibility)
- Inject via context.character.personality += or context.character.scenario +=
- Keep scripts under 100 lines
- Include inline comments explaining logic
- No HTTP requests, no async, no imports, no require
- Output ONLY JavaScript code, no markdown fences, no explanations
```

### 7.4. Service implementation

```typescript
// services/api/src/script-ai-assistant.ts

export class ScriptAiAssistantService {
  constructor(private stores: StoreContainer) {}

  async *streamGenerate(input: {
    providerProfileId: string;
    model: string;
    mode: 'generate' | 'refine';
    prompt: string;
    existingCode?: string;
  }): AsyncGenerator<string> {
    // 1. Resolve provider
    const profile = await this.stores.providers.getById(input.providerProfileId);
    if (!profile) throw notFound("ProviderProfile");

    // 2. Build messages
    const systemPrompt = buildSystemPrompt(input.mode, input.existingCode);
    const userMessage = input.mode === 'refine'
      ? `Current code:\n${input.existingCode}\n\nModify it to: ${input.prompt}`
      : input.prompt;

    // 3. Create SDK model
    const sdkModel = mapProfileToSdkModel(profile, input.model);

    // 4. Stream
    const stream = streamText({
      model: sdkModel,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: 4000,
      temperature: 0.3,  // low for code generation
    });

    for await (const chunk of stream.textStream) {
      yield chunk;
    }
  }
}
```

### 7.5. Reused infrastructure

| Component | From | Usage |
|---|---|---|
| `ProviderStore.getById()` | packages/db | Resolve provider profile |
| `mapProfileToSdkModel()` | provider-profile-mapper.ts | Create SDK model instance |
| `streamText()` | Vercel AI SDK | Streaming generation |
| SSE response | routes.ts pattern | Same as chat streaming |
| Temperature override | Inline | 0.3 for code (not user-configurable) |

### 7.6. Frontend integration

The maket AI helper modal provides the UI shell. Production needs:

1. **Connection dropdown** → `GET /api/provider-profiles` (already exists)
2. **Model dropdown** → `GET /api/provider-profiles/:id/models` (already exists)
3. **Generate button** → `POST /api/scripts/ai-assistant` (SSE)
4. **Streaming code into textarea** → append `text-delta` chunks to code field
5. **Refine button** → same endpoint with `mode: "refine"` + `existingCode`

For CodeMirror integration: insert streamed text at cursor position.

---

## 8. Script Editor

### 8.1. Code editor choice: CodeMirror 6

| Option | Size | Pros | Cons |
|---|---|---|---|
| Textarea (maket) | 0KB | Zero dependencies | No highlighting, no autocomplete |
| Monaco | ~2MB | VS Code experience | Heavy, complex bundling |
| **CodeMirror 6** | ~200KB | Fast, lightweight, good JS support, easy integration | Less features than Monaco |

**Recommendation: CodeMirror 6** — good balance. The maket textarea is the visual reference; CodeMirror replaces it structurally.

### 8.2. Autocomplete for `context.`

Custom CodeMirror completion source:

```typescript
const contextCompletions = [
  { label: 'context.chat.lastMessage', type: 'property', detail: 'string — last user message' },
  { label: 'context.chat.messages', type: 'property', detail: 'Array<{message, role}>' },
  { label: 'context.chat.messageCount', type: 'property', detail: 'number' },
  { label: 'context.character.name', type: 'property', detail: 'string' },
  { label: 'context.character.personality', type: 'property', detail: 'string (mutable +=)' },
  { label: 'context.character.scenario', type: 'property', detail: 'string (mutable +=)' },
  { label: 'context.lore.activeEntries', type: 'property', detail: 'Array<{title, content, keys}>' },
  { label: 'context.state.get', type: 'method', detail: '(key: string) => unknown' },
  { label: 'context.state.set', type: 'method', detail: '(key: string, value: unknown) => void' },
  { label: 'context.state.increment', type: 'method', detail: '(key: string, n?: number) => number' },
];
```

Triggered on `context.` — shows all available fields with type hints.

### 8.3. Error highlighting

When test panel returns an error with line number → CodeMirror gutter decoration on that line.

### 8.4. Format button

Backend endpoint or frontend-only (js-beautify). Low priority.

---

## 9. API Endpoints

### 9.1. Lorebooks (existing — update runtime)

```
GET    /api/lorebooks?scope={type}&ownerId={id}    — list by scope
POST   /api/lorebooks                               — create lorebook
PATCH  /api/lorebooks/:lorebookId                   — update metadata
DELETE /api/lorebooks/:lorebookId                   — delete + cascade entries

GET    /api/lorebooks/:lorebookId/entries           — list entries
POST   /api/lorebooks/:lorebookId/entries           — create entry
PATCH  /api/lorebooks/:lorebookId/entries/:entryId  — update entry
DELETE /api/lorebooks/:lorebookId/entries/:entryId  — delete entry
POST   /api/lorebooks/:lorebookId/entries/reorder   — reorder

POST   /api/lorebooks/:lorebookId/test-activation   — test text against entries
POST   /api/lorebooks/import                        — import ST lorebook JSON
```

### 9.2. Scripts (new)

```
GET    /api/scripts?scope={type}&ownerId={id}       — list by scope
POST   /api/scripts                                  — create script
PATCH  /api/scripts/:scriptId                        — update code/metadata
DELETE /api/scripts/:scriptId                        — delete

POST   /api/scripts/:scriptId/test                   — test execution (returns output)
POST   /api/scripts/import                           — import Janitor JS code
```

### 9.3. AI Assistant (new)

```
POST   /api/scripts/ai-assistant                     — SSE stream, generates/refines code
```

---

## 10. Implementation Phases

### Phase 2a — Lorebooks

1. **DB migration**: `lorebooks` + `lore_entries` tables, `lore_activation_state_json` in chats
2. **Domain**: update `Lorebook`, `LoreEntry` with extended fields + new constants
3. **LorebookStore**: full CRUD in packages/db
4. **characterBookJson migration**: one-time parse → normalize
5. **Activation engine**: implement in `StaticPromptResolver.listActiveLoreEntries()`
6. **API**: wire existing endpoints to real store methods
7. **UI**: port maket LorebookEditor (scope tabs → list → editor with advanced settings)

### Phase 2b — Scripts

1. **DB migration**: `scripts` table, `script_state_json` in chats
2. **Domain**: `Script` entity, `ScriptId`
3. **ScriptStore**: CRUD in packages/db
4. **Sandbox**: `node:vm` integration with timeout
5. **ScriptContext**: implement context object with Janitor aliases
6. **Pipeline**: `executeScripts()` in resolver, between lore activation and prompt assembly
7. **API**: script CRUD + test execution
8. **UI**: port maket script editor with CodeMirror 6

### Phase 2c — AI Assistant

1. **ScriptAiAssistantService**: provider resolution + streaming
2. **API**: SSE endpoint
3. **System prompt**: hardcoded in backend
4. **UI**: AI helper modal → real provider/model dropdowns + streaming into CodeMirror

---

## 11. Open Questions

1. **Monaco vs CodeMirror?** → Recommend CodeMirror 6 (200KB vs 2MB). Sufficient for JS editing + autocomplete.

2. **Script timeout**: 5 seconds. Sufficient for all non-HTTP scripts. HTTP is forbidden in sandbox.

3. **Janitor compatibility**: Runtime shim approach — no code transformation. Both `context.chat.lastMessage` and `context.chat.last_message` resolve to the same value.

4. **Script ordering within same scope**: `sort_order` field. Execution order = sort_order ascending. Scripts can depend on state set by earlier scripts.

5. **State size limit**: 64KB per chat for `script_state_json`. Enough for counters, inventories, stat blocks. Not enough for full procedural generation databases (those belong in lorebook entries).
