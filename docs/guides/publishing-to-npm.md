# Publishing to npm

Vibe Tavern ships an npm distribution alongside the binary releases, installed with `bun install -g vibe-tavern`.

This guide covers the parts a human has to do.
Everything mechanical — building, packing, verifying, publishing — lives in [`scripts/build-npm-dist.ts`](../../scripts/build-npm-dist.ts) and [`.github/workflows/release-npm.yml`](../../.github/workflows/release-npm.yml), and the reasoning behind each decision is commented at the point it matters.

## What this channel is

A plain JavaScript bundle plus its assets, run by the user's own Bun.
There is no compiled binary: anyone typing `bun install -g` already has the runtime, so shipping one buys nothing and would cost a per-platform artifact.

Two consequences worth knowing before touching any of it:

- It is the **only channel that works on macOS**, and the only one that works on non-x64 Linux. There is no release archive for either.
- It updates through the package manager (`bun add -g vibe-tavern@X.Y.Z`), not by swapping files. The in-app update dialog drives it through the same endpoints as every other channel — see [`npm-update.ts`](../../services/api/src/domain/update/npm-update.ts).

## One-time account setup

Publishing uses **trusted publishing (OIDC)**. There is no `NPM_TOKEN` secret anywhere, and there should never be one.

1. Publish a placeholder manually. OIDC cannot perform a package's *first* publish — npm requires the package to exist before a trusted publisher can be attached to it. Publish it under a dist-tag other than `latest`, so `bun install -g vibe-tavern` does not resolve to an empty package in the meantime:

   ```bash
   npm publish --tag placeholder --access public
   ```

2. On `https://www.npmjs.com/package/vibe-tavern/access`, add a trusted publisher:
   - organization/user `Noineri`, repository `vibe_tavern`
   - workflow filename `release-npm.yml` — **exactly**, including the extension
   - environment: leave empty

3. After the first real release, deprecate the placeholder:

   ```bash
   npm deprecate vibe-tavern@0.0.0 "Placeholder version — install the latest release instead."
   ```

**Never rename `release-npm.yml`.** The trusted-publisher binding is by filename; renaming it silently breaks publishing until the package is reconfigured on npmjs.com.

## Rehearsing before a real release

`release-npm.yml` accepts `workflow_dispatch` so the whole path can be exercised without cutting a release.
GitHub only shows the dispatch button for workflows on the **default branch**, so the workflow must be merged to `dev` first.

Run it with a throwaway version (`0.0.1-rc.1`) and a non-`latest` dist-tag (`next`), then:

```bash
bun install -g vibe-tavern@next
```

Clean up afterwards:

```bash
npm dist-tag rm vibe-tavern next
```

The workflow refuses a manual publish to `latest` — that tag moves only when a release is published.

## Cutting a release

Nothing extra to do. `release-npm.yml` fires on the `released` event, i.e. the same human click on "Publish release" that promotes the Docker `latest` tag.

One behaviour to be aware of: the in-app updater polls GitHub, so every installed instance sees the new version the instant the release is published — while the npm publish job is still building.
An npm user pressing "Update" inside that window gets *"not on npm yet — try again shortly"*, because the update path probes the registry before touching anything.
This is deliberate; do not try to fix it by delaying the GitHub release.

## What CI already checks

You should not need to test the channel by hand. On every push and PR:

- `build-npm` — builds the package, validates the manifest with `npm publish --dry-run`, packs the tarball.
- `smoke-npm` — installs that tarball globally on **ubuntu, windows and macos**, starts the server from a scratch directory, and asserts it serves the SPA and reports `installKind: "npm"`.
- `selfupdate-npm` — stands up a local registry with two versions and drives a real self-update from `0.0.1` to `0.0.2` through the HTTP endpoints the update modal uses.

Both smoke scripts run locally too:

```bash
bun scripts/smoke-npm-selfupdate.ts
```

## Traps that cost time

Every one of these fails *quietly* — they were found by publishing, not by review.

- **`bin` paths must not start with `./`.** npm's normalizer deletes the entry and publishes a package with no launcher, exiting 0 with a warning. `npm pack` does not normalize, so a tarball installed from disk still works and hides it.
- **Do not set `publishConfig.provenance`.** Provenance belongs to the publishing environment; baked into the manifest it breaks every publish outside GitHub Actions with *"Automatic provenance generation not supported for provider: null"*. The workflow passes `--provenance` instead.
- **`bun install -g ./relative.tgz` fails** with `ENOENT extracting tarball`. Absolute paths work.
- **`--skip-frontend` is a test-only flag** for `build-npm-dist.ts`. It reuses whatever is in `out/apps/web`; nothing catches a stale frontend.
