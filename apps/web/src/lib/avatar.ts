import { getGatewayBaseUrl } from "../gateway-client.js";

/** Legacy flat-asset URL (data/assets/{assetId}.{ext} served via /api/assets). */
export function avatarUrl(assetId: string): string {
  return `${getGatewayBaseUrl()}/api/assets/${assetId}`;
}

/**
 * Resolve the best avatar URL for an entity, preferring the folder-resident
 * avatar (CFS migration) over legacy flat assets.
 *
 * - When `avatarExt` is set the avatar lives at /api/{kind}/:id/avatar and is
 *   canonical (folder-resident). Legacy columns are ignored — a folder avatar
 *   always wins, matching the migration direction.
 * - Otherwise fall back to flat assets: with `preferFull` (large display slots
 *   — AppShell header, BuildMode preview, card export) prefer the uncropped
 *   `avatarFullAssetId` over the cropped `avatarAssetId`; without it (small
 *   slots — chat bubbles, sidebar, top bar) use `avatarAssetId` directly.
 *
 * Returns null when the entity has no avatar at all.
 */
export function resolveEntityAvatarUrl(args: {
	kind: "characters" | "personas";
	id: string;
	avatarExt: string | null;
	avatarAssetId: string | null;
	avatarFullAssetId?: string | null;
	preferFull?: boolean;
}): string | null {
	const { kind, id, avatarExt, avatarAssetId, avatarFullAssetId, preferFull } = args;
	if (avatarExt) return `${getGatewayBaseUrl()}/api/${kind}/${id}/avatar`;
	const legacy = preferFull
		? (avatarFullAssetId ?? avatarAssetId ?? null)
		: avatarAssetId;
	return legacy ? avatarUrl(legacy) : null;
}
