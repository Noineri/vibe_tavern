import { useEffect, useRef, useState } from "react";
import type { ProviderGenerationFormat } from "@vibe-tavern/domain";
import {
	BUILTIN_FORMAT_TEMPLATES,
	CUSTOM_TEMPLATE_SELECTION_PREFIX,
	GENERATION_FORMAT_MODE,
	NAMES_BEHAVIOR,
} from "@vibe-tavern/domain";
import type { AutoTemplateSource, GenerationFormat, NamesBehavior } from "@vibe-tavern/domain";
import type { FormatTemplate } from "@vibe-tavern/api-contracts";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { toast } from "sonner";
import { Icons } from "../../shared/icons.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { DropdownSelect } from "../../shared/DropdownSelect.js";
import { Toggle } from "../../shared/Toggle.js";
import { AnimatedDisclosure } from "../../shared/AnimatedDisclosure.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { DestructiveConfirmModal } from "../../shared/destructive-confirm-modal.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { TextInput } from "../../shared/text-input.js";
import { buildFormatPreviewSegments } from "../../../lib/format-preview.js";
import {
	createFormatTemplate,
	deleteFormatTemplate,
	listFormatTemplates,
	updateFormatTemplate,
} from "../../../api/format-template-api.js";
import { detectStFileKind, parseStInstruct } from "@vibe-tavern/import-export";
import type { FormState } from "../../modals/ProviderModal.js";

/**
 * The provider-side generation format block (LOCAL_SUPPORT_PLAN LS-10, owner
 * redesign 2026-09-09 audit 3): a 1:1 clone of the sampler-set pattern —
 * ONE accordion «Формат генерации» whose header carries the template row
 * (dropdown + icon actions + morph rename + confirm delete) and the manual
 * toggle switch (the customSamplers analog):
 *
 *   toggle OFF (auto):  the body is greyed/inert; generation glues by the
 *                       selected template (dropdown) or the backend.
 *   toggle ON (manual): the sequence fields are editable; the dropdown is
 *                       "where the fields come from" — picking a template
 *                       writes its sequences into the editor (sampler
 *                       applySet analog); the dirty dot lights while the
 *                       fields diverge from the selected template.
 *
 * The template pointer (`selection`) rides the stored shape in BOTH states
 * (one pointer like `samplerSetId`) — a mode flip can never lose it. Body
 * order (owner, audit 3): collapsible PREVIEW sub-accordion FIRST, then the
 * sequence fields, then the LS-9 empty-stops hint. The source status line
 * lives UNDER the accordion, outside it.
 *
 * Storage rides the profile (`generationFormat`, null = unset). Decision (c):
 * while unset, the active preset's format keeps applying — the pane shows the
 * honest fallback note; ANY edit here adopts the profile as the source.
 */
interface ProviderFormatPanelProps {
	form: FormState;
	updateForm: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
	/** Where AUTO takes its template for this preset (LS-3c): "backend" (the
	 *  llama-server Jinja), "native" (KoboldCPP's own serializer — the block
	 *  renders ALWAYS there), "default" (the documented default elsewhere). */
	tcTemplateSource: AutoTemplateSource;
}

/** The sequence-bearing shape — the dirty-dot baseline compares exactly
 *  these; glue mode/selection memory are not part of the divergence. */
const SEQUENCE_KEYS = [
	"inputSequence",
	"outputSequence",
	"systemSequence",
	"firstOutputSequence",
	"lastOutputSequence",
	"systemSequencePrefix",
	"systemSequenceSuffix",
	"inputSuffix",
	"outputSuffix",
	"systemSuffix",
] as const;

/** Do the manual fields diverge from the selected template's sequences? */
function sequencesDiverge(a: GenerationFormat, b: GenerationFormat): boolean {
	for (const key of SEQUENCE_KEYS) {
		if ((a[key] ?? "") !== (b[key] ?? "")) return true;
	}
	if ((a.wrap ?? false) !== (b.wrap ?? false)) return true;
	if ((a.namesBehavior ?? NAMES_BEHAVIOR.force) !== (b.namesBehavior ?? NAMES_BEHAVIOR.force)) return true;
	return false;
}

