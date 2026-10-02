# Running an isolated test instance

`bun run test-instance` launches a live, disposable Vibe Tavern on its own copy of the data, so an agent (or a developer) can exercise a change in the real app without touching the owner's live data dir.
It is the only sanctioned way for agents to run a server with the API; the vt-guard pi extension blocks hand-launched `bun run dev` / `prod` / `dev:api` and direct `*-server.ts` runs and points here.

## Usage

From the repo root:

```bash
bun run test-instance start              # snapshot of data/, prod entry on http://127.0.0.1:8787
bun run test-instance start --fresh      # empty data dir instead of a snapshot
bun run test-instance status
bun run test-instance stop               # kill by recorded PID, delete the temp dir
```

| Option | Meaning |
|---|---|
| `--port <n>` | Listen port, default 8787. Every verb takes it; one instance per port. 8788 (the owner's dev server) is always refused. |
| `--fresh` | Start from an empty data dir (first-run state). |
| `--source <dir>` | Data dir to snapshot instead of `<repo>/data`. |
| `--build` / `--no-build` | Force a frontend rebuild / never rebuild. Default: rebuild only when sources are newer than `out/apps/web/index.html`. |
| `--quota-polling` | Keep the provider quota poller on (off by default, see below). |

`start` prints the URL, PID, data dir and log path once the server logs `[prod] Application ready.`, then returns; the server keeps running detached until `stop`.

## What `start` does

1. **Refuses unsafe states**: port 8788; a port that is already listening (the owning PID is printed — it is never killed); an instance already recorded and alive on that port.
2. **Snapshots the data** into `<VIBE_TAVERN_TEST_TEMP_BASE ?? %TEMP%>/vibe-tavern-test-instance-<port>/data/`:
   - the DB through a read-only `bun:sqlite` handle and `VACUUM INTO` — a transactionally consistent copy including committed WAL frames (a plain copy of a WAL-mode DB can be torn);
   - every other entry of the source dir by recursive copy — the file-store folders (`characters/`, `personas/`, `lorebooks/`, `assets/`, …) are the source of truth for card content, so a DB-only copy is a broken instance;
   - except the `*-model-cache` dirs (hundreds of MB; TTS/STT re-download on demand).
   The folder copy is not atomic with the DB copy; a write the owner makes mid-snapshot can be half-reflected. That is acceptable for a test instance.
3. **Builds the frontend** (`bun run --filter @vibe-tavern/web build`) when stale.
4. **Spawns the prod entry** `services/api/src/server/prod-server.ts` with `--no-env-file`, detached, stdout+stderr into `server.log`, and a scrubbed environment: every inherited `VIBE_TAVERN_*` variable is dropped (a stray `VIBE_TAVERN_DB_PATH` would point the instance back at the live DB), then `ROOT_DIR`, `DATA_DIR`, `PORT`, `HOST=127.0.0.1` (the snapshot carries the owner's provider keys — never expose it on the LAN), `OPEN_BROWSER=0` and `QUOTA_POLLING=0` are set.

## Why not `bun run dev`

`apps/web/dev-server.ts` hardcodes `<repo>/data` and ignores `VIBE_TAVERN_DATA_DIR`; an agent once wrote into the owner's live DB that way (plan repo: `BUILD_MODE_F5_RESTORE_REPORT`, execution log).
The test instance runs the production entry, which honours `VIBE_TAVERN_DATA_DIR`.
Frontend-only HMR without the API (`bun run dev:web`) remains fine.

## Quota polling

A snapshot carries the owner's provider profiles, so the quota poller would call real vendor quota endpoints on boot.
`VIBE_TAVERN_QUOTA_POLLING=0` (read in `server-runtime.ts`) skips `QuotaService.start()`: no timers, no profile-event subscription; quota settings still save.
Chat generation and every other user-triggered provider call still use the snapshot's real keys — that is the point of a live instance, and it costs real tokens.

## `stop`

`stop` reads `instance.json`, verifies the recorded PID is the listener on the recorded port (a PID that is alive but not listening may have been recycled after a crash — it is never killed on a guess), kills it, waits for exit, and deletes the instance dir.
It only ever deletes a `vibe-tavern-test-instance-*` dir directly under the temp base.
After a crashed start, a new `start` on the same port clears the stale dir itself.
