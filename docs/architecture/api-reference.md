# API Reference

> **`services/api`** — Hono HTTP API. All endpoints return JSON unless noted. Base URL defaults to `http://127.0.0.1:8787`.

---

## Conventions

| Convention | Detail |
|-----------|--------|
| **Auth** | Loopback requests (`127.0.0.1`/`::1`) bypass auth. Remote/LAN/Tailscale `/api/*` requests are fail-closed: if no mobile token is configured they return 401; otherwise they require `Authorization: Bearer <token>` or `?token=<token>`. |
| **Errors** | `{ error: string }` with appropriate HTTP status. `DomainError` kinds map to: 404 (NotFound), 400 (Validation), 409 (Conflict), 502 (Provider), 499 (Cancelled), 401 (Unauthorized), 500 (Internal). |
| **SSE streams** | Endpoints with `/stream` return `text/event-stream`. Events: `text-delta`, `reasoning-delta`, `error`, `snapshot`, `done`. |
| **Snapshots** | Most mutating endpoints return a monolithic snapshot (`SessionSnapshot`) that the frontend ingests atomically via `ingestSnapshot()`. Some endpoints return partial data (e.g., `renameChat` returns `{ chatId, title }`). |
| **Validation** | Request bodies validated via Zod schemas (`@hono/zod-validator`). Invalid requests return 400 with field-level error details. |

---

## Characters

### `POST /api/characters`

Create a new character.

**Body:** `createCharacterSchema`

```json
{
  "name": "Aria",
  "description": "A fire mage.",
  "firstMessage": "*looks up from her spellbook*",
  "scenario": "{{user}} enters the tower.",
  "personalitySummary": "Bold, curious",
  "mesExample": "<START>\n{{char}}: *casts fireball*",
  "mesExampleMode": "always",
  "mesExampleDepth": 4,
  "alternateGreetings": ["*glares at you*"],
  "postHistoryInstructions": "",
  "creatorNotes": "A character for fantasy RP.",
  "systemPrompt": "",
  "tags": ["fantasy", "mage"]
}
```

**Response:** `SessionSnapshot`

### `PATCH /api/characters/:characterId`

Update character fields.

**Body:** `updateCharacterSchema` (all fields optional)

```json
{
  "name": "Aria the Wise",
  "description": "An ancient fire mage.",
  "avatarAssetId": "asset_abc"
}
```

**Response:** `SessionSnapshot`

### `DELETE /api/characters/:characterId`

Delete a character and all associated data.

**Response:** `204` (empty body).

### `GET /api/characters/:characterId/export`

Export character as SillyTavern V2/V3 PNG card.

**Response:** Binary PNG with embedded character JSON.

### `PATCH /api/characters/:characterId/archive`

Archive a character (soft delete from active list).

**Response:** `{ characterId: string, status: "archived" }`

### `PATCH /api/characters/:characterId/unarchive`

Restore an archived character.

**Response:** `{ characterId: string, status: "active" }`

### `POST /api/characters/:characterId/duplicate`

Duplicate a character with a new ID.

**Response:** `SessionSnapshot`

### Character versions

Folder-snapshot branching for a character (VTF Phase 3). Each version is a snapshot of the character's folder; activating a version swaps the live character data.

| Endpoint | Body | Response |
|----------|------|----------|
| `GET /api/characters/:characterId/versions` | — | `CharacterVersion[]` |
| `POST /api/characters/:characterId/versions` | `{ title: string }` (`createVersionSchema`) | `CharacterVersion` (201) |
| `POST /api/characters/:characterId/versions/:versionId/activate` | — | `CharacterVersion`. `404` if version not found, `400` if it doesn't belong to the character |
| `PATCH /api/characters/:characterId/versions/:versionId` | `{ title: string }` (`renameVersionSchema`) | `CharacterVersion`. `404` if not found |
| `DELETE /api/characters/:characterId/versions/:versionId` | — | `204`. `409` if deleting the active version, `400` otherwise |

### Character avatar

