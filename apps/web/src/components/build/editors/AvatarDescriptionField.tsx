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
 * Generation UX (redesigned):
 *   While `describing` is true the textarea is LOCKED (disabled). The card
 *   surfaces the in-progress state through three reinforcing cues so the user
 *   never wonders whether something is happening:
 *     1. the textarea tints accent and is covered by a shimmer overlay with a
 *        spinner + "Describing…" label,
 *     2. if any text is already presented in the text area, a blur is applied
 *        to existing text while re-generating,
 *     3. the action button morphs (opacity crossfade) from
 *        "Describe via vision" into a "Cancel" control with an inline status.
 *   When the description arrives (empty → non-empty transition), the textarea
 *   briefly flashes an accent tint so the new content is noticed. The button
 *   then reads "Regenerate".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
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

/** Spring used for the button morph and icon crossfades (bounce must be 0). */
const morphSpring = { duration: 0.15, ease: [0.2, 0, 0, 1] as const };

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
	// Brief accent flash on the textarea when a fresh description lands —
	// surfaces the otherwise-silent prop swap after `onDescribe` resolves.
	const [justArrived, setJustArrived] = useState(false);
	const abortRef = useRef<AbortController | null>(null);
	// Tracks the previous `avatarDescription` to detect the empty → content
	// transition that warrants the reveal flash.
	const prevDescRef = useRef(avatarDescription);

	// Local draft for the textarea — commits on blur, NOT per keystroke
	// (matches GalleryLightbox's edit-then-save UX; avoids a PATCH per char).
	const [draft, setDraft] = useState(avatarDescription ?? "");
	// Reseed when the prop changes externally (after a describe populates it,
	// or a parent reset). Now safe: the textarea is locked while describing,
	// so a reseed here only races with real external updates, never user input.
	useEffect(() => {
		setDraft(avatarDescription ?? "");
	}, [avatarDescription]);

	// Trigger the result-reveal flash when description goes empty → content.
	// This fires both after a successful describe AND after the user's first
	// manual save — both are positive "it worked" moments worth surfacing.
	useEffect(() => {
		const prev = prevDescRef.current;
		const nextNonEmpty = !!avatarDescription && avatarDescription.trim().length > 0;
		const prevEmpty = !prev || prev.trim().length === 0;
		if (prevEmpty && nextNonEmpty) {
			setJustArrived(true);
			const id = setTimeout(() => setJustArrived(false), 1400);
			prevDescRef.current = avatarDescription;
			return () => clearTimeout(id);
		}
		prevDescRef.current = avatarDescription;
	}, [avatarDescription]);

	const controlsDisabled = disabled || !hasAvatar;
	// CRITICAL: lock the textarea during generation so the user cannot race
	// the describe and have their draft silently clobbered on completion.
	const inputLocked = controlsDisabled || describing;
	// Regenerate (has existing text) → frosted blur; first-gen (empty) → solid.
	const hasExistingDescription = !!avatarDescription && avatarDescription.trim().length > 0;

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
		// Guard: if a describe just finished and blurred the field, don't
		// clobber the freshly-arrived server value with stale local draft.
		if (describing) return;
		const trimmed = draft.trim();
		const current = (avatarDescription ?? "").trim();
		// Only PATCH on a real change — avoid no-op writes (e.g. blur without edit).
		if (trimmed === current) return;
		onPatch({ avatarDescription: trimmed.length > 0 ? trimmed : null });
	}, [draft, avatarDescription, onPatch, describing]);

	const placeholder =
		kind === "character" ? t("avatar_description_placeholder_char") : t("avatar_description_placeholder_persona");

	return (
		<section
			className={cn(
				"relative overflow-hidden rounded-md border border-border bg-s1 p-3",
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

			{/* Action cluster — morphs between Describe / Cancel via AnimatePresence.
			    Both states are absolutely positioned inside a fixed-height rail so
			    the crossfade doesn't shift the layout. The "Describing…" status
			    lives only in the textarea overlay below — not duplicated here. */}
			<div className="relative mb-2 h-8">
				<AnimatePresence initial={false}>
					{describing ? (
						<motion.div
							key="describing"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							exit={{ opacity: 0 }}
							transition={morphSpring}
							className="absolute inset-0 flex items-center"
						>
							<button
								type="button"
								className={cn(
									"flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-3",
									"font-ui text-[12px] text-danger",
									"transition-[background-color,color] duration-150",
									"hover:bg-danger/20 hover:text-danger-strong",
								)}
								onClick={handleCancelDescribe}
								title={t("avatar_describe_cancel")}
							>
								<Ic.close />
								<span>{t("avatar_describe_cancel")}</span>
							</button>
						</motion.div>
					) : (
						<motion.div
							key="describe"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							exit={{ opacity: 0 }}
							transition={morphSpring}
							className="absolute inset-0 flex items-center"
						>
							<button
								type="button"
								className={cn(
									"flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-3",
									"font-ui text-[12px] text-t2",
									"transition-[background-color,color,border-color] duration-150",
									"hover:bg-s2 hover:text-t1 hover:border-accent/40",
								)}
								onClick={() => void handleDescribe()}
								disabled={controlsDisabled}
								title={t("avatar_describe_via_vision")}
							>
								<Ic.sparkles className={avatarDescription ? "text-accent" : undefined} />
								<span>{avatarDescription ? t("avatar_describe_regenerate") : t("avatar_describe_via_vision")}</span>
							</button>
						</motion.div>
					)}
				</AnimatePresence>
			</div>

			{/* Textarea + generation overlay. The textarea is locked (disabled)
			    while describing so the incoming server value can't be raced. */}
			<div className="relative">
				<AutoTextarea
					className={cn(
						inputCls,
						"transition-[border-color,box-shadow] duration-200",
						justArrived && "border-accent/60 shadow-[0_0_0_2px_var(--accent-dim)]",
					)}
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
				placeholder={describing ? "" : placeholder}
				disabled={inputLocked}
					maxRows={12}
				/>

				{/* Generation overlay — centered spinner + "Describing". */}
				<AnimatePresence>
					{describing && (
						<motion.div
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							exit={{ opacity: 0 }}
							transition={{ duration: 0.2 }}
							className={cn(
								"pointer-events-none absolute inset-0 flex items-center justify-center gap-2 rounded-md px-3",
								hasExistingDescription ? "bg-s1/70 backdrop-blur-[4px]" : "bg-s1",
							)}
						>
							<span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
							<span className="font-ui text-[16px] text-t2">{t("avatar_describing")}</span>
						</motion.div>
					)}
				</AnimatePresence>

				{/* Result-reveal flash — a soft accent tint that fades out over
				    ~1.2s when a fresh description lands. Pure signal, no interaction. */}
				<AnimatePresence>
					{justArrived && !describing && (
						<motion.div
							initial={{ opacity: 0.7 }}
							animate={{ opacity: 0 }}
							transition={{ duration: 1.2, ease: "easeOut" }}
							className="pointer-events-none absolute inset-0 rounded-md bg-accent/10"
						/>
					)}
				</AnimatePresence>
			</div>

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
