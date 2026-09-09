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
import { lblCls, monoCls } from "../../build/fields/field-styles.js";
import { buildFormatPreviewSegments } from "../../../lib/format-preview.js";
import {
	createFormatTemplate,
	deleteFormatTemplate,
	listFormatTemplates,
} from "../../../api/format-template-api.js";
import { detectStFileKind, parseStInstruct } from "@vibe-tavern/import-export";
import type { FormState } from "../../modals/ProviderModal.js";

/**
 * The provider-side generation format block (LOCAL_SUPPORT_PLAN LS-10, owner
 * design 2026-09-09): parked in provider settings UNDER the Чат/Текст switch
 * (renders only in Текст mode — except native-TC KoboldCPP, where it renders
 * always). Structure:
 *
 *   [Авто | Ручной] toggle (the visibility semantics owner — LS-6c)
 *   AUTO:  template dropdown — «Шаблон бэкенда» (today's auto) + VT built-ins
 *          + user-saved customs (selectable WITHOUT manual editing)
 *   MANUAL: collapsible framed sequences editor (grouped fields, plain
 *          hints) + save-as-new (the LS-5 sampler-set morph/collision
 *          pattern) + collapsible framed LIVE PREVIEW with per-sequence
 *          highlighting + the LS-9 empty-stops hint.
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

/** Single-line monospace field for one sequence — sequences are template
 *  strings (`<|im_start|>user`, `\n`, …), so they render mono. */
function SequenceField(props: {
	label: string;
	hint?: string;
	value: string;
	onChange: (next: string) => void;
}) {
	return (
		<div>
			<label className={lblCls}>{props.label}</label>
			<input
				type="text"
				className={cn(monoCls, "h-8 px-2")}
				value={props.value}
				onChange={(e) => props.onChange(e.target.value)}
				spellCheck={false}
			/>
			{props.hint && <div className="mt-1 font-ui text-[11px] text-t3">{props.hint}</div>}
		</div>
	);
}

/** A collapsible framed section (the LS-3 pane's framed-accordion chrome over
 *  the shared AnimatedDisclosure body transition). */
function FramedSection(props: {
	title: string;
	open: boolean;
	onToggle: () => void;
	children: React.ReactNode;
	testId?: string;
}) {
	return (
		<div className="overflow-hidden rounded-lg border border-border2">
			<button
				type="button"
				onClick={props.onToggle}
				aria-expanded={props.open}
				data-testid={props.testId ? `${props.testId}-toggle` : undefined}
				className="flex w-full cursor-pointer items-center justify-between bg-s2 px-3 py-2.5 font-ui text-[13px] font-medium text-t1 transition-colors hover:bg-[var(--border)]"
			>
				<span className="flex items-center gap-2">
					<span className={cn("transition-transform", props.open && "rotate-90")}>
						<svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9">
							<polyline points="6 3 11 8 6 13"></polyline>
						</svg>
					</span>
					{props.title}
				</span>
			</button>
			<AnimatedDisclosure open={props.open} keepMounted>
				<div className="border-t border-border2 bg-surface p-4">{props.children}</div>
			</AnimatedDisclosure>
		</div>
	);
}

