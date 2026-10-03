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
	 *  it in sync so the popover re-renders immediately. */
	createTemplate: (name: string, text: string) => Promise<boolean>;
	renameTemplate: (id: string, name: string) => Promise<boolean>;
	deleteTemplate: (id: string) => Promise<boolean>;
}

export function useAiInstructionTemplates(open: boolean): AiInstructionTemplatesSource {
	const [templates, setTemplates] = useState<AiInstructionTemplate[]>([]);
	const [loading, setLoading] = useState(false);
	/** Lazily load ONCE per mount while open — reopening reuses the list and
	 *  mutations keep it fresh, so there is no refetch churn per popover open. */
	const loadedRef = useRef(false);

	useEffect(() => {
		if (!open || loadedRef.current) return;
		loadedRef.current = true;
		setLoading(true);
		listAiInstructionTemplates()
			.then((list) => setTemplates(list))
			.catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoading(false));
	}, [open]);

	const createTemplate = useCallback(async (name: string, text: string): Promise<boolean> => {
		try {
			const created = await createAiInstructionTemplate({ name, text });
			setTemplates((prev) => [...prev, created]);
			return true;
		} catch (err: unknown) {
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
