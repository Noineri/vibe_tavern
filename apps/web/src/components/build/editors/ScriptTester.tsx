import { useEffect, useState } from "react";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { testScript } from "../../../app-client.js";

/**
 * Script test panel — extracted from `useScriptPanel`
 * (SCRIPT_EDITOR_GOD_OBJECT_AUDIT). Owns all 8 test-input state pieces + the
 * run handler + the result renderer.
 *
 * Why a component, not a hook: the simulator has a clear render surface and a
 * single-value prop interface; its state is disjoint from the host hook's
 * CRUD/DnD state, so isolating it also drops 8 `useState` re-renders from the
 * host hook's render cycle (typing in the test input used to re-run
 * `useScriptPanel` and re-create every JSX chunk it returns).
 *
 * Props are intentionally narrow: the active script id, viewport mode, and an
 * optional resolved character name. The host resolves `characterName` from the
 * snapshot (it already subscribes to `allCharacters` for link binding), so this
 * component carries no store plumbing — that keeps the P2 "pre-fill the
 * character-name field" behavior without leaking scope/store concerns in.
 */

type TestResult = {
	personality: string;
	scenario: string;
	state: Record<string, unknown>;
	injectedMessages: Array<{ content: string; role: "system" | "user" | "assistant" }>;
	console: Array<{ level: "log" | "warn" | "error"; args: string }>;
	shared: Record<string, unknown>;
	errors: Array<{ scriptId: string; scriptName: string; error: string; line?: number } | string>;
};

interface ScriptTesterProps {
	scriptId: string | null;
	isMobile: boolean;
	characterName?: string;
}

