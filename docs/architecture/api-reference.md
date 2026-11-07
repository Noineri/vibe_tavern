# API Reference

> **`services/api`** — Hono HTTP API. All endpoints return JSON unless noted. Base URL defaults to `http://127.0.0.1:8787`.

---

## Conventions

| Convention | Detail |
|-----------|--------|
| **Auth** | Loopback requests (`127.0.0.1`/`::1`) bypass auth. Remote/LAN/Tailscale `/api/*` requests are fail-closed: if no mobile token is configured they return 401; otherwise they require `Authorization: Bearer <token>` or `?token=<token>`. |
| **Errors** | `{ error: string }` with appropriate HTTP status. `DomainError` kinds map to: 404 (NotFound), 400 (Validation), 409 (Conflict), 502 (Provider), 499 (Cancelled), 401 (Unauthorized), 500 (Internal). |
| **SSE streams** | Generation POSTs and replay GETs return `text/event-stream`; numbered event IDs are run-local cursors. Disconnect detaches the reader, not a detached producer. See the generation event table below. |
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

### Character tracker template

The portable tracker setup a character carries (per version, in `extensions.vibe_tavern.tracker_template`; see [scene-tracker.md](scene-tracker.md#character-tracker-template)). Creating an RP chat seeds its trackers from the active version's template in the creating transaction.

| Endpoint | Body | Response |
|----------|------|----------|
| `GET /api/characters/:characterId/tracker-template` | — | `{ template: TrackerTemplate \| null }` |
| `PUT /api/characters/:characterId/tracker-template` | `{ template: TrackerTemplate }` (`updateTrackerTemplateSchema`) | `{ template: TrackerTemplate }` |
| `DELETE /api/characters/:characterId/tracker-template` | — | `204` |

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
| `generation-context` | `{ runId, chatId, branchId, operation, messageId }` | First numbered event; operation is send/regenerate/continue/generate and messageId is nullable for a fresh reply |
| `user-message-saved` | `{ messageId }` | Committed user-message identity, when a send appends one |
| `generation-metadata` | `{ modelId, presetName }` | Resolved generation identity |
| `text-delta` | `{ delta: string }` | Assistant text chunk |
| `reasoning-delta` | `{ delta: string }` | Thinking/reasoning chunk |
| `tool-call`, `tool-result`, `tool-input-start`, `tool-input-delta` | Tool-specific payload | Co-Author activities/streaming tool input |
| `reasoning-done` | `{ durationMs }` | Reasoning duration |
| `finish` | `{ finishReason, usage?, messageCount?, lorebookOverflows? }` | Result committed; refetch the chat rather than expecting an embedded snapshot |
| `abort` | `{ partialLength }` | Cooperative Stop, after partial persistence |
| `error` | `{ message, category?, code?, partialSaved? }` | Classified provider/bind error; mode-specific media gates may also carry type/attachments |

Both RP and Co-Author POST stream routes start server-owned execution and subscribe to that exact run.
Competing generations return 409 `{ error: string, code: "AGENT_RUN_ACTIVE" }` before opening SSE.
The registry holds its slot through final persistence, not merely until a finish-looking event appears.

### `POST /api/chats/:chatId/messages`

Send a user message and return the generated reply without streaming text deltas.

**Body:** `sendMessageSchema`

```json
{ "content": "Hello, Aria!" }
```

**Response:** `MessageResponse` (messages, latest prompt trace and optional summaries).

### `POST /api/chats/:chatId/messages/:messageId/regenerate/stream`

Regenerate a specific assistant message (streaming).

**Optional body:** `{ model?: string, promptPresetId?: string }` (`regenerateOverrideSchema`); keys affect only this generation, not the chat row.

**Response:** SSE stream (same format as `/messages/stream`)

### `POST /api/chats/:chatId/messages/:messageId/regenerate`

Regenerate a specific assistant message (non-streaming).

**Response:** `MessageResponse`.

### `POST /api/chats/:chatId/messages/:messageId/continue[/stream]`

Continue the selected assistant variant's text as a new variant, without sending that text from the browser.
No body; the native path returns `MessageResponse`, the stream path uses the event format above.

### `POST /api/chats/:chatId/generate-reply/stream`

Generate an assistant continuation without user input (streaming).

**Response:** SSE stream

### `POST /api/chats/:chatId/generate-reply`

Generate continuation without user input (non-streaming).

**Response:** `MessageResponse`.

### `POST /api/chats/:chatId/messages/:messageId/branch`

Create a new branch from a specific message.

**Response:** `SessionSnapshot`

### Chat generation recovery, queue and Co-Author review

| Endpoint | Body/query | Response / behavior |
|---|---|---|
| `GET /api/chats/:chatId/generation` | `after` non-negative safe integer, default `0` | SSE replay after that cursor plus live tail; 204 if no run is retained since server start |
| `POST /api/chats/:chatId/generation/stop` | — | `{ stopped: boolean }`; cooperative and idempotent, partial output persists before EOF |
| `GET /api/chats/:chatId/queue` | — | `ChatGenerationJob[]` in enqueue order |
| `POST /api/chats/:chatId/queue` | `{ messageId, model, promptPresetId: string \| null }` | 201 `ChatGenerationJob`; target must be an assistant in this chat |
| `DELETE /api/chats/:chatId/queue/:jobId` | — | `{ ok: true }`; pending becomes cancelled, running requests Stop, settled jobs are unchanged |
| `POST /api/chats/:chatId/queue/clear` | — | `{ ok: true }`; deletes pending rows only |
| `GET /api/chats/:chatId/coauthor/review` | — | Canonical CA-15 v1 envelope or `null`; Co-Author mode required |
| `PUT /api/chats/:chatId/coauthor/review` | `coauthorReviewEnvelopeSchema` | Validated full replacement envelope |
| `DELETE /api/chats/:chatId/coauthor/review` | — | `{ ok: true }`; clears only this chat's review, never applies it |

`ChatGenerationJob` (`packages/api-contracts/src/chat-generation-job.ts`) has id/chatId/messageId/model, nullable promptPresetId, pending/running/done/failed/cancelled status, epoch-ms enqueuedAt and optional variantIndex/error.
Unset results are omitted, and variantIndex zero is preserved; optional recordId is a UI correlation, not persisted ownership.
Native JSON chat calls reserve the same generation slot while executing but keep their request-signal cancellation behavior; native replay supplies context and settlement rather than invented text deltas.
The first standalone regenerate is not a job; queue execution follows its existing regenerate/profile path and remains pinned to the target message's branch.
Restart fails interrupted running jobs with a retry reason and resumes pending jobs; completed rows are not rerun.

### App-level run discovery and per-chat notifications

| Endpoint | Response |
|---|---|
| `GET /api/agent-runs` | Active `{ threadId, owner, kind, title, startedAt }[]`; startedAt is epoch milliseconds |
| `GET /api/agent-runs/events` | SSE `ready`, then `agent.run` with `{ threadId, owner, kind, title, state }`; state is started/finished/asking/failed/stopped |
| `GET /api/chats/:chatId/events` | Existing per-chat SSE: ready, summary.started/generated/failed/cancelled, queue.updated |

Chat generations use threadId `chat:<chatId>` and owner `{ kind: "chat", chatId, mode }`; agent-thread owners retain script or chat-branch identities.
The app lifecycle channel is not a durable notification inbox or a generation-delta stream.
`queue.updated` carries an empty payload because the channel already identifies the chat; clients refetch its canonical queue, including after reconnect's ready handshake.
Manual summary events carry `source: "manual"`; generated also carries summaryId/label, and cancelled is quiet.
Remote EventSource clients authenticate with the same token query convention as the other SSE routes.

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

### `PATCH /api/chats/:chatId/messages/:messageId/attachments/:attachmentId/include-in-prompt`

Toggle an attachment's prompt visibility. Body: `{ "includeInPrompt": boolean }`.

Semantics (one filter — `filterPromptVisibleAttachments` in `@vibe-tavern/domain`): ordinary uploads are included when the flag is absent or `true`, excluded on explicit `false`; image-gen slots are opt-in — absent or `false` means OFF, and enabling requires a description or generation prompt.

**Response:** the updated attachment.

### `PATCH /api/chats/:chatId/messages/:messageId/attachments/:attachmentId/prompt`

Edit the generation prompt of a generated image slot (image-gen provenance only — not text-file attachments).

**Body:** `{ "prompt": string }` (non-empty).

**Errors:** `400` — the attachment is not a generated-image slot, or the prompt is empty.

**Response:** `{ ok: true }`.

### `POST /api/chats/:chatId/messages/:messageId/attachments/:attachmentId/summarize`

Summarize a text-file attachment with the active profile's default model (one-shot `attachment-summarize.md` system prompt; the file's full text is read from the asset store server-side). The summary replaces `description` and is costed into `summaryTokenCount`; the prompt then prefers the summary over the full text.

**Errors:**
- `400` — `attachment_not_text` (only text files), or `attachment_summary_empty` (the model returned an empty summary).
- `404` — attachment not found, or `attachment_asset_missing` (the stored asset is gone).

**Response:** the updated attachment (`description` = summary, `summaryTokenCount` set). Honors `AbortSignal` between steps.

### `POST /api/chats/:chatId/messages/:messageId/attachments/:attachmentId/clear-summary`

Drop a text file's summary and restore the full text as the prompt representation. Only text files (`attachment_not_text` otherwise).

**Response:** the updated attachment (`description` = `null`, `summaryTokenCount` cleared).

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

**Response:** `{ summary, chatSummary, snapshot: SummaryResponse }` after the server-owned manual run settles.
Closing the request does not stop the run; a second manual run in that chat returns 409 `AGENT_RUN_ACTIVE` independently of reply generation.

| Endpoint | Response |
|---|---|
| `GET /api/chats/:chatId/summaries/generate` | `{ from, to, label, startedAt }` for the running manual summary, otherwise `null` |
| `POST /api/chats/:chatId/summaries/generate/stop` | `{ stopped: boolean }`; cancellation saves no late result |

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

### `POST /api/chats/:chatId/insights/completion-refresh`

Join the current forward-state insight jobs (Objective and, when Scene-aware, the exact Scene target) without cancelling the shared jobs if this request is aborted. The target must still be owned by the path chat and requested branch — and, when `variantId` is present, the assistant variant must still exist — both before and after the join. This is the **single** completion transport: there is no second completion endpoint and no SSE channel for insight delivery.

**Body:** `insightsCompletionRefreshSchema`

```json
{
  "target": {
    "branchId": "branch_1",
    "messageId": "msg_42",
    "variantId": "var_7"
  }
}
```

`variantId` is optional: present → Scene-aware exact-variant join + scoped `message` patch returned; absent → backward-compatible Objective-only refresh. The two waits are composed through a `Promise.all` where each is individually failure-contained (one auxiliary failure never blocks the other or the main response).

**Response:** `InsightsCompletionPatchResponse` — echoes the immutable `{ chatId, branchId, messageId, variantId? }` target and returns only the matching scoped patch: `patch.objectiveState` (when Objective completed) and `patch.message` (the refreshed variant-bearing message, when the Scene target completed). It never returns a whole `SessionSnapshot`. The frontend applies it only while the request remains the latest target for that chat and the echoed message/variant still belongs to the active chat/branch.

## Scene Tracker (insights)

Scene state is owned by the **immutable assistant variant** (`{ chatId, branchId, messageId, variantId }`), never by message index. All Scene targets are trimmed-ownership objects; a wrong/stale target is rejected.

### `POST /api/chats/:chatId/insights/scene/generate`

Generate **or** Update the Scene record for a target variant. One route serves both the missing-record Generate and the existing-record Update: the service overwrites only on success, so failure/parse-error/cancel never erases a valid record. Generation is strict schema-validated JSON output (the prompt's `promptFormat` controls only main-model serialization, never model free-text parsing). Returns a scoped message patch (the refreshed variant-bearing message), not a whole snapshot.

### `POST /api/chats/:chatId/insights/scene/preview`

Trial-run the full generate pipeline for a target **without persisting** — returns the candidate record for UI preview. It is non-committing and cancellable.

### `POST /api/chats/:chatId/insights/scene/edit`

Manually edit a target variant's scene state against the current DSL (`{ target, sceneState }`); the service validates strictly (schema paths, reserved segments, ranges, bounds, limits, ownership/config revision) before atomic persistence. Returns a scoped message patch.

### `DELETE /api/chats/:chatId/insights/scene`

Delete the target variant's Scene record (`{ target }` in the body). Clears the canonical column; the cache follows.

### `POST /api/chats/:chatId/insights/scene/cancel`

Explicitly cancel an in-flight generation for a target (`{ target }`). Reaches the target coordinator and **never persists** a partial/cancelled result.

### `GET /api/chats/:chatId/insights/scene/status`

Server-authoritative target status (in-flight vs settled, current record freshness). Used for reload/multi-tab hydration and edit preflight — the frontend `scene-generation-store` is only a UX hint; this endpoint is the source of truth.

### `GET /api/chats/:chatId/insights/scene/config`

Read the chat's `SceneTrackerConfig` (DSL schema, auto-mode, context/injection windows, generation/inject prompts, provider profile + model, schemaHash + revision).

### `POST /api/chats/:chatId/insights/scene/backfill/start`

Start a durable history backfill run. **Body:** `{ mode?: "fill-missing" | "rebuild" }` (default `fill-missing`). Returns the typed `SceneBackfillStatusResponse`. The run is fire-and-forget server-side and **never blocks ordinary chat**.

### `POST /api/chats/:chatId/insights/scene/backfill/:runId/status`

Poll a run's typed status (`{ runId, status, total, processed, current, errors, summary, cancelRequested }`). Used by the client for progress + reload reattach; a stale `running` row resumes the unprocessed tail after a server restart.

### `POST /api/chats/:chatId/insights/scene/backfill/:runId/cancel`

Request cancellation of a run (`cancelRequested`); the active item is not force-persisted. Returns the updated status.

### `POST /api/chats/:chatId/insights/scene/backfill/:runId/retry`

Retry a run, reprocessing **only** failed + unprocessed items (succeeded items are never regenerated). Returns the updated (running) status.

### `POST /api/chats/:chatId/insights/apply-character-template`

«Взять из персонажа» — replace this chat's Scene-tracker config and Objective state with the active character version's template, in one transaction (the config and Objective state can never land out of sync; dice and mini-apps are untouched). RP chats only — other modes get a typed `422` `not_an_rp_chat`. Returns the config-patch snapshot.

### `POST /api/chats/:chatId/insights/save-as-character-template`

«Сохранить как заготовку персонажа» — capture this chat's current tracker setup as its character's template (overwriting an existing one); the chat itself is not modified. A chat with no tracker setup gets a typed `422` `empty_tracker_setup`. Returns `{ template: TrackerTemplate }`.

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

Export a prompt trace as JSON (shows all layers, token counts, the final request messages, and the captured provider response for each model step). Non-streaming responses include the raw HTTP body when exposed by the provider; streaming responses include raw provider chunks. Diagnostic response headers such as rate-limit and request IDs are retained, while recognized credential-bearing headers are removed.

**Response:** JSON prompt trace object.

---

## Lorebooks

### `GET /api/lorebooks`

List lorebooks in a scope.

**Query:** `scopeType` (default `entity`) + `ownerId` (the character/persona/chat ID — an entity book's typed FK says which kind of owner).

### `GET /api/lorebooks/all`

List **all** lorebooks across every scope (used by the global lorebook manager).

### `GET /api/lorebooks/participating`

«Текущие»: lorebooks participating in a chat — the prompt pipeline's own binding rules (character/persona/chat bindings + links), attached-list semantics: disabled character/persona/chat books are included (the toggle is how the author turns them on); disabled global-pool-only books are excluded. 404 for an unknown chat.

**Query:** `chatId` (required)

### `POST /api/lorebooks`

Create a lorebook.

**Body:** `createLorebookSchema`

```json
{
  "name": "World Lore",
  "scopeType": "entity",
  "links": [{ "targetType": "character", "targetId": "char_1" }],
  "tokenBudget": 2048,
  "recursiveScanning": false
}
```

`links` is the explicit owner list (empty/omitted = unbound — no owner is derived from context).

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
  "scopeType": "entity",
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
  "scopeType": "entity",
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

### Co-Author per-connection generation settings

The Co-Author owns its generation set per provider connection — model, samplers, reasoning, max output, context budget — stored in `coauthor_connection_settings` (`settings` carries the complete `ModelSettingsOverlay` field set, never a partial RP inherit). `ui_settings.coauthorProviderId` stays as the app-wide binding of which connection is used; no Co-Author generation values live in `ui_settings` anymore.

| Endpoint | Body | Response |
|----------|------|----------|
| `GET /api/providers/:providerId/coauthor-settings` | — | `CoauthorConnectionSettingsRecord \| null` |
| `PUT /api/providers/:providerId/coauthor-settings` | `upsertCoauthorConnectionSettingsSchema` (`{ modelName, settings }`) | `CoauthorConnectionSettingsRecord` (upsert) |

Unknown provider ids fail closed with 404 — the Co-Author never falls back to the RP active profile.

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

## Regex Rules and Profiles

The UI terms are **Rule** and **Profile**, while the persisted domain/API name for a Rule remains `RegexPreset` for compatibility.
Regex scope accepts character and prompt-preset targets only; persona is not a Regex target.

### `GET /api/regex/presets/all`

List all Regex Rules across every scope, including Profile members.

### `GET /api/regex/presets/:id`

Get one Regex Rule, or 404 when it does not exist.

### `POST /api/regex/presets`

Create one Rule with `createRegexPresetSchema`.

```json
{
  "name": "Strip narration markers",
  "findRegex": "/\\*([^*]+)\\*/g",
  "replaceString": "$1",
  "disabled": true,
  "placement": [2],
  "isGlobal": false,
  "profileId": "regex_profile_1"
}
```

`profileId` is optional and lets a valid manual draft be born directly inside an existing Profile.
Omitted or `null` means Standalone.
Imports with multiple Rules use the atomic bundle route instead.

### `PATCH /api/regex/presets/:id`

Update one Rule with `updateRegexPresetSchema`.
Profile membership is not patched through this route; use attach/detach.

### `DELETE /api/regex/presets/:id`

Delete one Rule and cascade its junction links.

### `GET /api/regex/presets/:id/links`

List the Rule's stored character/prompt-preset links.
For a Profile member these links remain stored but are dormant until detach.

### `PUT /api/regex/presets/:id/links`

Replace all stored Rule links.

**Body:** `{ "links": [{ "targetType": "character" | "preset", "targetId": "..." }] }`

### `GET /api/regex/resolve-active`

Resolve enabled Rules visible in one generation context.

**Query:** optional `characterId` and `presetId`.

Standalone global/direct-link reachability and Profile-gated membership are deduplicated in deterministic order.
Placement and depth filtering happen later at the Regex application hook.

### `GET /api/regex/profiles/all`

List all Regex Profiles.

### `GET /api/regex/profiles/:id`

Get one Profile, or 404 when it does not exist.

### `POST /api/regex/profiles`

Create an empty Profile with `createRegexProfileSchema`.
Rules can later join through attach or direct Rule creation.

### `PATCH /api/regex/profiles/:id`

Update Profile name, master `disabled` state, global scope, or sort order with `updateRegexProfileSchema`.

### `DELETE /api/regex/profiles/:id`

Delete a Profile.

**Query:** `mode=keep|cascade` (default `keep`).

`keep` detaches surviving members to Standalone; `cascade` deletes the member Rules with the Profile.

### `POST /api/regex/profiles/bundle`

Create a complete Profile, its scope links, and one or more member Rules atomically.
This is the only new create route required by the bundle import workflow; ordinary Rule/Profile CRUD, links, and membership continue to reuse the endpoints in this section.

**Body:** `createRegexProfileBundleSchema`

```json
{
  "name": "Imported Celia Regex",
  "disabled": true,
  "isGlobal": false,
  "links": [
    { "targetType": "preset", "targetId": "preset_1" }
  ],
  "rules": [
    {
      "name": "Strip narration markers",
      "findRegex": "/\\*([^*]+)\\*/g",
      "replaceString": "$1",
      "disabled": false
    }
  ]
}
```

`disabled` is required for the Profile because the caller must resolve the **Enable Profile after import** choice explicitly.
Each Rule keeps its own source `disabled` value and must omit `profileId`, because membership is owned by the bundle.
A global Profile must have no links; non-global links accept character/preset targets only.
The transaction inserts every Rule with the new Profile ID and returns `{ profile, rules }` only after commit; any Profile, link, or Rule failure rolls back all bundle rows.

### `POST /api/regex/profiles/:id/attach`

Move an existing Rule into the Profile.
Exclusive membership means this also moves a Rule from another Profile when invoked by an authorized workflow.

**Body:** `{ "ruleId": "regex_rule_1" }`

### `POST /api/regex/presets/:id/detach`

Move a member Rule to Standalone while preserving its own stored global/link scope.

### `GET /api/regex/profiles/:id/members`

Return the Profile's member Rule IDs in deterministic order.

### `GET /api/regex/profiles/:id/links`

List the Profile's character/prompt-preset links.

### `PUT /api/regex/profiles/:id/links`

Replace all Profile links.

**Body:** `{ "links": [{ "targetType": "character" | "preset", "targetId": "..." }] }`

Prompt-preset and standalone-file import UIs call the bundle route after client-side parsing and preview.
Character-card import reaches the same atomic store operation through `POST /api/import/json`, where the server owns failure containment.

---

## Scripts

### `GET /api/scripts`

List all scripts (with scope information).

### `GET /api/scripts/all`

List **all** scripts across every scope (used by the global script manager).

### `GET /api/scripts/participating`

«Текущие» script counterpart: prompt- and dice-kind scripts participating in a chat — the script runtime's own binding rules, attached-list semantics (mirrors the lorebook participating route). 404 for an unknown chat.

**Query:** `chatId` (required)

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
  "scopeType": "entity",
  "links": [{ "targetType": "character", "targetId": "char_1" }],
  "enabled": true,
  "sortOrder": 0
}
```

`links` is the explicit owner list (empty/omitted = unbound — no owner is derived from context).

### `PATCH /api/scripts/:scriptId`

Update a script.

**Body:** `updateScriptSchema` (all fields optional)

### `DELETE /api/scripts/:scriptId`

Delete a script.

### `POST /api/scripts/:scriptId/test`

Test a script with simulated context. The optional `code` field overrides the stored source for this run only, so authoring UIs can execute an unsaved buffer without persisting it.

**Body:** `testScriptSchema`

```json
{
  "code": "context.character.personality += '\nTest draft';",
  "messages": [
    { "role": "user", "content": "Hello!" },
    { "role": "assistant", "content": "Hi there!" }
  ],
  "characterName": "Aria",
  "lastMessage": "Hi there!"
}
```

**Response:** `{ output: any, error?: string, mutations?: object }`

### `GET /api/scripts/:scriptId/agent-plan`

The script-owned agent plan (`EXPERIENCE_COPILOT_PLAN_MODE_PLAN`). Returns `{ plan }` — the stored plan, or the empty plan (`{ goal: "", constraints: [], tasks: [] }`) when none is stored yet. The plan is shared by the copilot's `plan`/`read_plan` tools and the user-facing plan editor; it is NOT part of the copilot thread wire.

### `PUT /api/scripts/:scriptId/agent-plan`

Full-replace write of the plan. Runs the same `normalizeAgentPlan` validation as the `plan` tool: two `active` tasks are rejected with a typed `422` (ambiguous active task). **Body:** `{ plan: agentPlanSchema }` — **Response:** `{ plan }` (the normalized plan).

### `POST /api/scripts/import`

Import a script from JS code or JSON.

**Body:** `importScriptSchema`

```json
{
  "format": "js",
  "code": "// Script code here",
  "name": "Imported Script",
  "scopeType": "entity",
  "characterId": "char_1"
}
```

---

## AI Assistant

The AI Assistant subsystem (the lightbulb "assist" actions in the Build editor) is mounted as the `ai-assistant` [FeatureModule](./backend.md#feature-modules--lifecycle). These replaced the old `POST /api/scripts/ai-assistant` route.

### `POST /api/ai-assistant`

Run an AI Assistant mode and stream the result. The mode selects what to generate: `lore_entry`, `lore_keys`, `chat_impersonate`, `md_import`, `scene_schema`, `scene_rules`, `message_edit`, `message_merge`, `message_tts_annotate`, `regex` (plus backend-only `vision_describe`, which drives the attachment-description pipeline, not the modal); see [AI Assistant](./backend.md#ai-assistant) for the mode table and prompt fallback chain.

**Response:** `text/event-stream`. Events are mode-dependent: text modes stream `text-delta` chunks; JSON modes (`lore_keys`, `md_import`, `scene_schema`, `regex`) buffer, strip reasoning, parse against the mode schema, then emit the parsed result.

### `POST /api/ai-assistant/tokens`

Count tokens for an AI Assistant request before running it (context-budget preview for the modal).

---

## Experience Try Tab (unsaved-source tester)

Stateless endpoints that drive UNSAVED rules source through the real sandbox/kernel (no session, store, or chat binding). Typed failures are 422 (409 `stale_revision`) with `error.details.{code,kind,console}`.

| Endpoint | Purpose |
|---|---|
| `POST /api/experience/test/discover` | Discover-only: `{ rulesCode, scriptName? }` (strict) → `{ definition }` (same shape as `/test/run`'s `definition`); never runs `create`, grants nothing — the Try tab derives grants / roster / setup fields from it |
| `POST /api/experience/test/run` | Discover + `create` (with the request's `capabilityGrants`) + project + replay `actions` |
| `POST /api/experience/test/simulate` | Discover + `create`, then a bounded script-seat simulation |

---

## Experience Copilot

The authoring assistant for interactive experiences. Architecture: [Experience Copilot](./experience-copilot.md). All bodies/responses validate against `packages/api-contracts/src/schemas/experience-copilot-schema.ts`. Threads of ALL THREE kinds use these per-thread endpoints; each request resolves the thread to its kind through the stored `agent_kind` first (chat-owned threads), else through its script row (draft threads resolve to `experience`) — see [Agent Shell](./agent-shell.md). Script-owned sessions (both kinds) use the script lifecycle below; chat-owned sessions use the [chat-owned routes](#chat-owned-agents-sidechat).

### Sessions

| Endpoint | Purpose |
|---|---|
| `GET /api/experience-copilot/script/:scriptId/active` | The active thread (id + wire snapshot: title, step, `todo`, context fields) or `null` |
| `POST /api/experience-copilot/script/:scriptId/session` | Start a new session for the script (archives the current one); optional body `{ title? }` |
| `GET /api/experience-copilot/script/:scriptId/sessions` | Session list for the switcher |
| `POST /api/experience-copilot/:threadId/activate` | Make an archived thread active |
| `POST /api/experience-copilot/:threadId/archive` | Archive a thread |
| `PATCH /api/experience-copilot/:threadId/title` | Rename (`{ title }`, max 120) |
| `GET /api/experience-copilot/:threadId/messages` | Message history (user / assistant / tool rows, activities keyed by toolCallId) |

The thread wire's `todo` is REQUIRED (`CopilotTodoItem[]`, `[]` = no checklist yet) — the model's session-scoped quick checklist (PM-7), full-list-rewrite semantics; the model owns it, the UI renders it read-only. The durable plan is NOT on the thread wire — it is script-owned and served by [`GET`/`PUT /api/scripts/:scriptId/agent-plan`](#get-apiscriptsscriptidagent-plan) (`EXPERIENCE_COPILOT_PLAN_MODE_PLAN`).

### Stream

`POST /api/experience-copilot/:threadId/stream` — **Response:** `text/event-stream` with numbered event IDs.
Events include `text-delta`, `reasoning-delta`, `tool-call`, `tool-result`, `reasoning-done`, `finish`, `abort`, `error`; the shared transport keeps its heartbeat during long thinking.
Client disconnect only unsubscribes; the server completes and persists the turn.
A competing start returns 409 `{ error: string, code: "AGENT_RUN_ACTIVE" }` before SSE.

| Endpoint | Body/query | Response |
|---|---|---|
| `GET /api/experience-copilot/:threadId/run` | `after` non-negative safe integer, default `0` | Numbered replay/live SSE, or 204 if no retained run |
| `POST /api/experience-copilot/:threadId/stop` | — | `{ stopped: boolean }` |
| `GET /api/experience-copilot/:threadId/review` | — | Canonical v2 review envelope or `null` |
| `PUT /api/experience-copilot/:threadId/review` | `agentReviewEnvelopeSchema` | Validated full replacement envelope |
| `DELETE /api/experience-copilot/:threadId/review` | — | `{ ok: true }` |

The log remains until the thread's next start or process restart; a new browser projection rebuilds from cursor zero without another send or checkpoint.
Producers persist finalized buffer proposals and their review base/progress before terminal delivery, even without a subscriber; no-proposal turns leave an existing review intact.
These review routes cover the mini-app and script buffers; record proposals retain their existing explicit apply/reject endpoints.

**Body** (exactly one of `content` / `answer`):

```json
{
  "content": "make gravity speed up over time",
  "providerProfileId": "...", "model": "...",
  "step": "rules",
  "rules": "<live draft>", "visual": "<live draft>",
  "code": "<live draft (script kind)>",
  "testFeedback": { }
}
```

or the **answer mode** (split-turn resume — the answer continues the logical turn, no user row is appended; the awaiting `ask_user` tool-result row is rewritten in place):

```json
{ "answer": { "toolCallId": "...", "text": "yes, use the keyboard" }, "providerProfileId": "..." }
```

`answer` carries exactly one of `text` / `skipped` (a skip carries no text) — the `ask_user` family — or `decision: "allow" | "deny"` — the permission family (SC-23e): a sidechat `read_message_prompt` call that stopped the turn on its `awaiting_permission` marker is resumed by the decision, `allow` rewriting the row with the rendered `<rp_prompt>` result, `deny` with `{ status: "denied" }`. **DMT-11 extends the permission answer with an optional `instruction` (1–50 000 chars)** — the user-edited one-shot text for the Director's `request_message_swipe` family: on `allow` the edited text replaces the recorded draft and EXACTLY ONE ordinary branch-pinned RP regeneration runs with it as a request-local prompt layer (the stored receipt carries the final approved text; a deny carrying an `instruction` is rejected by the schema, and a prompt-read allow with one is refused by the stream — the family is thread state, so the field cannot turn a prompt read into a swipe). The `rules`/`visual`/`code` drafts are the editors' current unsaved sources — the backend prefers them over last-persisted buffers so the agent is never blind to in-progress edits. The experience kind reads `rules`/`visual` (plus `rulesSaved`/`visualSaved`, `step`, `testFeedback`, `launchContext`, `reviewSnapshot`); the script kind reads `code` (plus `codeSaved`) and treats `scriptKind` as advisory telemetry — the STORED script kind selects the API-knowledge section. Both share `content`/`answer` and the provider/model pair. A chat-owned `sidechat-ooc` thread additionally reads `attachedVariants` (see [the sidechat stream field](#stream-field-sidechat-threads)).

### Kind errors (stream assert + compact)

The stream route resolves the thread's kind BEFORE sending SSE headers, and the compact route resolves it before compacting; all three registry failures return the same HTTP 400 JSON (`{ error, code }`), never an in-stream error or a 500.

| `code` | When |
|---|---|
| `NO_AGENT_KIND_FOR_SCRIPT_KIND` | the thread's script kind is served by no registered kind |
| `UNKNOWN_AGENT_KIND` | the resolved kind id (including the draft fallback) is not a registered kind |
| `AGENT_KIND_NOT_WIRED` | the kind is registered but has no `stream` / `compaction` adapter entry (the error names its table) |

### Context

| Endpoint | Purpose |
|---|---|
| `GET /api/experience-copilot/:threadId/context` | Context-meter metrics + auto-compact flag |
| `PATCH /api/experience-copilot/:threadId/context` | `{ autoCompact?: boolean }` |
| `GET /api/experience-copilot/:threadId/context-links` | Pinned context entities |
| `PATCH /api/experience-copilot/:threadId/context-links` | Set links (`setCopilotContextLinksSchema`) — resolved by id at assembly time, never stored copies. `prompt_preset` links (SC-23c, the sidechat's `<rp_prompt>` view) are chat-owned-thread-only: a script/draft thread gets the typed 400 `preset_link_not_chat_owned` |
| `POST /api/experience-copilot/:threadId/compact` | Manual compaction; optional `{ providerProfileId?, model? }` (defaults to the thread's last pair) |

### Message attachments

Agent messages carry attachments in the row's `attachments_json` (one `ADD COLUMN` migration; no join table). The action surface mirrors the chat's, over the same domain service (`domain/attachment/attachment-actions-service.ts`) — each adapter resolves message ownership (reference check via `json_each` over `attachments_json`) and persists only the patch:

| Endpoint | Purpose |
|---|---|
| `POST …/messages/:messageId/attachments/:attachmentId/summarize` | Text-file summary; optional `{ providerProfileId?, model? }` — the profile ladder defaults to the thread's last pair. Errors as the chat twin (`attachment_not_text` 400, `attachment_asset_missing`/404, `attachment_summary_empty` 400). Response: the updated attachment |
| `POST …/attachments/:attachmentId/clear-summary` | Drop the summary; response: the updated attachment |
| `PATCH …/attachments/:attachmentId/description` | Hand-edit an image/video caption (lightbox); response: the updated attachment |
| `POST …/attachments/:attachmentId/regenerate-description` | Force re-describe an image/video (chat-twin rules over the agent store; needs a `visionModel`). Response: `{ description }` |
| `PATCH …/attachments/:attachmentId/include-in-prompt` | Prompt-visibility toggle; response: `{ ok: true }` |
| `DELETE …/attachments/:attachmentId` | Remove an attachment and delete its now-unreferenced asset file; response: `{ ok: true }` |

Turn deletion (`POST /api/experience-copilot/:threadId/turns/delete`) takes `keepAttachmentFiles` to spare assets the user may re-attach.

### Profiles

CRUD under `/api/copilot/profiles` (see the copilot profile schemas); `?kind=` selects the kind (`experience` default) on every route, and an unknown kind is a 400 carrying `UNKNOWN_AGENT_KIND`. User profiles carry `basePrompt` + `toolSet` toggles validated against the owning kind's registered schema (a wrong-kind set is a 422 `copilot_profile_invalid_tool_set`): the experience keys are the 9 `copilotToolSetSchema` keys (`write_buffer`, `edit_buffer`, `run_test`, `run_simulate`, `suggest_visual_binding`, `plan`, `read_plan`, `todo`, `ask_user`); the script keys are the 6 `scriptAgentToolSetSchema` keys (`write_buffer`, `edit_buffer`, `run_script_test`, `plan`, `read_plan`, `ask_user`); the sidechat keys are the 9 `sidechatOocToolSetSchema` keys (`search_context`, `read_context_item`, `propose_objective`, `todo`, `read_plan`, `read_message_prompt`, `propose_plan`, `propose_tracker_template`, `ask_user` — the last three director-era toggles, on only in the `builtin-director` seed's default set). `read_skill_file` is in neither script/experience set (always on, never gated); `skillIds` was retired in PM-8 (skills are ungated; a payload carrying it is strict-rejected, as is any unknown key). A stored `todo: true` projects to `todo: true` and nothing else (the PM-2 alias onto `plan`+`read_plan` was removed with the todo mechanic's restoration in PM-7). Every built-in seed id is read-only (400 on update/delete); a kind's built-ins are listed first, in declared order (the sidechat kind ships `builtin` and `builtin-director`), before its user rows. `POST` accepts an optional `sourceBuiltinId` (DR-7b: provenance — the built-in this duplicate came from); it must name a built-in seed of the SAME kind, anything else is a 422 `copilot_profile_invalid_source_builtin`, and the field is immutable after create (the update contract omits it, so a PATCH smuggling it is strict-rejected). There is no step-limit field — the tool loop is unbounded (see the architecture doc).

### Skills

Per-kind skill libraries under `/api/copilot/skills` (mirroring the profile routes); `?kind=` selects the kind (`experience` default) on every route, and an unknown kind is a 400 carrying `UNKNOWN_AGENT_KIND`. `GET /api/copilot/skills` lists the merged built-in + user catalog (metadata only, no file bodies); `GET /api/copilot/skills/:id` reads one entry (404 when absent); `POST /api/copilot/skills/import` uploads a multipart skill where each file part's field name is its relative path (e.g. `my-skill/SKILL.md`) and returns 201; `DELETE /api/copilot/skills/:id` removes one user skill directory (a pure built-in is rejected). `GET /api/copilot/skills/:id/content` (AP-21; the Co-Author routes expose the identical endpoint at `/api/coauthor/skills/:id/content`) returns the full content view `{ id, path, content, body, files }` — `content` is the raw manifest read through the sandboxed `readSkillFile` (user shadow first, so a shadowed skill returns the USER's file), `body` is the same text with its frontmatter block stripped (the skill editor's text view), and `files` are the winning folder's POSIX-style relative file paths with the manifest itself excluded (it is already `content`/`body`); a missing skill (or an unreadable manifest) is a 404, and no absolute filesystem path crosses the wire. `POST /api/copilot/skills` and `PUT /api/copilot/skills/:id` (AP-23a; the Co-Author routes expose the identical pair under `/api/coauthor/skills`) save a user skill with the JSON body `{ name, description, body }`: create derives the folder id from the name (Cyrillic transliterated, lowercased, hyphenated, de-duplicated with `-2`/`-3` suffixes against both roots so a create never shadows a built-in) and writes a minimal manifest; update rewrites ONLY that user skill's `SKILL.md`, rebuilding the frontmatter from the existing block with every key kept and only `name`/`description` replaced, leaving `references/`/`assets/` untouched. Both paths validate the assembled manifest before any write (an invalid save writes nothing — 400); a built-in id on update is a 409 Conflict (built-ins are read-only; the duplicate flow is the user's path), a missing id is a 404, and both routes return the fresh catalog-entry DTO (201 on create, 200 on update).

---

## Chat-Owned Agents (sidechat)

The chat-owned arm of the agent shell: agent threads owned by a chat branch instead of a script, with `sidechat-ooc` (the RP-chat sidechat) the first kind. Architecture: [Agent Shell](./agent-shell.md). Chat-owned threads ride the owner-agnostic per-thread routes above (`/api/experience-copilot/:threadId/...`, dispatched to their kind through the stored `agent_kind`); the routes below are the chat/branch-scoped families, all under `/api/agent/`.

### Sessions

| Endpoint | Purpose |
|---|---|
| `GET /api/agent/chats/:chatId/branches/:branchId/:kind/active` | The kind's active thread on that branch, or `null` |
| `GET /api/agent/chats/:chatId/branches/:branchId/:kind/sessions` | Session list for the switcher (`[]` when the chat's mode is not served) |
| `POST /api/agent/chats/:chatId/branches/:branchId/:kind/session` | Start a new session (archives same-owner siblings); optional body `{ title? }` |

The `:kind` segment is validated through the agent-kind registry: an unregistered kind is a 400 `UNKNOWN_AGENT_KIND`, a script-owned kind a 400 `AGENT_KIND_NOT_CHAT_OWNED`, and a chat-owned kind on a chat whose mode it does not serve a 400 `AGENT_KIND_MODE_NOT_SERVED` — all the same `{ error, code }` JSON shape. A missing chat, a missing branch, or a branch of another chat is a 404.

### Kind settings (model + default profile)

| Endpoint | Purpose |
|---|---|
| `GET /api/agent/kinds/:kind/settings` | The kind's remembered model binding + profile default |
| `PATCH /api/agent/kinds/:kind/settings` | Partial write; `.strict()` body |

**GET response:** `{ agentKind, providerProfileId, modelName, defaultProfileId, autoCompactDefault, updatedAt, servesChatModes }` (nullable fields are `null`, never `undefined`). **PATCH body:** `{ providerProfileId?, modelName?, defaultProfileId?, autoCompactDefault? }` — absent keeps the stored value, `null` clears one. Every registered kind is addressable (script- and chat-owned alike); an unregistered kind is a 400 `UNKNOWN_AGENT_KIND`.
The binding is a remembered UI default, not a server override — the stream keeps taking provider/model per request. A kind with no row reads the legacy shared copilot pair ONLY if it is one of the two pre-split kinds (`experience`, `script`); every later kind reads nulls so its host's default model applies. `servesChatModes` is a registry fact carried on the wire (also in the bootstrap payload's per-kind map), never patched. `autoCompactDefault` (AP-20) is the kind's default for the auto-compact toggle on NEW sessions — non-nullable on the wire (the stored `NULL` = on resolves to `true`, the pre-AP-20 behavior); both new-session paths copy it onto the created thread's `auto_compact`, after which the per-thread toggle is authoritative.

### Profile own model (M1)

Any profile — built-ins included — may carry its own model choice (DIRECTOR_MODE_PLAN DR-2 / owner ruling 2026-10-25, M1 — see DIRECTOR_MODE_PLAN.md; the owner's RU quote lives in the plan repo, not here), stored per `(agent_kind, profile_id)` because built-in seed ids are kind-scoped:

| Endpoint | Purpose |
|---|---|
| `GET /api/agent/kinds/:kind/profiles/:profileId/model` | Read the binding — `{ model: null }` means no own model ("same as sidechat" in DR-8's labels; no row) |
| `PUT /api/agent/kinds/:kind/profiles/:profileId/model` | Set/replace the whole binding; `.strict()` body |
| `DELETE /api/agent/kinds/:kind/profiles/:profileId/model` | Clear (back to "same as sidechat"); idempotent |

**PUT body:** `{ providerProfileId: string, modelName?: string | null }` — `modelName` absent/`null` pins the provider's default model (resolved at turn time). **GET/PUT response:** `{ model: { providerProfileId, modelName } | null }`.
The model is a setting, not an edit: set/clear is served for the kind's built-in seed ids too (the read-only guard protects a built-in's prompt/tools only). The `(kind, id)` pair must address a declared seed of the kind or a user row of the kind — a foreign kind's built-in, another kind's profile, or a dangling user id is a 404; an unknown kind is the family's 400 `UNKNOWN_AGENT_KIND`. The provider link is soft (no FK): a dangling id stores fine and the stream falls through to the request's pair at turn time. Deleting a user profile removes its model row with it.
The stream's model chain with M1, one line: the resolved profile's own model (this table, applied server-side where the per-turn profile resolves) → the request's pair (the kind binding above, derived client-side by the web binding hook) → the provider's default model. With no stored own model every kind resolves exactly as before.

### Chat settings (profile choice per chat)

| Endpoint | Purpose |
|---|---|
| `GET /api/agent/chats/:chatId/:kind/settings` | The chat's own profile choice for that kind |
| `PATCH /api/agent/chats/:chatId/:kind/settings` | Partial write; `.strict()` body |

**GET response:** `{ chatId, agentKind, profileId, updatedAt }` (`profileId`/`updatedAt` `null` on a pair with no row). **PATCH body:** `{ profileId? }` — `null` clears the choice (follow the kind default), a built-in seed id of the kind (the first is always the sentinel `"builtin"`) pins that seed for this chat; a built-in id of ANOTHER kind falls through like a dangling id. The stream's chat-owned profile chain: chat row → kind default → the kind's first built-in; a dangling id falls through, never errors. A PATCH that changes the EFFECTIVE profile writes the frozen `profile_changed` event into every active thread's feed (or parks it for the next session, migration 0129) — see [Thread events](#thread-events); re-pinning the same effective profile writes nothing. Kind errors as above; a missing chat is a 404.

### Branch plan

| Endpoint | Purpose |
|---|---|
| `GET /api/agent/chats/:chatId/branches/:branchId/plan` | `{ plan }` — the stored branch plan, or the empty plan when none is stored yet |
| `PUT /api/agent/chats/:chatId/branches/:branchId/plan` | Full-replace write (`{ plan }`), same validation as the script plan; on the ACTIVE branch it also drives the goal tracker (see below) |

The chat-branch twin of [`GET`/`PUT /api/scripts/:scriptId/agent-plan`](#get-apiscriptsscriptidagent-plan): two `active` tasks are a 422 `agent_plan_multiple_active`, an unusable shape a 422 `agent_plan_invalid`; a missing chat/branch (or a branch of another chat) is a 404. The sidechat kind reads this plan read-only through its `read_plan` tool — no sidechat tool writes the plan directly (the director proposes; Accept applies through the proposals route below). Since DR-3 the PUT routes through the story-plan sync's `applyPlan`: on the chat's ACTIVE branch the save projects the events onto the goal tracker (goals mode, tracker on when events exist); a non-active branch saves without touching the tracker.

### Story deck

The per-branch twist-deck twin of the branch plan (DIRECTOR_DECK_CALENDAR_PLAN): the `story_branch_decks` table (`packages/db/src/db-schema.ts`) holds one row per (chat, branch) — both columns hard FKs with cascade, the deck JSON in `content_json` — and a missing row reads as the empty deck. The domain shape is `StoryDeck`/`StoryCard` (`packages/domain/src/story-deck.ts`: five fixed suits `threat` / `encounter` / `discovery` / `mystery` / `change`); the wire contract is `storyDeckSchema` (`packages/api-contracts/src/schemas/story-deck-schema.ts`). Routes in `services/api/src/api/routes/agent-branch-deck.ts`, the plan routes' shared ownership check (`chat-branch-ownership.ts`) on all three; a missing chat/branch (or a branch of another chat) is a 404.

| Endpoint | Body | Response / behavior |
|---|---|---|
| `GET /api/agent/chats/:chatId/branches/:branchId/deck` | — | `{ deck }` — the stored deck, or `{ cards: [] }` when none is stored yet |
| `PUT /api/agent/chats/:chatId/branches/:branchId/deck` | `{ deck: storyDeckSchema }` (STRICT — a bad shape is a 400, not the plan route's normalize-or-422: no model feeds the deck) | `{ deck }` as saved; the empty deck is a valid write |
| `POST /api/agent/chats/:chatId/branches/:branchId/deck/:cardId/play` | `{ replaceForeignGoals?: boolean }` (`storyDeckPlaySchema`, STRICT) | `{ deck, event }` — the deck after the card's removal plus the played (promoted) plan event |

The play route (DK-4a) routes through `StoryPlanSync.playCard` (`services/api/src/domain/director/story-plan-sync.ts`): the card leaves the deck exactly once and enters the branch plan as a NEW event that is promoted to the CURRENT event — the interrupted active event turns pending directly after it, so the RP model reads the played card with its next reply; a branch with no plan gets a one-event plan. An unknown `cardId` is a 404 before any write. The typed 409 `story_deck_foreign_goals` (body `details` also carries `foreignGoalCount`) answers a play on a branch with no plan whose goal tracker holds goals not from a plan — the projection would silently replace them; the caller retries the same request with `{ replaceForeignGoals: true }` to accept the replacement. The deck write and the plan write are one transaction (see [backend](./backend.md#plan-driven-goals-story-plan--tracker-sync)).

### Thread events

`GET /api/agent/threads/:threadId/events` — for a chat-owned thread, its frozen context events in merged-timeline order, each `{ id, kind, payload, beforeMessageId }`.
`kind` is one of `rp_sync` / `variants_attached` / `selection_changed` / `branch_forked` / `profile_changed`; `payload` is the event mapped through the same parser the sidechat context loader uses (a corrupt stored payload surfaces as an error, never a silent skip); since SC-23a the `rp_sync` / `variants_attached` / `selection_changed` payloads additionally carry the frozen generation provenance — nullable `model` / `preset` (and `number` on variants) — where `null` means unknown, because the provenance is what was frozen at the time and is never inferred (events frozen before SC-23a parse and render exactly as before); `beforeMessageId` anchors each event to the first message row after it on the merged timeline, `null` when the event is the newest row — the web interleaves separators without a `seq` on the message wire (the shared messages route above is unchanged). `profile_changed` (DR-12) carries `{ from: { id, name }, to: { id, name } }` — the profile ids plus display names frozen at write time — and is user-feed provenance only: the context loader and the compaction service skip it, and only this route serves it (it survives reloads here). A script-owned or draft thread answers `[]`; a missing thread is a 404.

### Feed paging (windowed history)

The additive paged reads the virtualized agent feed rides (AFP, release 1.5.1); the legacy full-list routes above are unchanged and remain what prompt assembly, compaction and replay consume.

| Endpoint | Purpose |
|---|---|
| `GET /api/agent/threads/:threadId/feed` | ONE coherent windowed page of the merged message+event timeline |
| `GET /api/agent/threads/:threadId/events/:eventId` | One bounded slice of an immutable frozen event detail |

**Feed query** — mutually exclusive modes, one per request: none (newest window, default limit 100 primary records), `before` (older page below an opaque cursor, default 40), `after` (bridge page above a cursor, default 40), `aroundMessageId` (a bounded neighborhood of one message — the search plan's seam, never a walk from the beginning). `limit` is an explicit 1..200 override (rejected, never clamped). Positions and cursors follow the canonical merged-timeline order (chat-owned `seq` with the legacy NULL-seq prefix first, then `createdAt`, then `id`, message-before-event as the final tie); cursors are versioned opaque keysets carrying thread/epoch ownership.

**Feed response** — `{ threadId, historyEpoch, head, range{oldest,newest}, messages[], events[], hasOlder, hasNewer, cursors{before,after}, boundary }`: legacy per-message wire rows, TEXT-FREE event summaries (kind, ordering/placement, counts, frozen labels, `detailAvailable`) in the same logical range as the messages (event-only intervals and trailing events included), coverage flags equivalent to the adjacent cursors, and a boundary block with partial-turn flags, turn opener, split tool pairs, thread-scoped last user and digest coverage facts (the loaded/unloaded/dangling anchor tri-state) so a cut page never corrupts turn state. A typed 409 `AGENT_FEED_STALE_WINDOW` (current `historyEpoch` in the body) answers a cursor whose epoch died under an invalidating write — the client revalidates instead of restarting silently; a malformed/foreign cursor is a 400; a missing thread is a 404.

**Detail query** — the immutable frozen body of ONE event, scoped to its owning thread, paged: first request (no cursor) returns the first `50` items plus `nextCursor`; each continuation echoes that cursor for the next slice. Responses carry the event's epoch/version; a 409 `AGENT_EVENT_CURSOR_STALE` names the current epoch, 404/422 cover missing/wrong-thread and corrupt sources. Frozen snapshots are exact history — editing, swiping or deleting the RP source never rewrites them.

### Record proposals (apply / reject)

| Endpoint | Purpose |
|---|---|
| `POST /api/agent/threads/:threadId/proposals/:toolCallId/apply` | Accept a pending sidechat record proposal |
| `POST /api/agent/threads/:threadId/proposals/:toolCallId/reject` | Reject it (its domain data untouched) |

Six record types resolve today, dispatched through ONE registry by `recordType` (`SIDECHAT_RECORD_PROPOSAL_REGISTRY`, `domain/sidechat/sidechat-objective-proposal.ts`; an unknown `recordType` is the typed 422 `unknown_proposal_record_type`, refused before any write):

- `objective` (`propose_objective`) — as before while the active branch has no plan with events: apply reads the tracker at Accept time (tracker off → the 409 `objective_tracker_disabled`; mode `route` adds a task, mode `goals` a short-term goal). Under a plan with events, apply inserts the goal as the NEXT PLAN EVENT instead (right after the current one; never a tracker item) and the response carries the refreshed plan beside the proposal.
- `story-plan` (`propose_plan`) — apply runs the story-plan sync's `applyPlan` on the proposal's target branch (normalize-or-422, save, ACTIVE-branch projection; response `{ plan }`); an apply body `{ enableAutoCheck: true }` also sets the tracker's auto-check frequency to 1.
- `tracker-scene` (`propose_tracker_template`) — apply writes the generated scene half with the objective half nulled (response carries the insights patch); goals come from the plan. A payload carrying `withClock: true` (DK-5a) first extends the scene schema with the canonical story-clock fields through the domain's `withStoryClockFields` — never duplicating a marked field the schema already has.
- `story-deck` (`propose_deck`, DK-5a) — apply validates the payload with the registry's `matches` parse gate and appends the proposed twist cards to the target branch's deck (the payload's `targetId`) with FRESH ids — the model's proposed ids are never reused; suit/title/body ride verbatim. No wire companion (the bare `{ proposal }` response); reject writes only the row's status.
- `message-edit` (`propose_message_edit`, DMT-22) — apply runs the ordinary guarded chat edit over the proposal's frozen source identity on the thread's own branch: the transactional selected-variant + reviewed-base guards refuse a moved selection, a newer edit to the same swipe, a deleted target or a foreign-chat message (the typed 409s / 404), and nothing is written on such a refusal (the row stays pending).
- `message-variant` (`propose_message_variant`, DMT-22) — apply appends and selects a separate swipe through the ordinary add-variant path with DIRECTOR authorship (no model/preset provenance, no prompt trace attached), with the same source/ownership refusals; reject writes only the row's status for both message types.

Body-less except `story-plan`'s optional `{ enableAutoCheck }`; the proposal payload lives in the addressed tool row. The thread must be a chat-owned `sidechat-ooc` thread and the `toolCallId` a proposal row of it — anything else (missing, foreign, non-proposal) is a 404. Only a `pending` proposal resolves: a second apply/reject (double click, second tab) is the 409 `objective_proposal_already_resolved`. **Response:** `{ proposal }` — the record proposal with its final `status` (`applied` / `rejected`), also written back into the tool row so a reload shows the resolution (plus the type's companion data: the refreshed `plan` for `objective`-under-a-plan and `story-plan`, the insights `patch` for `tracker-scene`, and — DMT-22, on an ACCEPTED `message-edit` / `message-variant` resolution only — the optional `message` companion `{ chatId, branchId, message, variants }`: the affected message row + its FULL post-write variant list scoped by chat/branch, so a client merges it into exactly its named message (the canonical ingest refuses a different open conversation or an unloaded message) instead of refetching the whole chat; a rejected message proposal carries no `message`).

### Branch sidechat fork + summary

| Endpoint | Purpose |
|---|---|
| `POST /api/agent/chats/:chatId/branches/:branchId/fork-sidechat` | Copy the branch's ACTIVE sidechat threads + branch plan + story deck onto the target branch |
| `GET /api/agent/chats/:chatId/branches/:branchId/sidechat-summary` | `{ hasSessions, count }` — ACTIVE chat-owned sessions on the branch, for the fork/delete confirms |

**Fork body:** `{ targetBranchId }`. **Response:** `{ copiedThreads: [{ threadId, agentKind }] }` — the kinds the store actually had ACTIVE source threads for. The fork point comes from the target branch row (`parent_branch_id` must name the source): a target that is not a child is the 400 `target_branch_not_child_of_source`, a target that already has an active same-kind thread the 400 `target_branch_thread_active` (nothing is copied, the existing conversation stays). The copy re-keys id references onto the fork's new message ids, so the copy's first RP sync appends nothing for the copied history; frozen text is untouched. The story deck copies under the same rules as the plan (DK-3): a source with no deck row copies nothing, a stored deck — an empty one included — copies verbatim. A missing chat/branch on either side is a 404.

### Stream field (sidechat threads)

`POST /api/experience-copilot/:threadId/stream` gains `attachedVariants?: Array<{ messageId, variantId }>` — RP variants attached to this sidechat turn as plain pairs; only the `sidechat-ooc` kind reads the field (the other kinds ignore it entirely). The request never carries a `selected` marker — the server reads the RP's own selection at freeze time. A message or variant outside the thread's own chat + branch is the typed 400 `attached_variant_not_in_branch` and nothing is frozen (the user message is not persisted). The pinned-context `PATCH /api/experience-copilot/:threadId/context-links` is reused as-is for the sidechat's `@` pins (characters, personas, lorebooks, scripts, skills), resolved by id at assembly time like every kind's.

---

## Assets

### `POST /api/assets/upload`

Upload an asset (image, audio, or a text file — avatars, gallery images, voice notes, chat-attached files).

**Body:** `multipart/form-data` with file field.

**Response:** `{ assetId: string, url: string, tokenCount?: number }` — `tokenCount` is present only for text files: the server UTF-8-decodes the bytes (BOM stripped) and counts with the default tokenizer once, at upload (`AssetService.upload`); the count rides the attachment so the UI can show `~N tok.` without reading the file again.

**MIME resolution:** browsers report OS-guessed MIME types for text files (a Windows `.csv` arrives as `application/vnd.ms-excel`). `resolveAttachmentUploadMime` (`@vibe-tavern/domain`) is the one shared browser/server rule: a known text extension wins over any non-media reported MIME. `TEXT_MIME_TO_EXT` is the single extension↔MIME table.

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
  "skipExisting": false,
  "enableImportedRegexProfile": false
}
```

`enableImportedRegexProfile` is optional and defaults to `false` at the server boundary.
When the card contains Regex Rules, the importer creates exactly one atomic character-linked Profile; `true` makes its master switch active immediately, while every member preserves its source enabled/disabled state.
A Regex bundle failure reports zero created Regex and does not fail the character import, while the bundle transaction prevents partial Profile/Rule rows.

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

**Query:** `mode` (default `lore_entry`) — any of the [AI Assistant modes](./backend.md#ai-assistant).

**Response:** `{ prompt: string }`.
