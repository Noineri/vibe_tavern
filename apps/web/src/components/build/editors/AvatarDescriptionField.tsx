/**
 * AvatarDescriptionField — the UI for the avatar-in-prompt feature.
 *
 * Three controls over a character/persona avatar:
 *   (a) a "Describe via vision" button that asks the backend to vision-describe
 *       the avatar and persist `avatarDescription` out-of-band;
 *   (b) a toggle for `includeAvatarInPrompt` (whether the description is
 *       injected as a `characterAvatar` / `personaAvatar` prompt layer);
 *   (c) an editable textarea for `avatarDescription` (user-edited text also
 *       works — the prompt layer only requires a non-blank value).
 *
 * Architectural constraint (see vibe_tavern_plan/reports/avatar-description-ui-gap.md
 * and `packages/api-contracts/src/schemas/character-schema.ts`): the avatar
 * fields are intentionally excluded from `BuildCharacterDraft` and round-trip
 * through the normal PATCH path OUT-OF-BAND. So this component is deliberately
 * store-agnostic: the PARENT owns the snapshot sync and passes two seams —
 *   • `onPatch`  — commits a toggle/edit (real PATCH via the parent's action);
 *   • `onDescribe` — runs the vision describe (endpoint persists out-of-band;
 *     parent then refreshes the store with the returned description).
 *
 * Presentational only: no imports of stores or RPC clients. Reusable across
 * character + persona (`kind` prop) — mounted in CharacterForm and PersonaModal.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Ic } from "../../shared/icons.js";
import { Toggle } from "../../shared/Toggle.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { lblCls, inputCls, inputPad } from "../fields/field-styles.js";
import { toast } from "sonner";

export interface AvatarDescriptionPatch {
	includeAvatarInPrompt?: boolean;
	avatarDescription?: string | null;
}

interface AvatarDescriptionFieldProps {
	kind: "character" | "persona";
	/** Current toggle state (from the snapshot entity). */
	includeAvatarInPrompt: boolean;
	/** Current description (from the snapshot entity; null = undescribed). */
	avatarDescription: string | null;
	/** Whether an avatar image is uploaded. When false, controls are disabled
	 *  with a hint — there is nothing to describe or inject. */
	hasAvatar: boolean;
	/** Commit a toggle or manual edit. Parent runs the real PATCH + ingest. */
	onPatch: (patch: AvatarDescriptionPatch) => void;
	/** Run the vision describe. Parent passes the signal to the RPC, persists
	 *  out-of-band, then refreshes the store with the returned description.
	 *  Resolves on success; rejects on error (AbortError is silenced here). */
	onDescribe: (signal: AbortSignal) => Promise<void>;
	/** Optional: disable everything (e.g. while the parent form is saving). */
	disabled?: boolean;
}

export function AvatarDescriptionField({
	kind,
	includeAvatarInPrompt,
	avatarDescription,
	hasAvatar,
	onPatch,
	onDescribe,
	disabled,
}: AvatarDescriptionFieldProps) {
	const { t } = useT();
	const [describing, setDescribing] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	// Local draft for the textarea — commits on blur, NOT per keystroke
	// (matches GalleryLightbox's edit-then-save UX; avoids a PATCH per char).
	const [draft, setDraft] = useState(avatarDescription ?? "");
	// Reseed when the prop changes externally (after a describe populates it,
	// or a parent reset). Safe to clobber: typing only touches local draft,
	// and a concurrent describe finishing mid-type is the intended reseed.
	useEffect(() => {
		setDraft(avatarDescription ?? "");
	}, [avatarDescription]);

	const controlsDisabled = disabled || !hasAvatar;

	const handleDescribe = useCallback(async () => {
		if (describing) return;
		const controller = new AbortController();
		abortRef.current = controller;
		setDescribing(true);
		try {
			await onDescribe(controller.signal);
		} catch (err) {
			// User cancelled (Cancel button) — silent, like gallery-store.describe.
			if (controller.signal.aborted) return;
			const message = err instanceof Error ? err.message : String(err);
			toast.error(message);
		} finally {
			if (abortRef.current === controller) abortRef.current = null;
			setDescribing(false);
		}
	}, [describing, onDescribe]);

	const handleCancelDescribe = useCallback(() => {
		abortRef.current?.abort();
	}, []);

	const commitDraft = useCallback(() => {
		const trimmed = draft.trim();
		const current = (avatarDescription ?? "").trim();
		// Only PATCH on a real change — avoid no-op writes (e.g. blur without edit).
		if (trimmed === current) return;
		onPatch({ avatarDescription: trimmed.length > 0 ? trimmed : null });
	}, [draft, avatarDescription, onPatch]);

	const placeholder =
		kind === "character" ? t("avatar_description_placeholder_char") : t("avatar_description_placeholder_persona");

	return (
		<div className={cn("rounded-md border border-border bg-s1 p-3", controlsDisabled && "opacity-60")}>
			{/* Header: label + toggle */}
			<div className="mb-2 flex items-center justify-between gap-2">
				<label className={lblCls + " mb-0"}>{t("avatar_description_label")}</label>
				<div className="flex items-center gap-2">
					<span className="font-ui text-[12px] text-t3">{t("avatar_include_in_prompt")}</span>
					<Toggle
						checked={includeAvatarInPrompt}
						onChange={(next) => onPatch({ includeAvatarInPrompt: next })}
						disabled={controlsDisabled}
					/>
				</div>
			</div>

			{/* Describe / Cancel cluster */}
			<div className="mb-2 flex items-center gap-2">
				{!describing ? (
					<button
						type="button"
						className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-3 font-ui text-[12px] text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-not-allowed disabled:opacity-50"
						onClick={() => void handleDescribe()}
						disabled={controlsDisabled}
						title={t("avatar_describe_via_vision")}
					>
						<Ic.sparkles />
						<span>{avatarDescription ? t("avatar_describe_regenerate") : t("avatar_describe_via_vision")}</span>
					</button>
				) : (
					<button
						type="button"
						className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-3 font-ui text-[12px] text-danger transition-all hover:bg-danger/20"
						onClick={handleCancelDescribe}
						title={t("avatar_describe_cancel")}
					>
						<Ic.sparkles />
						<span>{t("avatar_describing")}</span>
					</button>
				)}
			</div>

			{/* Description textarea */}
			<AutoTextarea
				className={inputCls}
				style={inputPad}
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commitDraft}
				onKeyDown={(e) => {
					if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
						e.preventDefault();
						commitDraft();
					}
				}}
				placeholder={placeholder}
				disabled={controlsDisabled}
				maxHeight={240}
			/>

			{!hasAvatar && (
				<p className="mt-2 font-ui text-[11px] text-t4">
					{kind === "character"
						? t("avatar_description_no_avatar_char")
						: t("avatar_description_no_avatar_persona")}
				</p>
			)}
		</div>
	);
}