/** Single-line monospace field for one sequence — sequences are template
 *  strings (`<|im_start|>user`, `\n`, …), so they render mono. Canonical
 *  TextInput mono since FS-4 (owner: plain canonical inputs, grid desktop /
 *  stacked mobile — no compact novelty for one usage). */
function SequenceField(props: {
	label: string;
	hint?: string;
	value: string;
	onChange: (next: string) => void;
}) {
	return (
		<div>
			<label className={lblCls}>{props.label}</label>
			<TextInput
				mono
				value={props.value}
				onChange={(e) => props.onChange(e.target.value)}
				spellCheck={false}
			/>
			{props.hint && <div className="mt-1 font-ui text-[11px] text-t3">{props.hint}</div>}
		</div>
	);
}

/** A collapsible framed section — the LS-3 pane's framed-accordion chrome over
 *  the shared AnimatedDisclosure body transition. The header is a div (not a
 *  button) so the right side can host interactive `headerExtra` (the template
 *  row + the manual toggle — the sampler-accordion layout). */
function FramedSection(props: {
	title: string;
	open: boolean;
	onToggle: () => void;
	children: React.ReactNode;
	testId?: string;
	headerExtra?: React.ReactNode;
}) {
	return (
		<div data-testid={props.testId} className="overflow-hidden rounded-lg border border-border2">
			<div className={cn("flex w-full items-center justify-between gap-2 bg-s2 px-3 py-2.5 transition-colors hover:bg-[var(--border)]", props.open && "rounded-b-none")}>
				<span
					className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-2 font-ui text-[13px] font-medium text-t1")}
					onClick={props.onToggle}
					aria-expanded={props.open}
					data-testid={props.testId ? `${props.testId}-toggle` : undefined}
				>
					<span className={cn("shrink-0 transition-transform", props.open && "rotate-90")}>
						<Icons.Caret direction="r" />
					</span>
					{props.title}
				</span>
				{props.headerExtra}
			</div>
			<AnimatedDisclosure open={props.open}>
				<div className="border-t border-border2 bg-surface p-4">{props.children}</div>
			</AnimatedDisclosure>
		</div>
	);
}

