/**
 * "Adjust thumbnail" full-promotion helper.
 *
 * The edit-thumbnail flow re-crops the square 512×512 thumbnail from the
 * uncropped source and uploads ONLY the crop (`uploadCharacterAvatar(id, crop)`
 * with no `full` arg). That is correct when the character already has a
 * separate `avatar-full.{ext}`: the backend leaves it untouched, and
 * `/avatar/full` keeps serving the uncropped original.
 *
 * The dangerous case is a SINGLE-IMAGE character — one with `avatarExt` set
 * but no `avatarFullExt`. There, `/avatar/full` falls back to serving
 * `avatar.{ext}` (the thumbnail). Writing a new crop overwrites that one file,
 * so `/avatar/full` immediately starts serving the crop — the editor and the
 * floating avatar panel (both `preferFull: true`) snap to the cropped square.
 *
 * This helper prevents that by returning the cropper's source image as a File
 * when no separate full exists, so the caller passes it as the `full` arg and
 * the uncropped source is promoted to `avatar-full.{ext}` in the same upload.
 * When a separate full already exists, or the source cannot be fetched, it
 * returns `undefined` and the upload proceeds as a crop-only write.
 */
export async function promoteSourceAsFull(args: {
	sourceUrl: string | null;
	/** True when the character already has a dedicated avatar-full (avatarFullExt set). */
	hasSeparateFull: boolean;
	/** Injectable for tests. Defaults to the global fetch. */
	fetchImpl?: typeof fetch;
}): Promise<File | undefined> {
	const { sourceUrl, hasSeparateFull, fetchImpl = fetch } = args;
	if (!sourceUrl || hasSeparateFull) return undefined;
	try {
		const resp = await fetchImpl(sourceUrl);
		if (!resp.ok) return undefined;
		const blob = await resp.blob();
		const mime = blob.type;
		if (!mime.startsWith("image/")) return undefined;
		// The backend derives the on-disk extension from the MIME type (not the
		// filename), so the filename is cosmetic — derive it from the MIME for
		// debuggability only.
		const ext = mime.split("/")[1] ?? "png";
		return new File([blob], `avatar-full.${ext}`, { type: mime });
	} catch {
		// Network/decode failure: degrade to crop-only (no worse than before).
		return undefined;
	}
}