export function ScriptTester({ scriptId, isMobile, characterName }: ScriptTesterProps) {
	const { t } = useT();
	const [testInput, setTestInput] = useState("");
	const [testAdvanced, setTestAdvanced] = useState(false);
	const [testCharName, setTestCharName] = useState("");
	const [testCharPersonality, setTestCharPersonality] = useState("");
	const [testCharScenario, setTestCharScenario] = useState("");
	const [testPersonaName, setTestPersonaName] = useState("");
	const [testPersonaDesc, setTestPersonaDesc] = useState("");
	const [testResult, setTestResult] = useState<TestResult | null>(null);
	const [testingScript, setTestingScript] = useState(false);

	// Pre-fill the character-name field from the snapshot when the editor is
	// scoped to a character (P2). `prev || name` keeps any value the user
	// already typed.
	useEffect(() => {
		if (characterName) setTestCharName((prev) => prev || characterName);
	}, [characterName]);

	const handleTestScript = async () => {
		if (!scriptId || !testInput.trim()) return;
		// Multi-line input: each non-empty line becomes a user message so
		// messageCount reflects the conversation length (P2).
		const messages = testInput
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
			.map((content) => ({ role: "user", content }));
		if (messages.length === 0) return;
		const payload: Parameters<typeof testScript>[1] = { messages };
		if (testCharName.trim()) payload.characterName = testCharName.trim();
		if (testCharPersonality.trim()) payload.characterPersonality = testCharPersonality;
		if (testCharScenario.trim()) payload.characterScenario = testCharScenario;
		if (testPersonaName.trim()) {
			payload.personaName = testPersonaName.trim();
			payload.personaDescription = testPersonaDesc;
		}
		setTestingScript(true);
		try {
			const r = await testScript(scriptId, payload);
			setTestResult(r);
		} finally {
			setTestingScript(false);
		}
	};

	const runTest = () => {
		void handleTestScript();
	};

	return (
		<div className="rounded-lg border border-border bg-s2" style={{ padding: 16 }}>
			<div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">
				{t("script_test_panel")}
			</div>
			<div className={cn("flex gap-2.5", isMobile && "flex-col")}>
				<textarea
					className={cn("flex-1 rounded-md border border-border bg-bg px-3 py-2 font-ui text-t1 outline-none resize-y", isMobile && "min-h-[44px]")}
					value={testInput}
					onChange={(e) => setTestInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							runTest();
						}
					}}
					placeholder={t("script_test_input_placeholder")}
					rows={2}
				/>
				<button
					type="button"
					className={cn("h-9 shrink-0 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all", isMobile && "min-h-[44px]")}
					onClick={runTest}
				>
					{t("script_test_run")}
				</button>
			</div>
			<p className="mt-1.5 font-ui text-[11px] leading-relaxed text-t3">{t("script_test_input_hint")}</p>

			{/* Advanced test inputs (P2/P3): character fields + persona */}
			<div className="mt-2">
				<button
					type="button"
					className="flex cursor-pointer items-center gap-1 font-ui text-[11px] text-t3 transition-all hover:text-t1"
					onClick={() => setTestAdvanced((v) => !v)}
				>
					<span className="inline-block transition-transform" style={{ transform: testAdvanced ? "rotate(90deg)" : "none" }}>
						▶
					</span>
					{t("script_test_advanced")}
				</button>
				{testAdvanced && (
					<div className="mt-2 space-y-2 rounded-md border border-border bg-bg" style={{ padding: 10 }}>
						<div>
							<label className="mb-1 block font-ui text-[11px] text-t3">{t("script_test_character_name")}</label>
							<input className="h-8 w-full rounded-md border border-border bg-s2 px-2 font-ui text-[12px] text-t1 outline-none focus:border-accent" value={testCharName} onChange={(e) => setTestCharName(e.target.value)} />
						</div>
						<div>
							<label className="mb-1 block font-ui text-[11px] text-t3">{t("script_test_character_personality")}</label>
							<textarea className="w-full min-h-[60px] resize-y rounded-md border border-border bg-s2 px-2 py-1 font-mono text-[11px] text-t1 outline-none focus:border-accent" value={testCharPersonality} onChange={(e) => setTestCharPersonality(e.target.value)} />
						</div>
						<div>
							<label className="mb-1 block font-ui text-[11px] text-t3">{t("script_test_character_scenario")}</label>
							<textarea className="w-full min-h-[60px] resize-y rounded-md border border-border bg-s2 px-2 py-1 font-mono text-[11px] text-t1 outline-none focus:border-accent" value={testCharScenario} onChange={(e) => setTestCharScenario(e.target.value)} />
						</div>
						<div className="border-t border-border pt-2">
							<div className="mb-1 font-ui text-[11px] font-medium text-t2">{t("script_test_persona_fields")}</div>
							<div className="space-y-2">
								<div>
									<label className="mb-1 block font-ui text-[11px] text-t3">{t("script_test_persona_name")}</label>
									<input className="h-8 w-full rounded-md border border-border bg-s2 px-2 font-ui text-[12px] text-t1 outline-none focus:border-accent" value={testPersonaName} onChange={(e) => setTestPersonaName(e.target.value)} />
								</div>
								<div>
									<label className="mb-1 block font-ui text-[11px] text-t3">{t("script_test_persona_desc")}</label>
									<textarea className="w-full min-h-[60px] resize-y rounded-md border border-border bg-s2 px-2 py-1 font-mono text-[11px] text-t1 outline-none focus:border-accent" value={testPersonaDesc} onChange={(e) => setTestPersonaDesc(e.target.value)} />
								</div>
							</div>
						</div>
					</div>
				)}
			</div>

			{testResult && (() => {
				const hasAnyOutput =
					testResult.errors.length > 0 ||
					!!testResult.personality ||
					!!testResult.scenario ||
					testResult.injectedMessages.length > 0 ||
					testResult.console.length > 0 ||
					Object.keys(testResult.state).length > 0 ||
					Object.keys(testResult.shared).length > 0;
				return (
					<div className="mt-3 space-y-2">
						{testResult.errors.length > 0 && (
							<div className="rounded-md border border-danger bg-danger-dim" style={{ padding: 10 }}>
								<div className="text-[11px] font-semibold uppercase text-danger-text">{t("script_test_error")}</div>
								<pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-danger-text">
									{testResult.errors.map((e) => (typeof e === "string" ? e : `${e.scriptName ?? "Script"}: ${e.error}${e.line ? ` (line ${e.line})` : ""}`)).join("\n")}
								</pre>
							</div>
						)}
						{!hasAnyOutput && (
							<div className="rounded-md border border-warning bg-warning-dim" style={{ padding: 10 }}>
								<div className="text-[11px] font-semibold uppercase text-warning-text">{t("script_test_no_effect")}</div>
								<div className="mt-1 font-ui text-[11px] leading-relaxed text-t2">{t("script_test_no_effect_hint")}</div>
							</div>
						)}
						{hasAnyOutput && (
							<>
								<div className="rounded-md border border-border bg-bg" style={{ padding: 10 }}>
									<div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{t("script_test_personality")}</div>
									{testResult.personality ? (
										<AutoTextarea className="mt-1 w-full resize-none rounded-md border-0 bg-s2 px-2 py-1 font-mono text-[12px] leading-[1.5] text-t2 outline-none" style={{}} value={testResult.personality} onChange={() => {}} readOnly maxRows={16} />
									) : (
										<p className="mt-1 font-mono text-[12px] italic text-t3">({t("script_test_no_change")})</p>
									)}
								</div>
								<div className="rounded-md border border-border bg-bg" style={{ padding: 10 }}>
									<div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{t("script_test_scenario")}</div>
									{testResult.scenario ? (
										<AutoTextarea className="mt-1 w-full resize-none rounded-md border-0 bg-s2 px-2 py-1 font-mono text-[12px] leading-[1.5] text-t2 outline-none" style={{}} value={testResult.scenario} onChange={() => {}} readOnly maxRows={16} />
									) : (
										<p className="mt-1 font-mono text-[12px] italic text-t3">({t("script_test_no_change")})</p>
									)}
								</div>
							</>
						)}
						{testResult.injectedMessages.length > 0 && (
							<div className="rounded-md border border-border bg-bg" style={{ padding: 10 }}>
								<div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{t("script_test_injected")}</div>
								<div className="mt-1 space-y-1.5">
									{testResult.injectedMessages.map((msg, i) => (
										<div key={i} className="flex items-start gap-2">
											<span className="shrink-0 rounded bg-s3 px-1.5 py-0.5 font-mono text-[10px] uppercase text-t3">{msg.role}</span>
											<pre className="flex-1 whitespace-pre-wrap font-mono text-[12px] text-t2">{msg.content}</pre>
										</div>
									))}
								</div>
							</div>
						)}
						{testResult.console.length > 0 && (
							<div className="rounded-md border border-border bg-bg" style={{ padding: 10 }}>
								<div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{t("script_test_console")}</div>
								<div className="mt-1 space-y-0.5">
									{testResult.console.map((entry, i) => (
										<div key={i} className="flex items-start gap-2">
											<span className={cn("shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase", entry.level === "error" ? "bg-danger-dim text-danger-text" : entry.level === "warn" ? "bg-s3 text-t2" : "bg-s3 text-t3")}>{entry.level}</span>
											<pre className="flex-1 whitespace-pre-wrap font-mono text-[12px] text-t2">{entry.args}</pre>
										</div>
									))}
								</div>
							</div>
						)}
						{Object.keys(testResult.state).length > 0 && (
							<div className="rounded-md border border-border bg-bg" style={{ padding: 10 }}>
								<div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{t("script_test_state")}</div>
								<pre className="mt-1 whitespace-pre-wrap font-mono text-[12px] text-t2">{JSON.stringify(testResult.state, null, 2)}</pre>
							</div>
						)}
						{Object.keys(testResult.shared).length > 0 && (
							<div className="rounded-md border border-border bg-bg" style={{ padding: 10 }}>
								<div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{t("script_test_shared")}</div>
								<pre className="mt-1 whitespace-pre-wrap font-mono text-[12px] text-t2">{JSON.stringify(testResult.shared, null, 2)}</pre>
							</div>
						)}
					</div>
				);
			})()}
			{testingScript && <div className="mt-3 text-center font-ui text-[12px] text-t3">{t("script_running")}</div>}
		</div>
	);
}