| Endpoint | Body | Response |
|----------|------|----------|
| `POST /api/characters/:characterId/avatar` | Multipart: `crop` (required File, the thumbnail) + optional `full` (File, uncropped original). Back-compat: a `file` field is accepted as the crop | `{ ... }` avatar metadata. `413` if too large, `415` if unsupported type |
| `GET /api/characters/:characterId/avatar` | — | Thumbnail image binary. `404` if none |
| `GET /api/characters/:characterId/avatar/full` | — | Uncropped original image binary (falls back to the thumbnail if no separate full is stored). `404` if none |
| `POST /api/characters/:characterId/avatar/describe` | — | `{ description }` — runs the vision `describe` pipeline to caption the avatar. Returns `{ description: "" }` if the client aborts (AbortController) |
| `POST /api/characters/:characterId/avatar/from-gallery` | Multipart: `sourceAssetId` (field) + `crop` (File) + `cropJson` (field, crop geometry %). Salvages the current avatar into the gallery before overwriting | `{ ... }` avatar metadata |

### Character media gallery (assets)

Per-character image gallery — the server-owned counterpart to `useGalleryStore`. Gallery images can be described (vision caption) and promoted into the general asset store for chat attachment.

| Endpoint | Body | Response |
|----------|------|----------|
| `GET /api/characters/:characterId/assets` | — | `CharacterAsset[]` (the gallery list) |
| `GET /api/characters/:characterId/assets/:assetRowId` | — | Image binary. `404` if not found |
| `POST /api/characters/:characterId/assets` | Multipart: `file` (File) | `CharacterAsset` (201). `413`/`415` on size/type error |
| `POST /api/characters/:characterId/assets/describe` | `{ assetRowIds?: string[] }` (omit/empty = describe all undescribed) | `{ updated, failed }` — vision-caption batch. Returns `{ updated: [], failed: [] }` if the client aborts mid-batch (partial results already persisted) |
| `PATCH /api/characters/:characterId/assets/:assetRowId` | `{ caption?, description?\|null, includeInPrompt? }` | `CharacterAsset`. `404` if not found |
| `PUT /api/characters/:characterId/assets/reorder` | `{ orderedIds: string[] }` | `204`. `400` if `orderedIds` is not a string array |
| `DELETE /api/characters/:characterId/assets/:assetRowId` | — | `204`. `404` if not found |
| `POST /api/characters/:characterId/assets/:assetRowId/promote-to-attachment` | — | `{ ... }` (201) — copies the gallery image into the general asset store so it can be attached to a chat draft without a client re-upload |

---

## Chats

### `POST /api/chats`

Create a new chat.

**Body:** `createChatSchema`

```json
{ "characterId": "char_1" }
```

If `characterId` omitted, uses the system character.

**Response:** `SessionSnapshot`

### `GET /api/chats/:chatId`

Get full chat state (messages, branches, variants, summaries).

**Response:** `SessionSnapshot`

### `PATCH /api/chats/:chatId/title`

Rename chat.

**Body:** `{ "title": "New Title" }` (`renameChatSchema`)

**Response:** `ChatListResponse` = `{ chats: SessionSnapshot["chats"] }` — only the sidebar label moved, so only the refreshed chats list is returned (not a full snapshot).

### `PATCH /api/chats/:chatId/greeting-index`

Select which alternate greeting to use.

**Body:** `{ "greetingIndex": 2 }`

**Response:** `SessionSnapshot`

### `DELETE /api/chats/:chatId`

Delete a chat and all associated data.

**Response:** 204 No Content (empty body).

### `POST /api/chats/:chatId/clone`

Clone a chat (same character, same branch structure).

**Response:** `SessionSnapshot`

### `POST /api/chats/:chatId/fork`

Fork a chat from a specific message into a new branch.

**Body:** `{ "fromMessageId": "msg_42" }` (optional — defaults to last message)

**Response:** `SessionSnapshot`

### `POST /api/chats/:chatId/clear`

Clear all messages from a chat (keeps the chat itself).

**Response:** `SessionSnapshot`

### `GET /api/chats/:chatId/export.jsonl`

Export chat as JSONL (one JSON object per line, SillyTavern-compatible format).

**Query:** `branchId` (optional) to export a specific branch.

**Response:** `application/x-ndjson; charset=utf-8` with the JSONL body.

### `GET /api/chats/:chatId/traces`

Lazy-load the branch-scoped prompt-trace history for Build Mode's prev/next navigation. This is the endpoint behind `useTraceHistoryStore`; it replaced the `promptTraceHistory` field that used to ship in every snapshot.

**Query:** `messageId` (optional, filter to one message), `branchId` (optional).

**Response:** `PromptTrace[]`.

---

## Messages