export function ProviderFormatPanel({ form, updateForm, tcTemplateSource }: ProviderFormatPanelProps) {
	const { t } = useT();
	const stored = form.generationFormat ?? null;
	const [templates, setTemplates] = useState<FormatTemplate[]>([]);
	const [accordionOpen, setAccordionOpen] = useState(false);
	const [previewOpen, setPreviewOpen] = useState(false);
	// The save-as-new / rename morph (sampler-set pattern): the dropdown row
	// morphs into a name input while active; a collision shows the warning.
	const [morph, setMorph] = useState<{ intent: "new" | "rename"; value: string } | null>(null);
	const [morphConflict, setMorphConflict] = useState(false);
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
	const importInputRef = useRef<HTMLInputElement>(null);

	const isManual = stored?.mode === GENERATION_FORMAT_MODE.manual;
	const manualFormat: GenerationFormat = isManual
		? stored?.format ?? { mode: GENERATION_FORMAT_MODE.manual }
		: { mode: GENERATION_FORMAT_MODE.manual };
	// One pointer in both states (the samplerSetId analog): "backend" is the
	// "no VT template" entry — the backend's own glue (the "no set" analog).
	const selection = stored?.selection ?? "backend";
	const selectedCustomId = selection.startsWith(CUSTOM_TEMPLATE_SELECTION_PREFIX)
		? selection.slice(CUSTOM_TEMPLATE_SELECTION_PREFIX.length)
		: null;
	const appliedSequences = effectiveTemplateSequences(selection, templates);
	const isDirty = isManual && appliedSequences !== null && sequencesDiverge(manualFormat, appliedSequences);

	useEffect(() => {
		let cancelled = false;
		void listFormatTemplates()
			.then((list) => {
				if (!cancelled) setTemplates(list);
			})
			.catch(() => {
				// The library is optional polish; the block works without it
				// (backend/builtins/manual). A failed load is non-fatal.
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const setStored = (next: ProviderGenerationFormat | null) => updateForm("generationFormat", next);

	/** The manual toggle (customSamplers analog): flips ONLY the mode — the
	 *  template pointer and the manual fields always ride the stored shape, so
	 *  off→on→off cannot lose either. Turning on seeds empty fields from the
	 *  selected template (if any) and opens the accordion. */
	const setManual = (next: boolean) => {
		if (next) {
			const seed = stored?.format ?? (selection !== "backend" ? effectiveTemplateSequences(selection, templates) : null);
			setStored({
				mode: GENERATION_FORMAT_MODE.manual,
				selection,
				format: seed ?? { mode: GENERATION_FORMAT_MODE.manual },
			});
			setAccordionOpen(true);
			return;
		}
		setStored({
			mode: GENERATION_FORMAT_MODE.auto,
			selection,
			...(stored?.format ? { format: stored.format } : {}),
		});
	};

	/** Applying a template (the sampler applySet analog): sets the pointer AND
	 *  writes its sequences into the fields in both toggle states — instant
	 *  manual-readiness, and the dirty-dot baseline. "backend" keeps the
	 *  current fields (nothing to seed — the template lives on the server). */
	const applyTemplate = (next: string) => {
		if (next === "backend") {
			setStored({
				mode: stored?.mode ?? GENERATION_FORMAT_MODE.auto,
				selection: "backend",
				...(stored?.format ? { format: stored.format } : {}),
			});
			return;
		}
		const sequences = effectiveTemplateSequences(next, templates);
		if (!sequences) return;
		setStored({
			mode: stored?.mode ?? GENERATION_FORMAT_MODE.auto,
			selection: next,
			format: sequences,
		});
	};

	const updateManual = (patch: Partial<GenerationFormat>) => {
		const next: GenerationFormat = { ...manualFormat, ...patch, mode: GENERATION_FORMAT_MODE.manual };
		setStored({ mode: GENERATION_FORMAT_MODE.manual, selection, format: next });
	};

	/** Morph confirm: "+" creates a custom from the current manual sequences
	 *  (and applies it — the sampler flow); pencil renames the selected one. */
	const handleMorphConfirm = async () => {
		if (!morph) return;
		const name = morph.value.trim();
		if (!name) return;
		if (templates.some((tpl) => tpl.name.trim().toLowerCase() === name.toLowerCase())) {
			setMorphConflict(true);
			return;
		}
		if (morph.intent === "new") {
			try {
				const created = await createFormatTemplate({ name, payload: { ...manualFormat, mode: GENERATION_FORMAT_MODE.manual } });
				setTemplates((prev) => [...prev, created]);
				// Apply it: pointer + the (unchanged) fields = clean baseline.
				setStored({ mode: stored?.mode ?? GENERATION_FORMAT_MODE.auto, selection: `${CUSTOM_TEMPLATE_SELECTION_PREFIX}${created.id}`, format: manualFormat });
				setMorph(null);
				setMorphConflict(false);
				toast.success(t("providerFormat.savedAsTemplate", { name: created.name }));
			} catch (error) {
				// A raced name collision (server 409) shows the same inline warning.
				setMorphConflict(true);
				toast.error(error instanceof Error ? error.message : t("providerFormat.templateActionFailed"));
			}
			return;
		}
		if (!selectedCustomId) return;
		try {
			const updated = await updateFormatTemplate(selectedCustomId, { name });
			setTemplates((prev) => prev.map((tpl) => (tpl.id === updated.id ? updated : tpl)));
			setMorph(null);
			setMorphConflict(false);
			toast.success(t("providerFormat.templateRenamed"));
		} catch (error) {
			setMorphConflict(true);
			toast.error(error instanceof Error ? error.message : t("providerFormat.templateActionFailed"));
		}
	};

	/** 💾 — save the current manual sequences INTO the selected custom. */
	const handleSaveInto = async () => {
		if (!selectedCustomId) return;
		try {
			const updated = await updateFormatTemplate(selectedCustomId, { payload: { ...manualFormat, mode: GENERATION_FORMAT_MODE.manual } });
			setTemplates((prev) => prev.map((tpl) => (tpl.id === updated.id ? updated : tpl)));
			toast.success(t("providerFormat.templateSaved"));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("providerFormat.templateActionFailed"));
		}
	};

	const handleConfirmDelete = async () => {
		if (!confirmDeleteId) return;
		try {
			await deleteFormatTemplate(confirmDeleteId);
			setTemplates((prev) => prev.filter((tpl) => tpl.id !== confirmDeleteId));
			// A deleted template the profile pointed at degrades to backend
			// (manual fields stay — the profile is now their source).
			if (`${CUSTOM_TEMPLATE_SELECTION_PREFIX}${confirmDeleteId}` === selection) {
				setStored({
					mode: stored?.mode ?? GENERATION_FORMAT_MODE.auto,
					selection: "backend",
					...(stored?.format ? { format: stored.format } : {}),
				});
			}
			setConfirmDeleteId(null);
			toast.success(t("providerFormat.templateDeleted"));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("providerFormat.templateActionFailed"));
			setConfirmDeleteId(null);
		}
	};

	/** ⬆ — ST instruct import (the sampler point-import analog): sequences
	 *  land in the manual editor (the toggle turns on); stop_sequence values
	 *  merge into THIS profile's existing stop-sequences setting (owner
	 *  correction — no duplicate control). */
	const handleImportFile = async (file: File) => {
		try {
			const text = await file.text();
			const kind = detectStFileKind(JSON.parse(text));
			if (kind !== "instruct") {
				toast.error(t("providerFormat.importWrongKind"));
				return;
			}
			const parsed = parseStInstruct(text);
			setStored({ mode: GENERATION_FORMAT_MODE.manual, selection, format: parsed.format });
			setAccordionOpen(true);
			if (parsed.stopSequences.length > 0) {
				const merged = [...form.stopSequences];
				for (const stop of parsed.stopSequences) {
					if (!merged.includes(stop)) merged.push(stop);
				}
				updateForm("stopSequences", merged);
				toast.success(t("promptManager.format.importStopsApplied", { n: String(parsed.stopSequences.length) }));
			}
			toast.success(t("promptManager.format.importedInstruct", { name: parsed.name }));
		} catch {
			toast.error(t("promptManager.format.importUnknown"));
		}
	};

	/** ⬇ — export the selected custom as JSON (the sampler blob download). */
	const handleExport = () => {
		const tpl = templates.find((entry) => entry.id === selectedCustomId);
		if (!tpl) return;
		const json = JSON.stringify(tpl.payload, null, 2);
		const blob = new Blob([json], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `${tpl.name.replace(/[/\\:*?"<>|]/g, "_")}.json`;
		document.body.appendChild(anchor);
		anchor.click();
		document.body.removeChild(anchor);
		URL.revokeObjectURL(url);
	};

	const statusKey =
		tcTemplateSource === "native"
			? "providerFormat.statusNative"
			: tcTemplateSource === "backend"
				? "providerFormat.statusBackend"
				: "providerFormat.statusDefault";
	const fallbackActive = !stored;
	// The inline collision warning is derived from the TYPED name (the sampler
	// morph pattern); morphConflict only backstops raced server 409s.
	const morphNameTaken =
		morph !== null &&
		morph.value.trim().length > 0 &&
		templates.some((tpl) => tpl.name.trim().toLowerCase() === morph.value.trim().toLowerCase());
	const morphShowConflict = morphNameTaken || (morphConflict && morph !== null);

	const iconBtn = "flex h-7 w-7 items-center justify-center rounded text-t3 transition-colors hover:bg-[var(--border)] hover:text-t1 disabled:pointer-events-none disabled:opacity-40";

	return (
		<div className="mt-4" data-testid="provider-format-panel">
			<FramedSection
				title={t("providerFormat.formatTitle")}
				open={accordionOpen}
				onToggle={() => setAccordionOpen((v) => !v)}
				testId="provider-format-sequences"
				headerExtra={
					<div className="flex items-center gap-1">
						{morph ? (
							/* ── Morph state: the dropdown row collapses into a name input +
							    ✓ + ✕ (Enter = save, Esc = cancel, collision warns inline). ── */
							<div className="flex min-w-0 items-center gap-1">
								<div className="flex min-w-0 flex-col">
									<input
										type="text"
										data-testid="provider-format-save-name"
										className={cn(
											"h-7 w-[180px] rounded border bg-bg px-2 text-[12px] text-t1 outline-none",
											morphShowConflict ? "border-danger" : "border-accent",
										)}
										value={morph.value}
										onChange={(e) => {
											setMorph({ ...morph, value: e.target.value });
											setMorphConflict(false);
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") void handleMorphConfirm();
											if (e.key === "Escape") setMorph(null);
										}}
										placeholder={t("providerFormat.templateName")}
										autoFocus
									/>
									{morphShowConflict && (
										<div data-testid="provider-format-name-exists" className="mt-0.5 flex items-center gap-1 text-[10px] text-warning">
											<span className="[&_svg]:h-[10px] [&_svg]:w-[10px]"><Icons.Alert /></span>
											{t("providerFormat.templateNameExists")}
										</div>
									)}
								</div>
								<CustomTooltip content={t("confirm")}>
									<button
										type="button"
										data-testid="provider-format-save-confirm"
										disabled={!morph.value.trim()}
										onClick={(e) => { e.stopPropagation(); void handleMorphConfirm(); }}
										className="flex h-7 w-7 items-center justify-center rounded text-accent-t transition-colors hover:bg-[var(--border)] disabled:pointer-events-none disabled:opacity-40"
										aria-label={t("confirm")}
									>
										<span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Check /></span>
									</button>
								</CustomTooltip>
								<CustomTooltip content={t("cancel")}>
									<button
										type="button"
										onClick={(e) => { e.stopPropagation(); setMorph(null); setMorphConflict(false); }}
										className="flex h-7 w-7 items-center justify-center rounded text-t3 transition-colors hover:bg-[var(--border)] hover:text-t1"
										aria-label={t("cancel")}
									>
										<span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Close /></span>
									</button>
								</CustomTooltip>
							</div>
						) : (
							<div className="flex min-w-0 items-center">
								<DropdownSelect
									value={selection === "backend" ? "" : selection}
									onChange={(id) => applyTemplate(id || "backend")}
									/* Backend = the "no set" analog (the sampler defaultOption
									   slot): the top entry above the groups; picking it = backend glue.
									   DropdownSelect renders groups XOR options, so customs ride
									   their own group (a mixed options+groups list never renders). */
									options={[]}
									defaultOption={t("providerFormat.templateBackend")}
									groups={[
										{
											id: "builtin",
											label: t("providerFormat.builtinGroup"),
											options: BUILTIN_FORMAT_TEMPLATES.map((tpl) => ({ id: `builtin:${tpl.id}`, label: tpl.label })),
										},
										{
											id: "custom",
											label: t("providerFormat.customGroup"),
											options: templates.map((tpl) => ({
												id: `${CUSTOM_TEMPLATE_SELECTION_PREFIX}${tpl.id}`,
												label: tpl.name,
											})),
										},
									]}
									/* Inline slot (AGENTS.md inline-row gotcha): bounded auto
									   width, no form-fill trigger, no detail in the collapsed
									   trigger; the popup gets its own fixed width. */
									triggerClassName="h-7 w-auto max-w-[200px] rounded border border-border bg-s2 px-2 py-0 text-[12px] hover:border-accent"
									triggerDetail={false}
									contentWidth={260}
									triggerLeading={
										isDirty ? (
											/* Dirty dot: the manual fields diverge from the selected
											   template. Cleared by 💾 and by re-applying. */
											<span
												data-testid="provider-format-dirty-dot"
												className="h-[6px] w-[6px] shrink-0 rounded-full bg-accent"
											/>
										) : undefined
									}
									triggerTestId="provider-format-template"
								/>
							</div>
						)}
						{/* Icon-only action row (tooltips only, no labels). The
						    template-targeting actions are disabled without a custom
						    selected (no target = no action); 🔄 needs any real template. */}
						<CustomTooltip content={t("providerFormat.templateNew")}>
							<button
								type="button"
								data-testid="provider-format-template-new"
								onClick={(e) => { e.stopPropagation(); setMorph({ intent: "new", value: "" }); }}
								className={iconBtn}
								aria-label={t("providerFormat.templateNew")}
							>
								<span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Plus /></span>
							</button>
						</CustomTooltip>
						<CustomTooltip content={t("providerFormat.templateSave")}>
							<button
								type="button"
								data-testid="provider-format-template-save"
								disabled={!selectedCustomId}
								onClick={(e) => { e.stopPropagation(); void handleSaveInto(); }}
								className={iconBtn}
								aria-label={t("providerFormat.templateSave")}
							>
								<span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Floppy /></span>
							</button>
						</CustomTooltip>
						<CustomTooltip content={t("providerFormat.templateRename")}>
							<button
								type="button"
								data-testid="provider-format-template-rename"
								disabled={!selectedCustomId}
								onClick={(e) => { e.stopPropagation(); const tpl = templates.find((entry) => entry.id === selectedCustomId); setMorph({ intent: "rename", value: tpl?.name ?? "" }); }}
								className={iconBtn}
								aria-label={t("providerFormat.templateRename")}
							>
								<span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Edit /></span>
							</button>
						</CustomTooltip>
						<CustomTooltip content={t("providerFormat.templateReapply")}>
							<button
								type="button"
								data-testid="provider-format-template-reapply"
								disabled={selection === "backend"}
								onClick={(e) => { e.stopPropagation(); applyTemplate(selection); }}
								className={iconBtn}
								aria-label={t("providerFormat.templateReapply")}
							>
								<span className="[&_svg]:h-[11px] [&_svg]:w-[11px]"><Icons.Regen /></span>
							</button>
						</CustomTooltip>
						<CustomTooltip content={t("providerFormat.templateDelete")}>
							<button
								type="button"
								data-testid="provider-format-template-delete"
								disabled={!selectedCustomId}
								onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(selectedCustomId); }}
								className={cn(iconBtn, "hover:text-danger")}
								aria-label={t("providerFormat.templateDelete")}
							>
								<span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Trash /></span>
							</button>
						</CustomTooltip>
						<CustomTooltip content={t("promptManager.format.importTooltip")}>
							<button
								type="button"
								data-testid="provider-format-import"
								onClick={(e) => { e.stopPropagation(); importInputRef.current?.click(); }}
								className={iconBtn}
								aria-label={t("promptManager.format.importTooltip")}
							>
								<span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Import /></span>
							</button>
						</CustomTooltip>
						<CustomTooltip content={t("providerFormat.templateExport")}>
							<button
								type="button"
								data-testid="provider-format-template-export"
								disabled={!selectedCustomId}
								onClick={(e) => { e.stopPropagation(); handleExport(); }}
								className={iconBtn}
								aria-label={t("providerFormat.templateExport")}
							>
								<span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Download /></span>
							</button>
						</CustomTooltip>
						{/* Hidden file input for the ⬆ point-import. */}
						<input
							ref={importInputRef}
							type="file"
							accept=".json"
							className="hidden"
							onChange={(e) => {
								const file = e.target.files?.[0];
								e.target.value = "";
								if (file) void handleImportFile(file);
							}}
						/>
						{/* Manual toggle (the customSamplers analog) — right in the
						    accordion header; OFF = auto (greyed body), ON = manual. */}
						<div
							data-testid="provider-format-manual-toggle"
							role="switch"
							aria-checked={isManual}
							aria-label={t("providerFormat.manualToggleAria")}
							className={cn("relative ml-1 h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors", isManual ? "bg-accent" : "bg-s3")}
							onClick={(e) => { e.stopPropagation(); setManual(!isManual); }}
						>
							<div className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform", isManual ? "translate-x-[18px]" : "translate-x-0.5")} />
						</div>
					</div>
				}
			>
				<div className="flex flex-col gap-4">
					{/* PREVIEW FIRST (owner 2026-09-09 audit 3) — a collapsible
					    NESTED accordion, before the sequence inputs. */}
					<div data-testid="provider-format-preview" className="overflow-hidden rounded-lg border border-border2">
						<button
							type="button"
							data-testid="provider-format-preview-toggle"
							aria-expanded={previewOpen}
							onClick={() => setPreviewOpen((v) => !v)}
							className="flex w-full cursor-pointer items-center gap-2 bg-s2 px-3 py-2 font-ui text-[12px] font-medium text-t1 transition-colors hover:bg-[var(--border)]"
						>
							<span className={cn("transition-transform", previewOpen && "rotate-90")}>
								<Icons.Caret direction="r" />
							</span>
							{t("providerFormat.previewTitle")}
						</button>
						<AnimatedDisclosure open={previewOpen}>
							<div className="border-t border-border2 bg-surface p-3">
								<div className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-s2 p-3 font-mono text-xs leading-relaxed" data-testid="provider-format-preview-body">
									{buildFormatPreviewSegments(manualFormat, {
										system: t("providerFormat.previewDemoSystem"),
										user: t("providerFormat.previewDemoUser"),
										assistant: t("providerFormat.previewDemoAssistant"),
									}).map((segment, index) => (
										<span
											key={index}
											className={cn(
												segment.kind === "seq" && "rounded bg-s3 px-0.5 text-accent",
												segment.kind === "suffix" && "text-t3",
											)}
										>
											{segment.text}
										</span>
									))}
								</div>
								<div className="mt-2 font-ui text-[11px] text-t3">{t("providerFormat.previewLegend")}</div>
							</div>
						</AnimatedDisclosure>
					</div>

					{/* The editable block: greyed + inert while the manual toggle
					    is OFF (the sampler grid rule). */}
					<div data-testid="provider-format-fields" className={cn("flex flex-col gap-4", !isManual && "pointer-events-none opacity-40")}>
						{/* Main three up top with plain-language hints; the rest in a
						    clean group below (owner: NO "rare fields" branding). */}
						<div className="flex flex-col gap-4">
							<SequenceField label={t("promptManager.format.inputSequence")} hint={t("providerFormat.hintUser")} value={manualFormat.inputSequence ?? ""} onChange={(v) => updateManual({ inputSequence: v })} />
							<SequenceField label={t("promptManager.format.outputSequence")} hint={t("providerFormat.hintAssistant")} value={manualFormat.outputSequence ?? ""} onChange={(v) => updateManual({ outputSequence: v })} />
							<SequenceField label={t("promptManager.format.systemSequence")} hint={t("providerFormat.hintSystem")} value={manualFormat.systemSequence ?? ""} onChange={(v) => updateManual({ systemSequence: v })} />
						</div>
						<div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
							<SequenceField label={t("promptManager.format.firstOutputSequence")} value={manualFormat.firstOutputSequence ?? ""} onChange={(v) => updateManual({ firstOutputSequence: v })} />
							<SequenceField label={t("promptManager.format.lastOutputSequence")} value={manualFormat.lastOutputSequence ?? ""} onChange={(v) => updateManual({ lastOutputSequence: v })} />
							<SequenceField label={t("promptManager.format.systemSequencePrefix")} value={manualFormat.systemSequencePrefix ?? ""} onChange={(v) => updateManual({ systemSequencePrefix: v })} />
							<SequenceField label={t("promptManager.format.systemSequenceSuffix")} value={manualFormat.systemSequenceSuffix ?? ""} onChange={(v) => updateManual({ systemSequenceSuffix: v })} />
							<SequenceField label={t("promptManager.format.inputSuffix")} value={manualFormat.inputSuffix ?? ""} onChange={(v) => updateManual({ inputSuffix: v })} />
							<SequenceField label={t("promptManager.format.outputSuffix")} value={manualFormat.outputSuffix ?? ""} onChange={(v) => updateManual({ outputSuffix: v })} />
							<SequenceField label={t("promptManager.format.systemSuffix")} value={manualFormat.systemSuffix ?? ""} onChange={(v) => updateManual({ systemSuffix: v })} />

							<div className="flex items-center gap-3">
								<Toggle
									checked={manualFormat.wrap === true}
									onChange={(v) => updateManual({ wrap: v })}
									aria-label={t("promptManager.format.wrap")}
								/>
								<div>
									<div className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2">{t("promptManager.format.wrap")}</div>
									<div className="font-ui text-[11px] text-t3">{t("promptManager.format.wrapHint")}</div>
								</div>
							</div>

							<div>
								<label className={lblCls}>{t("promptManager.format.namesBehavior")}</label>
								<SegmentedControl<NamesBehavior>
									value={manualFormat.namesBehavior ?? NAMES_BEHAVIOR.force}
									options={[
										{ value: NAMES_BEHAVIOR.force, label: t("promptManager.format.namesForce") },
										{ value: NAMES_BEHAVIOR.always, label: t("promptManager.format.namesAlways") },
										{ value: NAMES_BEHAVIOR.never, label: t("promptManager.format.namesNever") },
									]}
									onChange={(v) => updateManual({ namesBehavior: v })}
								/>
								<div className="mt-1 font-ui text-[11px] text-t3">{t("promptManager.format.namesHint")}</div>
							</div>
						</div>

						{/* LS-9 owner rule, the nudge: manual = the user owns the
						    template AND its stops — an empty stop list lets the model
						    write the user's turn (the owner's live runaway catch). */}
						{isManual && form.stopSequences.length === 0 && (
							<div className="flex items-start gap-2 rounded-md border border-border2 bg-s2 px-3 py-2.5" data-testid="provider-format-stops-empty-hint">
								<div className="mt-0.5 text-t3 [&_svg]:h-[14px] [&_svg]:w-[14px]"><Icons.Alert /></div>
								<div className="font-ui text-[11px] text-t3">{t("providerFormat.stopsEmptyHint")}</div>
							</div>
						)}
					</div>
				</div>
			</FramedSection>

			{/* The source status + the honest fallback note live UNDER the
			    accordion (they describe the whole block, not the manual body). */}
			{!isManual && (
				<div className="mt-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 italic">
					{t(statusKey)}
				</div>
			)}
			{fallbackActive && (
				<div className="mt-1 font-ui text-[11px] text-t3">
					{t("providerFormat.fallbackNote")}
				</div>
			)}

			{confirmDeleteId && (
				<DestructiveConfirmModal
					title={t("providerFormat.templateDeleteTitle")}
					body={t("providerFormat.templateDeleteBody", { name: templates.find((tpl) => tpl.id === confirmDeleteId)?.name ?? "" })}
					onConfirm={() => { void handleConfirmDelete(); }}
					onCancel={() => setConfirmDeleteId(null)}
				/>
			)}
		</div>
	);
}

/** Materialize a selection's sequences (built-ins from domain — the single
 *  source the dropdown reads; customs from the loaded library). Null =
 * nothing to seed (backend — the template lives on the server). */
function effectiveTemplateSequences(selection: string, templates: FormatTemplate[]): GenerationFormat | null {
	if (selection.startsWith("builtin:")) {
		const id = selection.slice("builtin:".length);
		const builtin = BUILTIN_FORMAT_TEMPLATES.find((tpl) => tpl.id === id);
		return builtin ? { ...builtin.format } : null;
	}
	if (selection.startsWith(CUSTOM_TEMPLATE_SELECTION_PREFIX)) {
		const id = selection.slice(CUSTOM_TEMPLATE_SELECTION_PREFIX.length);
		const tpl = templates.find((entry) => entry.id === id);
		if (!tpl) return null;
		const payload = tpl.payload as Partial<GenerationFormat>;
		return { ...payload, mode: GENERATION_FORMAT_MODE.manual };
	}
	return null;
}
