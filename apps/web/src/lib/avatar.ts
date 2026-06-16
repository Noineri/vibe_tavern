import { getGatewayBaseUrl } from "../gateway-client.js";

/** Legacy flat-asset URL (data/assets/{assetId}.{ext} served via /api/assets). */
export function avatarUrl(assetId: string): string {
  return `${getGatewayBaseUrl()}/api/assets/${assetId}`;
}

/**
 * Resolve the best avatar URL for an entity.
 *
 * Two folder-resident files exist side by side:
 *  - avatar.{ext}    → thumbnail (crop). Used for SMALL slots (chat bubbles,
 *    sidebar, top bar). Served at /api/{kind}/:id/avatar.
 *  - avatar-full.{ext} → uncropped original. Used for LARGE slots (top-bar
 *    preview, editor). Served at /api/{kind}/:id/avatar/full, which falls
 *    back to the thumbnail server-side when no separate full is stored.
 *
 * `preferFull` selects the full endpoint. Without it (or for legacy flat
 * avatars with no avatarExt) the thumbnail is used. Legacy fallback: with
 * preferFull, prefer avatarFullAssetId over avatarAssetId.
 *
 * Returns null when the entity has no avatar at all.
 */
export function resolveEntityAvatarUrl(args: {
	kind: "characters" | "personas";
	id: string;
	avatarExt: string | null;
	avatarAssetId: string | null;
	avatarFullExt?: string | null;
	avatarFullAssetId?: string | null;
	preferFull?: boolean;
}): string | null {
	const { kind, id, avatarExt, avatarAssetId, avatarFullExt, avatarFullAssetId, preferFull } = args;
	if (avatarExt) {
		// Folder-resident: pick the full endpoint for large slots, thumbnail for
		// small ones. /avatar/full falls back to avatar.{ext} server-side when
		// avatarFullExt is null (single-image upload, no crop made).
		return preferFull
			? `${getGatewayBaseUrl()}/api/${kind}/${id}/avatar/full`
			: `${getGatewayBaseUrl()}/api/${kind}/${id}/avatar`;
	}
	// Legacy flat assets (pre-folder). preferFull picks the uncropped original.
	const legacy = preferFull
		? (avatarFullAssetId ?? avatarAssetId ?? null)
		: avatarAssetId;
	return legacy ? avatarUrl(legacy) : null;
}
