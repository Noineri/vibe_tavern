import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import * as schemas from '@vibe-tavern/api-contracts';
import { join, resolve } from 'node:path';
import type { FlyTribunalRuntimeApi } from '../contract/runtime-api.js';

const MANIFEST_FILE = 'fly-brain-manifest.json';
const BRAIN_FILE = 'connectome.bin.gz';

/**
 * Disk location override for route tests. Production uses the candidate ladder
 * below: source asset in development, copied `out/services/api/fly` artifact
 * in API builds, then a standalone `fly/` directory beside the executable.
 */
export interface FlyTribunalRouteOptions {
  assetDir?: string;
}

interface FlyTribunalAssetPaths {
  manifestPath: string;
  brainPath: string;
}

/**
 * Fly Tribunal HTTP boundary (FT-4).
 *
 * The route consumes ONLY the RuntimeApi seam (settings/memory); asset serving
 * is read-only and uses Bun.file so the 26 MB pre-gzipped connectome streams
 * directly from disk without materializing it in route memory.
 */
export function createFlyTribunalRoutes(
  runtime: FlyTribunalRuntimeApi,
  options: FlyTribunalRouteOptions = {},
): Hono {
  let assetsPromise: Promise<FlyTribunalAssetPaths> | undefined;
  const assets = () => assetsPromise ??= resolveFlyTribunalAssets(options.assetDir);

  return new Hono()
    .get('/api/fly/brain/manifest', async (c) => {
      const { manifestPath } = await assets();
      const manifest = await readManifest(manifestPath);
      return c.json(manifest);
    })
    .get('/api/fly/brain', async () => {
      const { manifestPath, brainPath } = await assets();
      const manifest = await readManifest(manifestPath);
      const brain = Bun.file(brainPath);
      const stat = await brain.stat();

      return new Response(brain, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(stat.size),
          // Strong validator for the exact compressed bytes; the browser worker
          // verifies this same manifest hash before it caches the artifact.
          ETag: `"${manifest.binary.sha256}"`,
          // The .gz extension is an opaque file format, not HTTP content
          // encoding. Omitting Content-Encoding prevents fetch from inflating
          // bytes before the worker verifies/caches the manifest hash.
          'Cache-Control': 'no-store',
        },
      });
    })
    .get('/api/fly/settings', async (c) => {
      return c.json(schemas.flyTribunalSettingsSchema.parse(await runtime.getSettings()));
    })
    .put('/api/fly/settings', zValidator('json', schemas.flyTribunalSettingsSchema), async (c) => {
      const settings = c.req.valid('json');
      return c.json(schemas.flyTribunalSettingsSchema.parse(await runtime.putSettings(settings)));
    })
    .get('/api/fly/memory/:scope', async (c) => {
      const scope = parseMemoryScope(c.req.param('scope'));
      if (!scope) return c.json({ error: 'Unknown Fly Tribunal memory scope.' }, 400);

      const chatId = c.req.query('chatId');
      const queryError = validateMemoryQuery(scope, chatId);
      if (queryError) return c.json({ error: queryError }, 400);

      return c.json(
        schemas.flyMemoryGetResponseSchema.parse(await runtime.getMemory(scope, chatId)),
      );
    })
    .put('/api/fly/memory/:scope', zValidator('json', schemas.flyMemoryPutSchema), async (c) => {
      const scope = parseMemoryScope(c.req.param('scope'));
      if (!scope) return c.json({ error: 'Unknown Fly Tribunal memory scope.' }, 400);

      const memory = c.req.valid('json');
      if (memory.scope !== scope) {
        return c.json({ error: 'Fly Tribunal memory path scope must match body scope.' }, 400);
      }

      return c.json(schemas.flyMemoryGetResponseSchema.parse(await runtime.putMemory(memory)));
    });
}

function parseMemoryScope(value: string): schemas.FlyMemoryScope | null {
  const parsed = schemas.flyMemoryScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function validateMemoryQuery(scope: schemas.FlyMemoryScope, chatId: string | undefined): string | null {
  if (scope === 'chat' && !chatId) return 'chatId is required when scope is "chat".';
  if (scope === 'global' && chatId !== undefined) return 'chatId must be absent when scope is "global".';
  return null;
}

async function resolveFlyTribunalAssets(assetDir?: string): Promise<FlyTribunalAssetPaths> {
  const candidates = assetDir
    ? [assetDir]
    : [
      // Source tree (bun dev / test).
      resolve(import.meta.dir, '..', '..', '..', 'assets', 'fly'),
      join(process.cwd(), 'services', 'api', 'assets', 'fly'),
      // API build output: copyPromptAssets recursively preserves `fly/`.
      resolve(import.meta.dir, '..', '..', 'fly'),
      resolve(import.meta.dir, 'fly'),
      join(process.cwd(), 'out', 'services', 'api', 'fly'),
      join(process.cwd(), 'fly'),
      // Standalone/mobile payloads preserve nested assets beneath prompts/.
      join(process.cwd(), 'prompts', 'fly'),
      join(resolve(process.execPath, '..'), 'prompts', 'fly'),
      join(resolve(process.execPath, '..'), 'fly'),
    ];

  for (const candidate of candidates) {
    const manifestPath = join(candidate, MANIFEST_FILE);
    const brainPath = join(candidate, BRAIN_FILE);
    if (await Bun.file(manifestPath).exists() && await Bun.file(brainPath).exists()) {
      return { manifestPath, brainPath };
    }
  }

  throw new Error('Fly Tribunal brain assets are missing from every runtime asset location.');
}

async function readManifest(manifestPath: string): Promise<schemas.FlyBrainManifest> {
  const raw: unknown = JSON.parse(await Bun.file(manifestPath).text());
  return schemas.flyBrainManifestSchema.parse(raw);
}
