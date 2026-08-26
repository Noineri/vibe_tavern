import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../../../i18n/context.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { Modal } from "../../shared/Modal.js";
import { BottomSheet } from "../../shared/BottomSheet.js";
import { AiAssistantShell } from "../../shared/ai-assistant/AiAssistantShell.js";
import { AiAssistantConnectionFields } from "../../shared/ai-assistant/AiAssistantConnectionFields.js";
import { useAiAssistantRunner } from "../../shared/ai-assistant/use-ai-assistant-runner.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import { Icons } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { lblCls, monoUICls } from "../../build/fields/field-styles.js";
import { requestRegexAssist } from "../../../api/regex-assist-api.js";
import type {
	RegexAssistArchetype,
	RegexAssistRequest,
	RegexAssistResponse,
} from "@vibe-tavern/api-contracts";
import type Resources from "../../../i18n/resources.js";

/** A statically-known i18n key — keeps the archetype/label tables compile-checked. */
type I18nKey = keyof Resources["en"];
import type { RegexPresetDraft } from "./RegexPresetEditor.js";
import { compileRegexScript, parseFindRegex } from "@vibe-tavern/prompt-pipeline";
import { brandId, type RegexPreset } from "@vibe-tavern/domain";

const ARCHETYPES: Array<{ id: RegexAssistArchetype; labelKey: I18nKey }> = [
	{ id: "invisible", labelKey: "regexAssistant.archetypeInvisible" },
	{ id: "code_wrappers", labelKey: "regexAssistant.archetypeCodeWrappers" },
	{ id: "history_hygiene", labelKey: "regexAssistant.archetypeHistoryHygiene" },
	{ id: "model_noise", labelKey: "regexAssistant.archetypeModelNoise" },
	{ id: "tts_prep", labelKey: "regexAssistant.archetypeTtsPrep" },
	{ id: "custom", labelKey: "regexAssistant.archetypeCustom" },
];

/** Max automatic refine turns after parse-error / no-match (plan Wave 3). */
const MAX_AUTO_REFINES = 2;

// Reuse the rule editor's own vocabulary for the draft summary (no duplicates).
const APPLY_TARGET_LABEL_KEYS: Record<RegexAssistResponse["draft"]["applyTarget"], I18nKey> = {
	persist: "promptManager.regex.applyPersist",
	display: "promptManager.regex.applyDisplay",
	prompt: "promptManager.regex.applyPrompt",
	display_prompt: "promptManager.regex.applyDisplayPrompt",
};
const DEPTH_MODE_LABEL_KEYS: Record<RegexAssistResponse["draft"]["depthMode"], I18nKey> = {
	all: "promptManager.regex.depthModeAll",
	recent: "promptManager.regex.depthModeRecent",
	older: "promptManager.regex.depthModeOlder",
	range: "promptManager.regex.depthModeRange",
};

/** Depth fields from the editor draft → wire depthMode for currentRule. */
function depthModeOfFields(minDepth: string | undefined, maxDepth: string | undefined): "all" | "recent" | "older" | "range" {
	const min = (minDepth ?? "").trim() !== "";
	const max = (maxDepth ?? "").trim() !== "";
	if (min && max) return "range";
	if (min) return "older";
	if (max) return "recent";
	return "all";
}

type LiveTest =
	| { kind: "idle" }
	| { kind: "error"; message: string }
	| { kind: "noMatch"; markedView: string; removedCount: number; isAiSample: boolean }
	| { kind: "ok"; output: string; markedView: string; removedCount: number; unchanged: boolean; isAiSample: boolean };

export interface RegexAiAssistantModalProps {
	isOpen: boolean;
	onClose: () => void;
	onApply: (patch: Partial<RegexPresetDraft>) => void;
	/** Editor draft for refine-in-place: current fields go out as context. */
	currentRule?: Partial<RegexPresetDraft>;
}

