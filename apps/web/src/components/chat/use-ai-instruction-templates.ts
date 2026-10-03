/**
 * The AI-editor instruction-template data source
 * (AI_EDITOR_INSTRUCTION_TEMPLATES step 2).
 *
 * ONE derivation of the template list for the web app: this hook lazily
 * loads the library on first open and exposes create / rename / delete that
 * keep the local list in sync — the editor (and any later AI input) only
 * renders it, never deriving its own copy. Backend calls go through the
 * typed client (api/ai-instruction-template-api.ts); a rejected call
 * surfaces the server's message via toast and leaves the local list intact.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { AiInstructionTemplate } from "@vibe-tavern/api-contracts";
import { RpcError } from "../../api/unwrap.js";
import {
	createAiInstructionTemplate,
	deleteAiInstructionTemplate,
	listAiInstructionTemplates,
	updateAiInstructionTemplate,
} from "../../api/ai-instruction-template-api.js";

export interface AiInstructionTemplatesSource {
	templates: AiInstructionTemplate[];
	loading: boolean;
	/** Insert-side helpers run against this list; create/rename/delete keep
	 *  it in sync so the popover re-renders immediately.
	 *
	 *  `baseName` is the BASE name (save-current passes the first line): when
	 *  it is already taken the create auto-numbers — «name (2)», «name (3)», …
	 *  the first free slot — so «save current» never fails on a clash; a 409
	 *  race (name taken after our snapshot) retries once with the next free
	 *  number. Rename keeps the plain 409 → toast (a deliberately typed name
	 *  should surface its collision). */
	createTemplate: (baseName: string, text: string) => Promise<boolean>;
	renameTemplate: (id: string, name: string) => Promise<boolean>;
	deleteTemplate: (id: string) => Promise<boolean>;
}

/** First free name for a create: `base`, then «base (2)», «base (3)», … —
 *  case-insensitive, the adapter's collision rule (lowercase probe). */
function freeName(base: string, taken: ReadonlySet<string>): string {
	if (!taken.has(base.toLowerCase())) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base} (${n})`;
		if (!taken.has(candidate.toLowerCase())) return candidate;
	}
}

export function useAiInstructionTemplates(open: boolean): AiInstructionTemplatesSource {
	const [templates, setTemplates] = useState<AiInstructionTemplate[]>([]);
	const [loading, setLoading] = useState(false);
	/** Lazily load ONCE per mount while open — reopening reuses the list and
	 *  mutations keep it fresh, so there is no refetch churn per popover open. */
	const loadedRef = useRef(false);
	/** Latest list for async callbacks (the createTemplate closure predates
	 *  later list updates — the store-reads-in-callbacks rule). */
	const templatesRef = useRef<AiInstructionTemplate[]>([]);
	templatesRef.current = templates;

	const takenNames = () => new Set(templatesRef.current.map((tpl) => tpl.name.toLowerCase()));

	useEffect(() => {
		if (!open || loadedRef.current) return;
		loadedRef.current = true;
		setLoading(true);
		listAiInstructionTemplates()
			.then((list) => setTemplates(list))
			.catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoading(false));
	}, [open]);

	const createTemplate = useCallback(async (baseName: string, text: string): Promise<boolean> => {
		const name = freeName(baseName, takenNames());
		try {
			const created = await createAiInstructionTemplate({ name, text });
			setTemplates((prev) => [...prev, created]);
			return true;
		} catch (err: unknown) {
			// 409 = the name was taken AFTER our list snapshot (another surface
			// created it) — retry ONCE with the next free number; any other
			// failure stays the plain toast.
			if (err instanceof RpcError && err.status === 409) {
				const raced = takenNames();
				raced.add(name.toLowerCase());
				try {
					const created = await createAiInstructionTemplate({ name: freeName(baseName, raced), text });
					setTemplates((prev) => [...prev, created]);
					return true;
				} catch (retryErr: unknown) {
					toast.error(retryErr instanceof Error ? retryErr.message : String(retryErr));
					return false;
				}
			}
			toast.error(err instanceof Error ? err.message : String(err));
			return false;
		}
	}, []);

	const renameTemplate = useCallback(async (id: string, name: string): Promise<boolean> => {
		try {
			const updated = await updateAiInstructionTemplate(id, { name });
			setTemplates((prev) => prev.map((tpl) => (tpl.id === id ? updated : tpl)));
			return true;
		} catch (err: unknown) {
			toast.error(err instanceof Error ? err.message : String(err));
			return false;
		}
	}, []);

	const deleteTemplate = useCallback(async (id: string): Promise<boolean> => {
		try {
			await deleteAiInstructionTemplate(id);
			setTemplates((prev) => prev.filter((tpl) => tpl.id !== id));
			return true;
		} catch (err: unknown) {
			toast.error(err instanceof Error ? err.message : String(err));
			return false;
		}
	}, []);

	return { templates, loading, createTemplate, renameTemplate, deleteTemplate };
}