### `POST /api/chats/:chatId/messages/stream`

Send a user message and stream the AI response. **Primary generation endpoint.**

**Body:** `sendMessageSchema`

```json
{ "content": "Hello, Aria!" }
```

**Response:** `text/event-stream` (SSE)

Events:
| Event | Payload | Description |
|-------|---------|-------------|
| `text-delta` | `{ text: string }` | Assistant text chunk |
| `reasoning-delta` | `{ text: string }` | Thinking/reasoning chunk |
| `snapshot` | `SessionSnapshot` | Final state after generation completes |
| `error` | `{ error: string }` | Generation error |
| `done` | — | Stream complete |

### `POST /api/chats/:chatId/messages`

Send a user message **without** AI generation (append only).

**Body:** `sendMessageSchema`

```json
{ "content": "A message without generation." }
```

**Response:** `SessionSnapshot`

### `POST /api/chats/:chatId/messages/:messageId/regenerate/stream`

Regenerate a specific assistant message (streaming).

**Response:** SSE stream (same format as `/messages/stream`)

### `POST /api/chats/:chatId/messages/:messageId/regenerate`

Regenerate a specific assistant message (non-streaming).

**Response:** `SessionSnapshot`

### `POST /api/chats/:chatId/generate-reply/stream`

Generate an assistant continuation without user input (streaming).

**Response:** SSE stream

### `POST /api/chats/:chatId/generate-reply`

Generate continuation without user input (non-streaming).

**Response:** `SessionSnapshot`

### `POST /api/chats/:chatId/messages/:messageId/branch`

Create a new branch from a specific message.

**Response:** `SessionSnapshot`

### `POST /api/chats/:chatId/messages/:messageId/variants/:variantIndex/select`

Switch the active variant (swipe) for a message.

**Response:** `SessionSnapshot`

### `DELETE /api/chats/:chatId/messages/:messageId/variants/:variantIndex`

Delete a specific variant (swipe). Must not be the last variant.

**Response:** `SessionSnapshot`

### `PATCH /api/chats/:chatId/messages/:messageId`

Edit message content.

**Body:** `editMessageSchema`

```json
{ "content": "Edited message text." }
```

**Response:** `SessionSnapshot`

### `DELETE /api/chats/:chatId/messages/:messageId`

Delete a message.

**Response:** `SessionSnapshot`

### `POST /api/chats/:chatId/messages/:messageId/attachments/:attachmentId/regenerate-description`

Force-re-describe a single image/video attachment with the active profile's vision model, ignoring any existing description (even a hand-edited one). Uses the same vision resolution path as message send (profile `visionModel` + the `vision_describe` system prompt).

**Preconditions:** the attachment must be `image` or `video`, and a `visionModel` must be configured in the active provider profile.

**Errors:**
- `400` — attachment is not an image/video, or no vision model is configured.
- `404` — attachment not found.

**Response:** `{ description: string }` — the new description, also persisted to the message's attachments JSON. Reasoning (`<think>…`) is stripped before persistence.

