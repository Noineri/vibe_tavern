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
 *
 * The generation feedback UX (button morph, generating overlay, result-reveal
 * flash, abort handling) is provided by `shared/generation-feedback.tsx`. This
 * component owns only the field-specific glue: draft state, commit-on-blur,
 * the toggle, and the no-avatar hint.
 */
import { useCallback, useEffect, useState } from "react";
import { Toggle } from "../../shared/Toggle.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { lblCls, inputCls } from "../fields/field-styles.js";
import { toast } from "sonner";
import {
	GenerateCancelButton,
	GenerationSurface,
	useGenerationTask,
} from "../../shared/generation-feedback.js";

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
	const { generating, start, cancel } = useGenerationTask({
		onGenerate: onDescribe,
		onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
	});

	// Local draft for the textarea — commits on blur, NOT per keystroke
	// (matches GalleryLightbox's edit-then-save UX; avoids a PATCH per char).
	const [draft, setDraft] = useState(avatarDescription ?? "");
	// Reseed when the prop changes externally (after a describe populates it,
	// or a parent reset). Safe because the textarea is locked while generating.
	useEffect(() => {
		setDraft(avatarDescription ?? "");
	}, [avatarDescription]);

	const controlsDisabled = disabled || !hasAvatar;

	const commitDraft = useCallback(() => {
		// Guard: a describe in flight blurs the field — don't clobber the
		// freshly-arriving server value with a stale local draft.
		if (generating) return;
		const trimmed = draft.trim();
		const current = (avatarDescription ?? "").trim();
		// Only PATCH on a real change — avoid no-op writes (e.g. blur without edit).
		if (trimmed === current) return;
		onPatch({ avatarDescription: trimmed.length > 0 ? trimmed : null });
	}, [draft, avatarDescription, onPatch, generating]);

	const placeholder =
		kind === "character" ? t("avatar_description_placeholder_char") : t("avatar_description_placeholder_persona");

	return (
		<section
			className={cn(
				"relative overflow-hidden rounded-md border border-border p-3",
				controlsDisabled && "opacity-60",
			)}
		>
			{/* Header: label + toggle */}
			<div className="mb-2.5 flex items-center justify-between gap-2">
				<label className={cn(lblCls, "mb-0")}>{t("avatar_description_label")}</label>
				<div className="flex items-center gap-2">
					<span className="font-ui text-[12px] text-t3">{t("avatar_include_in_prompt")}</span>
					<Toggle
						checked={includeAvatarInPrompt}
						onChange={(next) => onPatch({ includeAvatarInPrompt: next })}
						disabled={controlsDisabled}
					/>
				</div>
			</div>

			{/* Action cluster — morphs between Describe / Cancel. The rail,
			    spring, and both button variants live in GenerateCancelButton
			    so other generation surfaces can reuse them verbatim. */}
			<GenerateCancelButton
				generating={generating}
				hasValue={!!avatarDescription?.trim()}
				labels={{
					generate: t("avatar_describe_via_vision"),
					regenerate: t("avatar_describe_regenerate"),
					cancel: t("avatar_describe_cancel"),
				}}
				titles={{
					generate: t("avatar_describe_via_vision"),
					cancel: t("avatar_describe_cancel"),
				}}
				onGenerate={start}
				onCancel={cancel}
				disabled={controlsDisabled}
			/>

			{/* Textarea + generation overlay. The textarea is locked (disabled)
			    while describing so the incoming server value can't be raced.
			    The overlay (spinner + "Describing…", blur on existing content)
			    and the result-reveal flash are owned by GenerationSurface. */}
			<GenerationSurface
				generating={generating}
				value={avatarDescription ?? ""}
				generatingLabel={t("avatar_describing")}
				disabled={controlsDisabled}
			>
				{({ disabled, controlClassName }) => (
					<AutoTextarea
						className={cn(inputCls, controlClassName)}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onBlur={commitDraft}
						onKeyDown={(e) => {
							if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
								e.preventDefault();
								commitDraft();
							}
						}}
						placeholder={generating ? "" : placeholder}
						disabled={disabled}
						maxRows={12}
					/>
				)}
			</GenerationSurface>

			{!hasAvatar && (
				<p className="mt-2 font-ui text-[11px] text-t4">
					{kind === "character"
						? t("avatar_description_no_avatar_char")
						: t("avatar_description_no_avatar_persona")}
				</p>
			)}
		</section>
	);
}