export function RegexAiAssistantModal({ isOpen, onClose, onApply, currentRule }: RegexAiAssistantModalProps) {
	const { t } = useT();
	const isMobile = useIsMobile();
	const bootstrapUi = useBootstrapStore((s) => s.data?.uiSettings ?? null);
	const providerProfiles = useProviderDataStore((s) => s.profiles);

	const [task, setTask] = useState("");
	const [archetype, setArchetype] = useState<RegexAssistArchetype>("invisible");
	const [sampleText, setSampleText] = useState("");
	const [draft, setDraft] = useState<RegexAssistResponse["draft"] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [generating, setGenerating] = useState(false);
	const [autoRefines, setAutoRefines] = useState(0);
	/** Last test verdict — carried into refinement turns (plan: user refinements
	 *  carry test context; persists across generations until reset). */
	const [lastTestResult, setLastTestResult] = useState<string | null>(null);

	const runner = useAiAssistantRunner({
		isOpen,
		seedProviderId: bootstrapUi?.aiAssistantProviderId ?? "",
		seedModelName: bootstrapUi?.aiAssistantModelName ?? "",
		persistSelection: true,
	});

	const reset = useCallback(() => {
		setTask("");
		setSampleText("");
		setDraft(null);
		setError(null);
		setAutoRefines(0);
		setLastTestResult(null);
	}, []);

	useEffect(() => {
		if (!isOpen) reset();
	}, [isOpen, reset]);

	// ── Live test: the SAME pure engine the editor test pane uses ──
	const live = useMemo<LiveTest>(() => {
		if (!draft) return { kind: "idle" };
		const find = draft.findRegex ?? "";
		if (!find.trim()) return { kind: "idle" };
		const parsed = parseFindRegex(find);
		let probe: RegExp;
		try {
			probe = new RegExp(parsed.pattern, parsed.flags);
		} catch (e) {
			return { kind: "error", message: e instanceof Error ? e.message : String(e) };
		}
		const input = sampleText.trim() ? sampleText : (draft.sampleText ?? "");
		const isAiSample = !sampleText.trim() && Boolean(draft.sampleText);
		if (!input) return { kind: "idle" };
		const testPreset: RegexPreset = {
			id: brandId("regex-ai-live"),
			name: draft.name ?? "",
			findRegex: find,
			replaceString: draft.replaceString ?? "",
			trimStrings: draft.trimStrings ?? [],
			substituteRegex: 0,
			disabled: false,
			markdownOnly: false,
			promptOnly: false,
			runOnEdit: true,
			minDepth: null,
			maxDepth: null,
			placement: [2],
			isGlobal: false,
			sortOrder: 0,
			profileId: null,
			createdAt: "",
			updatedAt: "",
		};
		const compiled = compileRegexScript(testPreset);
		if (!compiled) return { kind: "error", message: t("regexAssistant.testInvalidPattern") };
		const output = compiled.run(input);
		// Removed-span marker view: re-run the pattern over the input and wrap
		// each match's computed replacement in ⟨…⟩. For invisible-char rules this
		// is the only visual proof anything happened — the brackets localize
		// exactly where spans were removed («a⟨⟩b» for a ZWSP between a and b).
		const applyReplacement = (match: string, groups: Array<string | undefined>): string => {
			let out = (draft.replaceString ?? "").split("{{match}}").join(match);
			for (let i = 1; i <= 9; i++) {
				out = out.split("$" + i).join(groups[i - 1] ?? "");
			}
			return out;
		};
		let markedView = input;
		try {
			const markerRe = new RegExp(parsed.pattern, parsed.flags.includes("g") ? parsed.flags : parsed.flags + "g");
			let lastIdx = 0;
			let m: RegExpExecArray | null;
			let marked = "";
			while ((m = markerRe.exec(input)) !== null) {
				if (m[0] === "") {
					markerRe.lastIndex++;
					continue;
				}
				marked += input.slice(lastIdx, m.index);
				marked += `⟨${applyReplacement(m[0], m.slice(1))}⟩`;
				lastIdx = m.index + m[0].length;
			}
			marked += input.slice(lastIdx);
			markedView = marked;
		} catch {
			markedView = output;
		}
		const removedCount = Math.max(0, input.length - output.length);
		if (!probe.test(input)) {
			return { kind: "noMatch", markedView, removedCount, isAiSample };
		}
		return {
			kind: "ok",
			output,
			markedView,
			removedCount,
			unchanged: output === input,
			isAiSample,
		};
	}, [draft, sampleText, t]);

	// Track the latest verdict for refinement context (errors/no-match feed
	// the refine loop; a passing verdict clears the failure context).
	useEffect(() => {
		if (live.kind === "error") setLastTestResult(`Parse error: ${live.message}`);
		else if (live.kind === "noMatch") setLastTestResult("No match on sample text");
		else if (live.kind === "ok" && live.unchanged) setLastTestResult("Output equals input — rule has no visible effect");
		else if (live.kind === "ok") setLastTestResult(null);
	}, [live]);

	const doGenerate = useCallback(
		async (opts?: { refinementNote?: string; testContext?: string | null }) => {
			if (!runner.providerId) {
				setError(t("regexAssistant.noProvider"));
				return;
			}
			const effectiveTask = [task.trim(), opts?.refinementNote?.trim()].filter(Boolean).join("\n\n");
			if (!effectiveTask) return;
			setGenerating(true);
			setError(null);
			const currentRuleWire: RegexAssistRequest["currentRule"] = currentRule
				? {
					name: currentRule.name,
					findRegex: currentRule.findRegex,
					replaceString: currentRule.replaceString,
					trimStrings: (currentRule.trimStrings ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
					applyTarget: currentRule.applyTarget,
					depthMode: depthModeOfFields(currentRule.minDepth, currentRule.maxDepth),
				}
				: undefined;
			const previousAttempt: RegexAssistRequest["previousAttempt"] =
				opts?.testContext && draft ? { rule: draft, testResult: opts.testContext } : undefined;
			try {
				const res = await requestRegexAssist({
					providerProfileId: runner.providerId,
					model: runner.modelName || undefined,
					task: effectiveTask,
					archetype,
					sampleText: sampleText.trim() || undefined,
					currentRule: currentRuleWire,
					previousAttempt,
				});
				setDraft(res.draft);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setGenerating(false);
			}
		},
		[runner.providerId, runner.modelName, task, archetype, sampleText, currentRule, draft, t],
	);

	// Auto-refine ≤2: on parse-error / no-match WITH a user sample, feed the
	// test result back automatically. The verdict is passed EXPLICITLY (not
	// via state) so the refinement request always carries it on the first try.
	useEffect(() => {
		if (!draft || !sampleText.trim() || generating) return;
		if (live.kind !== "error" && live.kind !== "noMatch") return;
		if (autoRefines >= MAX_AUTO_REFINES) return;
		const note =
			live.kind === "error"
				? `Previous test result: parse error — ${live.message}. Fix the pattern.`
				: "Previous test result: no match on the sample text. Fix the pattern.";
		setAutoRefines((c) => c + 1);
		void doGenerate({ refinementNote: note, testContext: note });
	}, [draft, live, sampleText, generating, autoRefines, doGenerate]);

	const handleApply = useCallback(() => {
		if (!draft) return;
		const patch: Partial<RegexPresetDraft> = {
			name: draft.name ?? "",
			findRegex: draft.findRegex ?? "",
			replaceString: draft.replaceString ?? "",
			trimStrings: (draft.trimStrings ?? []).join("\n"),
			applyTarget: draft.applyTarget,
			// Security gate (import parity): a generated rule is NEVER
			// auto-enabled; the user saves and enables by hand.
			disabled: true,
		};
		if (draft.depthMode === "recent") {
			patch.minDepth = "";
			patch.maxDepth = String(draft.depthValue ?? 4);
		} else if (draft.depthMode === "older") {
			patch.minDepth = String(draft.depthValue ?? 4);
			patch.maxDepth = "";
		} else if (draft.depthMode === "range") {
			patch.minDepth = "1";
			patch.maxDepth = String(draft.depthValue ?? 4);
		} else {
			patch.minDepth = "";
			patch.maxDepth = "";
		}
		onApply(patch);
		onClose();
	}, [draft, onApply, onClose]);

	const title = (
		<div className="flex min-w-0 items-center gap-2">
			<span className="shrink-0 text-accent">
				<Icons.sparkles />
			</span>
			<span className="truncate text-sm font-semibold text-t1">{t("regexAssistant.title")}</span>
		</div>
	);

	const footer = (
		<>
			<button
				type="button"
				className="h-[37px] cursor-pointer rounded-md border border-border bg-surface px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2 transition-all hover:bg-s2 hover:text-t1"
				onClick={onClose}
			>
				{t("cancel_btn")}
			</button>
			{draft && (
				<button
					type="button"
					className="h-[37px] cursor-pointer rounded-md border border-border bg-s2 px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t2 transition-all hover:bg-s3 hover:text-t1"
					onClick={() => void doGenerate({ testContext: lastTestResult })}
				>
					{t("regexAssistant.refine")}
				</button>
			)}
			{draft && (
				<button
					type="button"
					className="h-[37px] cursor-pointer rounded-md bg-accent px-4 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-white transition-all hover:brightness-110"
					onClick={handleApply}
				>
					{t("regexAssistant.apply")}
				</button>
			)}
			<button
				type="button"
				className={cn(
					"h-[37px] rounded-md px-4 font-ui text-[calc(var(--ui-fs)-2px)] font-medium transition-all",
					task.trim() && !generating && runner.providerId
						? "cursor-pointer bg-accent text-white hover:brightness-110"
						: "cursor-not-allowed bg-s2 text-t4",
				)}
				disabled={!task.trim() || generating || !runner.providerId}
				onClick={() => void doGenerate()}
			>
				{generating ? t("regexAssistant.generating") : t("regexAssistant.generate")}
			</button>
		</>
	);

	const body = (
		<AiAssistantShell
			title={title}
			onClose={onClose}
			streaming={generating}
			providerCount={providerProfiles.length}
			noProvidersLabel={t("regexAssistant.noProvider")}
			footer={footer}
		>
			<div className="flex flex-col gap-4">
				<AiAssistantConnectionFields
					providerProfiles={providerProfiles}
					providerId={runner.providerId}
					modelName={runner.modelName}
					providerModels={runner.providerModels}
					selectedProfileDefaultModel={runner.selectedProfile?.defaultModel ?? null}
					onProviderChange={runner.handleProviderChange}
					onModelChange={runner.handleModelChange}
					labels={{
						connection: t("regexAssistant.connection"),
						model: t("regexAssistant.model"),
						selectProvider: t("regexAssistant.selectProvider"),
						searchProvider: t("regexAssistant.searchProvider"),
						searchModel: t("regexAssistant.searchModel"),
					}}
				/>
				<div className="flex flex-wrap gap-2">
					{ARCHETYPES.map((a) => (
						<button
							key={a.id}
							type="button"
							onClick={() => setArchetype(a.id)}
							className={
								archetype === a.id
									? "cursor-pointer rounded-full bg-accent px-3 py-1 font-ui text-xs text-white"
									: "cursor-pointer rounded-full border border-border bg-s2 px-3 py-1 font-ui text-xs text-t2 transition-colors hover:text-t1"
							}
						>
							{t(a.labelKey)}
						</button>
					))}
				</div>
				<div>
					<label className={lblCls}>{t("regexAssistant.taskLabel")}</label>
					<AutoTextarea
						className={monoUICls}
						value={task}
						onChange={(e) => setTask(e.target.value)}
						placeholder={t("regexAssistant.taskPlaceholder")}
						minRows={3}
					/>
				</div>
				<div>
					<label className={lblCls}>{t("regexAssistant.sampleLabel")}</label>
					<AutoTextarea
						className={monoUICls}
						value={sampleText}
						onChange={(e) => setSampleText(e.target.value)}
						placeholder={t("regexAssistant.samplePlaceholder")}
						minRows={2}
					/>
				</div>
				{error && (
					<div className="rounded border border-danger bg-danger-dim p-2 font-ui text-xs text-danger-text">{error}</div>
				)}
				{draft && (
					<div className="rounded-md border border-border bg-s2 p-3">
						<div className="font-ui text-xs font-semibold text-t1">{draft.name}</div>
						<div className="mt-1 font-mono text-xs text-t2">find: {draft.findRegex}</div>
						<div className="font-mono text-xs text-t2">replace: {draft.replaceString}</div>
						{draft.trimStrings.length > 0 && (
							<div className="font-mono text-xs text-t2">trim: {draft.trimStrings.join(", ")}</div>
						)}
						<div className="font-ui text-xs text-t2">
							{t("promptManager.regex.behaviorLabel")}: {t(APPLY_TARGET_LABEL_KEYS[draft.applyTarget])} · {t(DEPTH_MODE_LABEL_KEYS[draft.depthMode])}
							{draft.depthValue !== undefined ? ` ${draft.depthValue}` : ""}
						</div>
						<div className="mt-1 font-ui text-xs text-t2">{draft.explanation}</div>
					</div>
				)}
				{live.kind !== "idle" && (
					<div className="rounded-md border border-border2 bg-s3 p-3">
						<div className="font-ui text-xs font-semibold text-t1">{t("regexAssistant.testTitle")}</div>
						{live.kind === "error" && <div className="font-ui text-xs text-danger">{live.message}</div>}
						{live.kind === "noMatch" && <div className="font-ui text-xs text-t3">{t("regexAssistant.testNoMatch")}</div>}
						{(live.kind === "ok" || live.kind === "noMatch") && (
							<>
								<div className="mt-1 whitespace-pre-wrap break-all font-mono text-xs text-t1">{live.markedView}</div>
								<div className="mt-1 font-ui text-xs text-t2">
									{t("regexAssistant.removedCount", { count: live.removedCount })}
								</div>
								{live.isAiSample && <div className="font-ui text-xs text-t3">{t("regexAssistant.aiSampleLabel")}</div>}
								{live.kind === "ok" && live.unchanged && (
									<div className="font-ui text-xs text-t3">{t("promptManager.regex.testUnchanged")}</div>
								)}
							</>
						)}
					</div>
				)}
			</div>
		</AiAssistantShell>
	);

	if (isMobile) {
		return (
			<BottomSheet open={isOpen} onClose={onClose} title={t("regexAssistant.title")}>
				<div className="flex max-h-[85vh] w-full flex-col overflow-hidden">{body}</div>
			</BottomSheet>
		);
	}
	return (
		<Modal open={isOpen} onClose={onClose} title={t("regexAssistant.title")}>
			<div className="flex max-h-[85vh] w-[600px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-border bg-surface">
				{body}
			</div>
		</Modal>
	);
}