> Exposed for the lightbox "regenerate" button. The auto-describe cache (skip-if-described) is non-destructive; this endpoint is the only way to re-describe or add a description out-of-band. See [Vision and Attachment Pipeline](./backend.md#vision-and-attachment-pipeline).

### `PATCH /api/chats/:chatId/messages/:messageId/attachments/:attachmentId/description`

Edit a single attachment's description in place (e.g. the user hand-edits the caption in the lightbox).

**Body:** `{ "description": string }`

**Response:** the updated attachment. Persisted to the message's attachments JSON.

### `DELETE /api/chats/:chatId/messages/:messageId/attachments/:attachmentId`

Remove an attachment from a message.

**Response:** `204`.

---

## Branches

### `POST /api/chats/:chatId/branches/:branchId/activate`

Switch to a different branch.

**Response:** `SessionSnapshot`

### `DELETE /api/chats/:chatId/branches/:branchId`

Delete a branch and all its messages.

**Response:** `SessionSnapshot`

### `PATCH /api/chats/:chatId/branches/:branchId`

Rename a branch.

**Body:** `{ label: string }`

**Response:** `SessionSnapshot`

---

## Summaries & Memory

### `GET /api/chats/:chatId/summaries`

List all chat summaries.

**Response:** `SessionSnapshot` (summaries included)

### `POST /api/chats/:chatId/summaries`

Create a manual summary.

**Body:** `createChatSummarySchema`

```json
{
  "label": "Early adventure",
  "content": "The party met at the tavern...",
  "summarizedFrom": 1,
  "summarizedTo": 40,
  "includeInContext": true,
  "excludeSummarized": true,
  "source": "manual"
}
```

**Response:** `SessionSnapshot`

### `PATCH /api/chats/:chatId/summaries/:summaryId`

Update a summary.

**Body:** `updateChatSummarySchema` (all fields optional)

**Response:** `SessionSnapshot`

### `DELETE /api/chats/:chatId/summaries/:summaryId`

Delete a summary.

**Response:** `SessionSnapshot`

### `POST /api/chats/:chatId/summaries/generate`

Generate a summary using AI.

**Body:** `generateChatSummarySchema`

```json
{
  "providerProfileId": "provider_1",
  "model": "gpt-4o-mini",
  "summarizedFrom": 1,
  "summarizedTo": 40
}
```

**Response:** `SessionSnapshot`

### `PATCH /api/chats/:chatId/memory-settings`

Update memory/summary configuration.

**Body:** `updateMemorySettingsSchema`

```json
{
  "messageHistoryLimit": 100,
  "autoSummaryConfig": {
    "enabled": true,
    "everyN": 20,
    "excludeSummarized": true
  }
}
```

**Response:** `SessionSnapshot`

### `POST /api/chats/:chatId/summary`

Summarize chat messages using AI (legacy endpoint).

**Body:** `{ "providerProfileId": "provider_1", "model": "gpt-4o-mini", "maxMessages": 50 }`

**Response:** `{ "summary": "..." }`

### `PUT /api/chats/:chatId/summary`

Save or replace the chat summary text.

**Body:** `{ "summary": "Summary text..." }`

**Response:** `SessionSnapshot`

### `POST /api/chats/:chatId/set-persona`

Change the active persona for this chat.

**Body:** `{ "personaId": "pers_2" }`

**Response:** `SessionSnapshot`

### `POST /api/chats/:chatId/set-prompt-preset`

Change the active prompt preset for this chat.

**Body:** `{ "promptPresetId": "prompt_preset_2" }`

**Response:** `SessionSnapshot`

---

## Prompt Traces

### `GET /api/prompt-traces/:traceId/export`

Export a prompt trace as JSON (shows all layers, token counts, and the final messages array).

**Response:** JSON prompt trace object.

---

## Lorebooks

### `GET /api/lorebooks`

List lorebooks in a scope.

**Query:** `scopeType` (default `character`) + `ownerId` (the character/persona/chat ID).

### `GET /api/lorebooks/all`

List **all** lorebooks across every scope (used by the global lorebook manager).

### `POST /api/lorebooks`

Create a lorebook.

**Body:** `createLorebookSchema`

```json
{
  "name": "World Lore",
  "scopeType": "character",
  "characterId": "char_1",
  "scanDepth": 50,
  "tokenBudget": 2048,
  "recursiveScanning": false
}
```

### `PATCH /api/lorebooks/:lorebookId`

Update lorebook metadata.

**Body:** `updateLorebookMetaSchema` (all fields optional)

### `DELETE /api/lorebooks/:lorebookId`

Delete a lorebook and all its entries.

### `POST /api/lorebooks/:lorebookId/test-activation`

Test which entries would activate against sample text.

**Body:** `{ "text": "The dragon approaches the castle." }`

**Response:** Array of activated entry IDs and details.

### `GET /api/lorebooks/:lorebookId/entries`

List all entries in a lorebook.

### `POST /api/lorebooks/:lorebookId/entries`

Create a lore entry.

### `PATCH /api/lorebooks/:lorebookId/entries/reorder`

Reorder multiple entries at once (positional `sortOrder`, preserving file order on import).

**Body:** `{ updates: Array<{ entryId, order }> }` (`reorderLoreEntriesSchema`)

**Response:** the reordered entries.

Create a lore entry.

**Body:** `createLoreEntrySchema`

```json
{
  "title": "The Dragon",
  "content": "A red dragon lives in the mountain.",
  "keys": ["dragon", "mountain"],
  "secondaryKeys": ["fire"],
  "logic": "and_any",
  "position": "after_char",
  "priority": 10,
  "constant": false,
  "probability": 100,
  "role": "system",
  "groupName": "creatures"
}
```

### `PATCH /api/lorebooks/:lorebookId/entries/:entryId`

Update a lore entry.

**Body:** `updateLoreEntrySchema` (all fields optional)

### `DELETE /api/lorebooks/:lorebookId/entries/:entryId`

Delete a lore entry.

### `POST /api/lorebooks/:lorebookId/import`

Import a lorebook from SillyTavern format.

**Body:** `importLorebookSchema`

```json
{
  "name": "Imported Lorebook",
  "scopeType": "character",
  "characterId": "char_1",
  "entries": [
    { "keys": ["castle"], "content": "An ancient fortress.", "position": "before_char" }
  ]
}
```

### `GET /api/lorebooks/:lorebookId/links`

Get all character/persona links for a lorebook.

**Response:** Array of `{ lorebookId, targetType, targetId }`

### `PUT /api/lorebooks/:lorebookId/links`

Replace all links for a lorebook.

**Body:** `setLorebookLinksSchema`

```json
{
  "links": [
    { "targetType": "character", "targetId": "char_1" },
    { "targetType": "persona", "targetId": "pers_2" }
  ]
}
```

### `POST /api/lorebooks/:lorebookId/duplicate`

Deep-copy a lorebook with all entries and links.

**Body:** `duplicateLorebookSchema` (all fields optional)

```json
{
  "name": "Copy of Lorebook",
  "scopeType": "character",
  "characterId": "char_2"
}
```

**Response:** `{ lorebook, links }`

### `GET /api/lorebooks/:lorebookId/export`

Export a lorebook as SillyTavern-compatible JSON.

**Response:** JSON with `Content-Disposition: attachment` header. Format matches ST's `entries` structure (numeric keys, ST field names).

---

## Personas

### `GET /api/personas`

List all personas.

### `POST /api/personas`

Create a persona.

**Body:** `createPersonaSchema`

```json
{
  "name": "Olya",
  "description": "A careful archivist.",
  "pronouns": "she/her",
  "defaultForNewChats": true
}
```

### `PATCH /api/personas/:personaId`

Update a persona.

**Body:** `updatePersonaSchema` (all fields optional)

### `DELETE /api/personas/:personaId`

Delete a persona.

### `POST /api/personas/:personaId/set-default`

Mark a persona as the default for new chats (`defaultForNewChats`). Mutually exclusive — unsets the previous default.

**Response:** `204`.

### Persona avatar

Mirrors the [character avatar](#character-avatar) surface:

| Endpoint | Body | Response |
|----------|------|----------|
| `POST /api/personas/:personaId/avatar` | Multipart: `crop` (File) + optional `full` (File); `file` accepted as crop for back-compat | avatar metadata |
| `GET /api/personas/:personaId/avatar` | — | Thumbnail image binary. `404` if none |
| `GET /api/personas/:personaId/avatar/full` | — | Uncropped original (falls back to thumbnail). `404` if none |
| `POST /api/personas/:personaId/avatar/describe` | — | `{ description }` — vision-caption the persona avatar |

### `POST /api/personas/:personaId/duplicate`

Duplicate a persona.

---

## Providers

### `GET /api/providers`

List all provider profiles.

### `GET /api/providers/:providerId`

Get a single provider profile.

### `POST /api/providers`

Create a provider profile.

**Body:** `saveProviderDraftSchema`

```json
{
  "name": "OpenAI",
  "providerPreset": "openai",
  "endpoint": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "defaultModel": "gpt-4o-mini",
  "contextBudget": 128000,
  "maxTokens": 2048,
  "temperature": 0.8,
  "topP": 0.95,
  "stopSequences": ["\nUser:", "<|im_end|>"],
  "logitBias": [
    { "tokenId": 1234, "bias": -100, "text": "foo", "sourceText": "foo", "model": "gpt-4o-mini" }
  ],
  "customSamplers": true,
  "streamResponse": true
}
```

Sampler notes:

- `stopSequences` are always forwarded when non-empty.
- Advanced sampler fields are only forwarded when `customSamplers` is enabled; basic fields such as `temperature`, `maxTokens`, stop sequences, and seed can still be sent without custom samplers.
- `logitBias` is fail-closed and model-aware. The API only forwards entries whose `model` matches the current `defaultModel`, and only when the provider/model pair has known support via `resolveLogitBiasSupport()`.

### `PATCH /api/providers/:providerId`

Update a provider profile.

**Body:** `updateProviderProfileSchema` (all fields optional)

### `DELETE /api/providers/:providerId`

Delete a provider profile.

### `POST /api/providers/:providerId/activate`

Set this provider as the active profile.

### `POST /api/providers/test`

Test connection with draft settings (no saved profile needed).

**Body:** `testProviderDraftSchema`

```json
{
  "endpoint": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "providerType": "openai_compat"
}
```

**Response:** `{ success: boolean, models?: string[], error?: string }`

### `POST /api/providers/:providerId/test`

Test connection for a saved profile.

### `POST /api/providers/test-chat`

Send a test message using draft settings.

**Body:** `testChatSchema`

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "model": "gpt-4o"
}
```

### `POST /api/providers/:providerId/test-chat`

Send a test message using a saved profile.

**Body:** `testChatProfileSchema`

```json
{ "model": "gpt-4o" }
```

### `POST /api/providers/fetch-models`

Fetch available models from a provider endpoint.

**Body:** `fetchModelsSchema`

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "providerType": "openai_compat"
}
```

**Response:** `{ models: Array<{ id: string, name?: string }> }`

### `POST /api/providers/:providerId/models`

Refresh cached model list for a saved provider.

### `GET /api/providers/:providerId/model-favorites`

Get favorite models for a provider.

### `POST /api/providers/:providerId/model-favorites`

Add a model to favorites.

**Body:** `{ "modelId": "gpt-4o", "label": "GPT-4o", "contextLength": 128000 }`

### `DELETE /api/providers/:providerId/model-favorites`

Remove a model from favorites.

**Body:** `{ "modelId": "gpt-4o" }`

### Per-model settings overlay (binding)

`bindPerModel` lets a provider store a per-model settings overlay — a partial sampler config that applies only when that specific model is selected (e.g. a lower temperature for a reasoning model). The overlay is keyed by `modelId`.

| Endpoint | Body | Response |
|----------|------|----------|
| `GET /api/providers/:providerId/model-settings` | — | `ProviderModelSettingsRecord[]` |
| `GET /api/providers/:providerId/model-settings/:modelId` | — | `ProviderModelSettingsRecord \| null` |
| `PUT /api/providers/:providerId/model-settings/:modelId` | `modelSettingsOverlaySchema` (partial sampler fields) | `ProviderModelSettingsRecord` (upsert) |
| `DELETE /api/providers/:providerId/model-settings/:modelId` | — | `{ ok: true }` |

### `POST /api/tokenize`

Count tokens for a text against a specific model's tokenizer (used by the UI token bar and context-budget preview).

**Body:** `{ text: string, model: string }` (`tokenizeSchema`)

**Response:** `{ tokens: number }`

---

## Prompt Presets

### `GET /api/prompt-presets`

List all prompt presets.

### `POST /api/prompt-presets`

Create a preset.

**Body:** `createPromptPresetSchema`

```json
{
  "name": "Celia V4.3",
  "system": "You are {{char}}. Roleplay with {{user}}.",
  "jailbreak": "[System: continue the story]",
  "prefill": "Understood.",
  "authorsNote": "Focus on sensory detail",
  "authorsNoteDepth": 4,
  "summary": "Summarize the events so far:",
  "tools": "Use search_lore to find relevant lore."
}
```

### `PATCH /api/prompt-presets/:presetId`

Update a preset.

**Body:** `updatePromptPresetSchema` (all fields optional)

### `DELETE /api/prompt-presets/:presetId`

Delete a preset.

---

## Scripts

### `GET /api/scripts`

List all scripts (with scope information).

### `GET /api/scripts/all`

List **all** scripts across every scope (used by the global script manager).

### `GET /api/scripts/:scriptId`

Get a single script with full code.

### `POST /api/scripts`

Create a script.

**Body:** `createScriptSchema`

```json
{
  "name": "Mood Tracker",
  "description": "Tracks character mood across messages.",
  "code": "const last = context.chat.lastMessage;\nif (last.includes('angry')) {\n  context.state.set('mood', 'angry');\n}",
  "scopeType": "character",
  "characterId": "char_1",
  "enabled": true,
  "sortOrder": 0
}
```

### `PATCH /api/scripts/:scriptId`

Update a script.

**Body:** `updateScriptSchema` (all fields optional)

### `DELETE /api/scripts/:scriptId`

Delete a script.

### `POST /api/scripts/:scriptId/test`

Test a script with simulated context.

**Body:** `testScriptSchema`

```json
{
  "messages": [
    { "role": "user", "content": "Hello!" },
    { "role": "assistant", "content": "Hi there!" }
  ],
  "characterName": "Aria",
  "lastMessage": "Hi there!"
}
```

**Response:** `{ output: any, error?: string, mutations?: object }`

### `POST /api/scripts/import`

Import a script from JS code or JSON.

**Body:** `importScriptSchema`

```json
{
  "format": "js",
  "code": "// Script code here",
  "name": "Imported Script",
  "scopeType": "character",
  "characterId": "char_1"
}
```

---

## AI Assistant

The AI Assistant subsystem (the lightbulb "assist" actions in the Build editor) is mounted as the `ai-assistant` [FeatureModule](./backend.md#feature-modules--lifecycle). These replaced the old `POST /api/scripts/ai-assistant` route.

### `POST /api/ai-assistant`

Run an AI Assistant mode and stream the result. The mode (`script`, `lore_entry`, `lore_keys`, `chat_impersonate`, `md_import`) selects what to generate; see [AI Assistant](./backend.md#ai-assistant) for the mode table and prompt fallback chain.

**Response:** `text/event-stream`. Events are mode-dependent: text modes stream `text-delta` chunks; JSON modes (`lore_keys`, `md_import`) buffer, strip reasoning, parse against the mode schema, then emit the parsed result.

### `POST /api/ai-assistant/tokens`

Count tokens for an AI Assistant request before running it (context-budget preview for the modal).

---

## Assets

### `POST /api/assets/upload`

Upload an image asset (avatar, gallery image).

**Body:** `multipart/form-data` with file field.

**Response:** `{ assetId: string, url: string }`

### `GET /api/assets/:assetId`

Serve an asset file. **Public** (no auth required — img tags can't send headers).

**Response:** Binary image file with appropriate Content-Type.

---

## Import

### `POST /api/import/json`

Import a character/chat from JSON (SillyTavern or internal format).

**Body:** `importJsonSchema`

```json
{
  "fileName": "Aria.png",
  "jsonText": "{ \"data\": { \"name\": \"Aria\", ... } }",
  "chatId": "chat_1",
  "skipExisting": false
}
```

**Response:** Import result with created entity IDs.

### `POST /api/import/st-scan`

Scan a SillyTavern data directory for importable content.

**Body:** `{ "directoryPath": "C:\\Users\\user\\SillyTavern\\data" }`

**Response:** List of importable characters, chats, lorebooks, and scripts.

### `POST /api/import/st-directory`

Bulk import from a SillyTavern directory.

**Body:** `{ "directoryPath": "C:\\Users\\user\\SillyTavern\\data" }`

**Response:** Import summary with counts per entity type.

---

## Settings

### `GET /api/settings/ui`

Get the UI settings record (theme, layout prefs, editor toggles).

### `PATCH /api/settings/ui`

Update UI settings (partial patch).

**Body:** partial UI settings object.

### Mobile access

### `GET /api/settings/mobile-access`

Get mobile access status, available IP addresses, port, TLS status, and current token if one exists.

The web modal uses this to generate `http(s)://IP:PORT/#token=...` QR/copy URLs. The token is placed in the hash so it is not sent to the server as part of normal navigation; the web app stores it in localStorage and removes the hash from the visible URL.

### `POST /api/settings/mobile-access/regenerate`

Generate or regenerate the mobile access token. Invalidates the previous token immediately; server restart is not required.

### `DELETE /api/settings/mobile-access`

Disable mobile access by revoking the token immediately. Remote `/api/*` access then returns 401 until a new token is generated.

---

## Debug

### `POST /api/debug/send-log`

Submit a debug log for troubleshooting.

**Body:** Any JSON (logged to `data/logs/send-debug.log`).

### `GET /api/bootstrap`

Get the bootstrap snapshot — all reference data needed on app startup (chats, characters, personas, presets, providers, UI settings).

**Response:** Full bootstrap object.

### `GET /api/defaults/ai-assistant-prompt`

Get the default system prompt for an AI Assistant mode (used by the Settings prompt editor to show the editable default).

**Query:** `mode` (default `script`) — any of the [AI Assistant modes](./backend.md#ai-assistant).

**Response:** `{ prompt: string }`.
