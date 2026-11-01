import { useCallback, useState } from "react";

/**
 * AP-18 (AGENT_SHELL_POLISH, UX 2026-08-16 remark 6): the shell's composer
 * prefill bridge — a host surface or a starter/hand-off pick hands TEXT to
 * the chat input through `inputPrefill`; OBJECT IDENTITY is the trigger
 * (the composers' effect keys on the value), so `pick` mints a FRESH object
 * per call — two picks of the same text both land. Extracted verbatim from
 * `AgentShell.tsx` under the file-size ratchet; nothing here sends.
 */
export function useAgentInputPrefill(): {
	inputPrefill: { text: string } | null;
	/** The raw setter — the shell↔host bridge hands it to host surfaces. */
	setInputPrefill: (value: { text: string } | null) => void;
	/** Composer prefill (never sent) — a fresh object per call. */
	handleStarterPick: (text: string) => void;
} {
	const [inputPrefill, setInputPrefill] = useState<{ text: string } | null>(null);
	const handleStarterPick = useCallback((text: string): void => {
		setInputPrefill({ text });
	}, []);
	return { inputPrefill, setInputPrefill, handleStarterPick };
}
