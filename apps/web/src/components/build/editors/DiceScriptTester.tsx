import { useEffect, useState } from "react";
import { testScript } from "../../../app-client.js";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { inputCls, inputPad, lblCls } from "../fields/field-styles.js";
import type { DiceScriptTestResult, DiceSampleRoll } from "@vibe-tavern/api-contracts";

interface DiceScriptTesterProps {
	scriptId: string | null;
	code: string;
	isMobile: boolean;
	characterName?: string;
}

type DiscoveredCheck = DiceScriptTestResult["checks"][number];

export function DiceScriptTester({ scriptId, code, isMobile, characterName }: DiceScriptTesterProps) {
	const { t, tDynamic } = useT();
	const [testCharName, setTestCharName] = useState("");
	const [testPersonaName, setTestPersonaName] = useState("");
	const [result, setResult] = useState<DiceScriptTestResult | null>(null);
	const [testing, setTesting] = useState(false);

	useEffect(() => {
		if (characterName) setTestCharName((prev) => prev || characterName);
	}, [characterName]);

	const runTest = async () => {
		if (!scriptId) return;
		const body: Parameters<typeof testScript>[1] = {
			messages: [{ role: "user", content: "test" }],
			code,
		};
		if (testCharName.trim()) body.characterName = testCharName.trim();
		if (testPersonaName.trim()) body.personaName = testPersonaName.trim();
		setTesting(true);
		try {
			const r = await testScript(scriptId, body);
			// testScript returns a kind-discriminated union; this panel is only
			// mounted for dice scripts, so a prompt result would be a backend bug.
			// Keep the previous dice result visible in that case rather than blanking.
			if (r?.kind === "dice") setResult(r);
		} finally {
			setTesting(false);
		}
	};

	return (
		<div className="rounded-lg border border-border bg-s2" style={{ padding: 16 }}>
			<div className="mb-3 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">
				<span>{t("script_test_panel")}</span>
				<span className="rounded bg-accent px-1.5 py-0.5 font-ui text-[10px] text-on-accent">DICE</span>
			</div>

			<div className={cn("flex items-end gap-2.5", isMobile && "flex-col items-stretch")}>
				<div className="flex-1 space-y-2">
					<div>
						<label className={cn(lblCls, "mb-1")}>{t("script_test_character_name")}</label>
						<input className={inputCls} style={inputPad} value={testCharName} onChange={(e) => setTestCharName(e.target.value)} />
					</div>
					<div>
						<label className={cn(lblCls, "mb-1")}>{t("script_test_persona_name")}</label>
						<input className={inputCls} style={inputPad} value={testPersonaName} onChange={(e) => setTestPersonaName(e.target.value)} />
					</div>
				</div>
				<button
					type="button"
					className={cn("h-9 shrink-0 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all", isMobile && "min-h-[44px]")}
					onClick={() => { void runTest(); }}
				>
					{t("script_test_run")}
				</button>
			</div>

			{result?.discoveryError && (
				<div className="mt-3 rounded-md border border-danger bg-danger-dim" style={{ padding: 10 }}>
					<div className="text-[11px] font-semibold uppercase text-danger-text">
						{tDynamic("script_test_dice_discovery_error") || "Discovery error"}
					</div>
					<pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-danger-text">{result.discoveryError}</pre>
				</div>
			)}

			{result && !result.discoveryError && (
				<div className="mt-3 space-y-2">
					{result.checks.length > 0 && (
						<div>
							<div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">
								{tDynamic("script_test_dice_checks") || "Discovered checks"}
							</div>
							<div className="space-y-1.5">
								{result.checks.map((c) => <CheckRow key={c.id} c={c} />)}
							</div>
						</div>
					)}
					{result.sampleRolls.length > 0 && (
						<div>
							<div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">
								{tDynamic("script_test_dice_sim") || "Sample rolls"}
							</div>
							<div className="space-y-1.5">
								{result.sampleRolls.map((s, i) => <SampleRollRow key={i} s={s} />)}
							</div>
						</div>
					)}
					{result.checks.length === 0 && result.sampleRolls.length === 0 && (
						<div className="rounded-md border border-warning bg-warning-dim" style={{ padding: 10 }}>
							<div className="text-[11px] font-semibold uppercase text-warning-text">
								{tDynamic("script_test_dice_no_checks") || "No dice checks discovered"}
							</div>
						</div>
					)}
				</div>
			)}

			{testing && <div className="mt-3 text-center font-ui text-[12px] text-t3">{t("script_running")}</div>}
		</div>
	);
}

function CheckRow({ c }: { c: DiscoveredCheck }) {
	return (
		<div className="rounded border border-border2 bg-bg p-2">
			<div className="mb-1 flex items-center gap-2">
				<span className="text-[13px] font-semibold text-t1">{c.label}</span>
				<code className="rounded bg-bg px-1 font-mono text-[10px] text-t3">{c.id}</code>
				<span className="rounded bg-border px-1.5 py-0.5 font-ui text-[10px] uppercase text-t2">{c.resolution}</span>
			</div>
			<div className="flex flex-wrap gap-1">
				<code className="rounded bg-s3 px-1.5 py-0.5 font-mono text-[10px] text-t2">{c.notation}</code>
				{c.actors.map((a) => (
					<span key={a} className="rounded-full bg-s3 px-2 py-0.5 text-[10px] text-t2">{a}</span>
				))}
			</div>
		</div>
	);
}

function SampleRollRow({ s }: { s: DiceSampleRoll }) {
	return (
		<div className="rounded border border-border2 bg-bg p-2 font-mono text-[11px] text-t2">
			<div className="mb-1">
				<span className="text-accent-t">{s.checkLabel}</span> · <span className="text-t3">{s.notation}</span> ({s.faceShape}/{s.resolution})
			</div>
			{s.result.ok ? (
				<>
					<div>
						faces: [{s.result.faces.join(", ")}]  mod: {s.result.modifier}  subtotal: {s.result.subtotal}  total: {s.result.total}
					</div>
					{s.result.final && (
						<div className="mt-0.5">
							<span className="text-accent-t">{s.result.final.outcome ?? "resolved"}</span>
							{s.result.final.degree && <span className="text-t3"> ({s.result.final.degree})</span>}
							{s.result.final.constraint && (
								<div className="whitespace-pre-wrap break-words text-t3">{s.result.final.constraint}</div>
							)}
						</div>
					)}
					{s.result.retryReason && (
						<div className="text-warning-text">
							retry: {s.result.retryReason}{s.result.policy ? ` (${s.result.policy})` : ""}
						</div>
					)}
				</>
			) : (
				<div className="text-danger-text">error: {s.result.error}</div>
			)}
		</div>
	);
}