export function ProviderFormatPanel({ form, updateForm, tcTemplateSource }: ProviderFormatPanelProps) {
	const { t } = useT();
	const stored = form.generationFormat ?? null;
	const [templates, setTemplates] = useState<FormatTemplate[]>([]);
	const [sequencesOpen, setSequencesOpen] = useState(false);
	const [previewOpen, setPreviewOpen] = useState(false);
	// The save-as-new morph (LS-5 pattern): the action row morphs into a name
	// input while active; a collision shows the inline warning line.
	const [namingOpen, setNamingOpen] = useState(false);
	const [namingValue, setNamingValue] = useState("");
	const importInputRef = useRef<HTMLInputElement>(null);

	const isManual = stored?.mode === GENERATION_FORMAT_MODE.manual;
	const manualFormat: GenerationFormat = isManual
		? stored?.format ?? { mode: GENERATION_FORMAT_MODE.manual }
		: { mode: GENERATION_FORMAT_MODE.manual };

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

	const setMode = (mode: "auto" | "manual") => {
		if (mode === "manual") {
			// Seed the editor from the currently-effective template so tweaking a
			// selected builtin/custom starts from its sequences (not from empty).
			const selection = stored?.mode === "auto" ? stored.selection : undefined;
			const seed = stored?.format ?? (selection && selection !== "backend" ? effectiveTemplateSequences(selection, templates) : null);
			setStored({ mode: GENERATION_FORMAT_MODE.manual, format: seed ?? { mode: GENERATION_FORMAT_MODE.manual } });
			setSequencesOpen(true);
			return;
		}
		// Manual → auto: keep the last selection if there was one, else backend.
		setStored({ mode: GENERATION_FORMAT_MODE.auto, selection: stored?.selection ?? "backend" });
	};

	const setSelection = (selection: string) => {
		setStored({ mode: GENERATION_FORMAT_MODE.auto, selection });
	};

	const updateManual = (patch: Partial<GenerationFormat>) => {
		const next: GenerationFormat = { ...manualFormat, ...patch, mode: GENERATION_FORMAT_MODE.manual };
		setStored({ mode: GENERATION_FORMAT_MODE.manual, format: next });
	};

	/** Save-as-new (the LS-5 flow): the current manual sequences persist as a
	 *  named custom template; the profile then APPLIES it (auto + selection). */
	const handleSaveAsNew = async () => {
		const name = namingValue.trim();
		if (!name) return;
		const collision = templates.some((tpl) => tpl.name.trim().toLowerCase() === name.toLowerCase());
		if (collision) return; // the inline warning already shows; the server 409 backstops
		try {
			const created = await createFormatTemplate({ name, payload: { ...manualFormat, mode: GENERATION_FORMAT_MODE.manual } });
			setTemplates((prev) => [...prev, created]);
			setStored({ mode: GENERATION_FORMAT_MODE.auto, selection: `${CUSTOM_TEMPLATE_SELECTION_PREFIX}${created.id}` });
			setNamingOpen(false);
			setNamingValue("");
			toast.success(t("providerFormat.savedAsTemplate", { name: created.name }));
		} catch {
			toast.error(t("providerFormat.saveFailed"));
		}
	};

	const handleDeleteTemplate = async (id: string) => {
		try {
			await deleteFormatTemplate(id);
			setTemplates((prev) => prev.filter((tpl) => tpl.id !== id));
			// A deleted template the profile pointed at degrades to backend auto.
			if (stored?.selection === `${CUSTOM_TEMPLATE_SELECTION_PREFIX}${id}`) {
				setStored({ mode: GENERATION_FORMAT_MODE.auto, selection: "backend" });
			}
		} catch {
			toast.error(t("providerFormat.deleteFailed"));
		}
	};

	/** ST instruct import (retargeted from the retired prompt-manager tab):
	 *  sequences land in the manual editor; stop_sequence values merge into
	 *  THIS profile's existing stop-sequences setting (owner correction — no
	 *  duplicate control). */
	const handleImportFile = async (file: File) => {
		try {
			const text = await file.text();
			const kind = detectStFileKind(JSON.parse(text));
			if (kind !== "instruct") {
				toast.error(t("providerFormat.importWrongKind"));
				return;
			}
			const parsed = parseStInstruct(text);
			setStored({ mode: GENERATION_FORMAT_MODE.manual, format: parsed.format });
			setSequencesOpen(true);
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

	const statusKey =
		tcTemplateSource === "native"
			? "providerFormat.statusNative"
			: tcTemplateSource === "backend"
				? "providerFormat.statusBackend"
				: "providerFormat.statusDefault";
	const fallbackActive = !stored;
	const namingCollision =
		namingOpen &&
		namingValue.trim().length > 0 &&
		templates.some((tpl) => tpl.name.trim().toLowerCase() === namingValue.trim().toLowerCase());

	const templateOptions = [
		{ id: "backend", label: t("providerFormat.templateBackend") },
		...templates.map((tpl) => ({
			id: `${CUSTOM_TEMPLATE_SELECTION_PREFIX}${tpl.id}`,
			label: tpl.name,
			onDelete: () => void handleDeleteTemplate(tpl.id),
		})),
	];

	return (
		<div className="mt-4" data-testid="provider-format-panel">
			{/* Mode toggle — the visibility semantics owner (LS-6c): auto greys the
			    manual editor away, manual reveals it editable. */}
			<SegmentedControl<"auto" | "manual">
				value={isManual ? "manual" : "auto"}
				options={[
					{ value: "auto", label: t("providerFormat.modeAuto") },
					{ value: "manual", label: t("providerFormat.modeManual") },
				]}
				onChange={(v) => setMode(v)}
			/>

			{/* AUTO: the template dropdown (owner: selectable already in auto). */}
			{!isManual && (
				<div className="mt-3">
					<label className={lblCls}>{t("providerFormat.template")}</label>
					<DropdownSelect
						value={stored?.selection ?? "backend"}
						onChange={setSelection}
						options={templateOptions}
						groups={[
							{
								id: "builtin",
								label: t("providerFormat.builtinGroup"),
								options: BUILTIN_FORMAT_TEMPLATES.map((tpl) => ({ id: `builtin:${tpl.id}`, label: tpl.label })),
							},
						]}
						triggerTestId="provider-format-template"
					/>
					<div className="mt-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 italic">
						{t(statusKey)}
					</div>
					{fallbackActive && (
						<div className="mt-1 font-ui text-[11px] text-t3">
							{t("providerFormat.fallbackNote")}
						</div>
					)}
				</div>
			)}

			{/* MANUAL: collapsible framed editor + preview + the LS-9 hint. */}
			{isManual && (
				<div className="mt-3 flex flex-col gap-3">
					{/* Save-as-new + import row (LS-5 morph + the ST import entry). */}
					<div className="flex flex-wrap items-center gap-2">
						{namingOpen ? (
							<>
								<input
									type="text"
									value={namingValue}
									onChange={(e) => setNamingValue(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") void handleSaveAsNew();
										if (e.key === "Escape") {
											setNamingOpen(false);
											setNamingValue("");
										}
									}}
									placeholder={t("providerFormat.templateName")}
									autoFocus
									className={cn(monoCls, "h-8 max-w-[220px] flex-1 px-2", namingCollision && "border-danger")}
									data-testid="provider-format-save-name"
								/>
								<CustomTooltip content={t("save")}>
									<button
										type="button"
										onClick={() => void handleSaveAsNew()}
										disabled={!namingValue.trim()}
										className="flex h-7 cursor-pointer items-center rounded-md border border-border bg-s3 px-2 text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-45"
										data-testid="provider-format-save-confirm"
									>
										<Icons.Check />
									</button>
								</CustomTooltip>
								<button
									type="button"
									onClick={() => {
										setNamingOpen(false);
										setNamingValue("");
									}}
									className="flex h-7 cursor-pointer items-center rounded-md border border-border bg-s3 px-2 text-t2 transition-all hover:bg-s2 hover:text-t1"
								>
									<Icons.Close />
								</button>
							</>
						) : (
							<CustomTooltip content={t("providerFormat.saveAsNew")}>
								<button
									type="button"
									onClick={() => setNamingOpen(true)}
									className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1"
									data-testid="provider-format-save-new"
								>
									<Icons.Plus />
									{t("providerFormat.saveAsNew")}
								</button>
							</CustomTooltip>
						)}
						<CustomTooltip content={t("promptManager.format.importTooltip")}>
							<button
								type="button"
								onClick={() => importInputRef.current?.click()}
								className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1"
								data-testid="provider-format-import"
							>
								<span className="[&_svg]:h-[13px] [&_svg]:w-[13px]"><Icons.Import /></span>
								{t("promptManager.format.import")}
							</button>
						</CustomTooltip>
					</div>
					{namingCollision && (
						<div className="flex items-center gap-1.5 font-ui text-[11px] text-danger" data-testid="provider-format-name-exists">
							<Icons.Alert />
							{t("providerFormat.templateNameExists")}
						</div>
					)}
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

					<FramedSection
						title={t("providerFormat.sequencesTitle")}
						open={sequencesOpen}
						onToggle={() => setSequencesOpen((v) => !v)}
						testId="provider-format-sequences"
					>
						<div className="flex flex-col gap-4">
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
							{form.stopSequences.length === 0 && (
								<div className="flex items-start gap-2 rounded-md border border-border2 bg-s2 px-3 py-2.5" data-testid="provider-format-stops-empty-hint">
									<div className="mt-0.5 text-t3 [&_svg]:h-[14px] [&_svg]:w-[14px]"><Icons.Alert /></div>
									<div className="font-ui text-[11px] text-t3">{t("providerFormat.stopsEmptyHint")}</div>
								</div>
							)}
						</div>
					</FramedSection>

					<FramedSection
						title={t("providerFormat.previewTitle")}
						open={previewOpen}
						onToggle={() => setPreviewOpen((v) => !v)}
						testId="provider-format-preview"
					>
						<div className="break-all whitespace-pre-wrap overflow-x-auto rounded-md border border-border bg-s2 p-3 font-mono text-xs leading-relaxed">
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
					</FramedSection>
				</div>
			)}
		</div>
	);
}

/** Materialize a selection's sequences for the manual-editor seed (built-ins
 *  from domain — the single source the dropdown reads; customs from the
 *  loaded library). Null = nothing editable to seed (backend/default). */
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
