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
 * Cache-busting: folder-resident URLs are served with a 1-year immutable
 * Cache-Control, so the URL MUST change when the avatar bytes change (a
 * re-upload with the same extension yields an identical URL otherwise and the
 * browser serves the stale year-long cache). `updatedAt` (bumped by
 * setFolderAvatar/setFolderAvatarFull on every upload, refreshed in the store
 * via fetchBootstrapAction) is appended as `?v={ms}`. Legacy flat assets use a
 * unique assetId per upload, so they need no version.
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
	updatedAt?: string | null;
	preferFull?: boolean;
}): string | null {
	const { kind, id, avatarExt, avatarAssetId, avatarFullAssetId, updatedAt, preferFull } = args;
	if (avatarExt) {
		// Folder-resident: pick the full endpoint for large slots, thumbnail for
		// small ones. /avatar/full falls back to avatar.{ext} server-side when
		// avatarFullExt is null (single-image upload, no crop made).
		//
		// Append ?v={ms} from updatedAt so a re-upload (same extension → same
		// path) busts the browser's 1-year immutable cache. Without it the stale
		// thumbnail shows until a hard reload.
		const ms = updatedAt ? Date.parse(updatedAt) : NaN;
		const v = Number.isFinite(ms) ? `?v=${ms}` : "";
		return preferFull
			? `${getGatewayBaseUrl()}/api/${kind}/${id}/avatar/full${v}`
			: `${getGatewayBaseUrl()}/api/${kind}/${id}/avatar${v}`;
	}
	// Legacy flat assets (pre-folder). preferFull picks the uncropped original.
	// No version needed: each upload mints a fresh assetId, so the URL already
	// changes.
	const legacy = preferFull
		? (avatarFullAssetId ?? avatarAssetId ?? null)
		: avatarAssetId;
	return legacy ? avatarUrl(legacy) : null;
}
