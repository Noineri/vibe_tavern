/**
 * LoreKeysAiPill — the "generate keys via AI" quick-action pill for a lore
 * entry. Extracted from LoreEntryEditor.tsx (behavior-preserving decomposition
 * — see reports/lorebook-editor-form-state-gap.md Step 1). Owns its AI
 * provider/model settings + the streaming generation + append/replace logic.
 *
 * Reads the active entry's `content` / `keys` / `secondaryKeys` / `logic` and
 * writes `keys` / `secondaryKeys` DIRECTLY to the lifted RHF form via
 * `useFormContext` (the form→entries mirror in useLorebookEditorState keeps the
 * master list live + re-arms the debounced autosave).
 */
import { useEffect, useRef, useState } from "react";
import { useFormContext } from "react-hook-form";
import { toast } from "sonner";

import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import { AiQuickPill, type AiQuickSettings } from "../../shared/AiQuickPill.js";
import { useT } from "../../../i18n/context.js";
import {
  streamAiAssistant,
  updateUiSettings,
  type AiAssistantRequestBody,
  type LoreEntryRecord,
} from "../../../app-client.js";

export function LoreKeysAiPill() {
  const { t } = useT();
  const form = useFormContext<LoreEntryRecord>();
  // content gates the generate button (render-time read) — watch keeps it live.
  const content = form.watch("content");
  const [settings, setSettings] = useState<AiQuickSettings>({
    providerId: "",
    modelName: "",
    keyTarget: "both",
  });
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bootstrapUiSettings = useBootstrapStore((s) => s.data?.uiSettings ?? null);

  // Bootstrap persisted provider/model
  useEffect(() => {
    if (settings.providerId || !bootstrapUiSettings) return;
    setSettings((s) => ({
      ...s,
      providerId: bootstrapUiSettings.aiAssistantProviderId ?? "",
      modelName: bootstrapUiSettings.aiAssistantModelName ?? "",
    }));
  }, [settings.providerId, bootstrapUiSettings]);

  const handleGenerate = async () => {
    const providerId = settings.providerId || bootstrapUiSettings?.aiAssistantProviderId || "";
    const modelName = settings.modelName || bootstrapUiSettings?.aiAssistantModelName || "";
    // One-shot read of the current entry values at click time (fresher than a
    // prop snapshot would be — getValues reads the live form state).
    const v = form.getValues();
    if (!v.content.trim()) return;
    if (!providerId) {
      toast.error(t("select_provider_first"));
      return;
    }
    setLoading(true);
    abortRef.current = new AbortController();
    try {
      const request: AiAssistantRequestBody = {
        mode: "lore_keys",
        instruction: "",
        existingContent: v.content,
        providerProfileId: providerId,
        model: modelName || undefined,
        enabledLayers: [],
        existingKeys: v.keys,
        existingSecondaryKeys: v.secondaryKeys,
        logic: v.logic,
        keyTarget: settings.keyTarget ?? "both",
      };
      let raw = "";
      for await (const chunk of streamAiAssistant(request, { signal: abortRef.current.signal })) {
        if (chunk.type === "text" && chunk.text) raw += chunk.text;
        if (chunk.type === "error" && chunk.error) throw new Error(chunk.error);
        if (chunk.type === "done") break;
      }
      // Parse JSON response
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const parsed = JSON.parse(cleaned) as { keys?: string[]; secondaryKeys?: string[] };
      const target = settings.keyTarget ?? "both";
      // Safety net: never touch the key set the user did NOT request, even if
      // the model returned one. The backend prompt asks for the matching shape,
      // but models are not fully reliable — gate on the client too.
      const wantPrimary = target !== "secondary";
      const wantSecondary = target !== "primary";
      if (settings.appendMode) {
        const newKeys = wantPrimary ? (parsed.keys ?? []).filter((k) => !v.keys.includes(k)) : [];
        const newSec = wantSecondary ? (parsed.secondaryKeys ?? []).filter((k) => !v.secondaryKeys.includes(k)) : [];
        if (newKeys.length) form.setValue("keys", [...v.keys, ...newKeys], { shouldDirty: true });
        if (newSec.length) form.setValue("secondaryKeys", [...v.secondaryKeys, ...newSec], { shouldDirty: true });
      } else {
        if (wantPrimary && parsed.keys?.length) form.setValue("keys", parsed.keys, { shouldDirty: true });
        if (wantSecondary && parsed.secondaryKeys?.length) form.setValue("secondaryKeys", parsed.secondaryKeys, { shouldDirty: true });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast.error(err instanceof Error ? err.message : "Key generation failed");
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };

  const handleSettingsChange = (s: AiQuickSettings) => {
    setSettings(s);
    void updateUiSettings({
      aiAssistantProviderId: s.providerId || null,
      aiAssistantModelName: s.modelName || null,
    }).catch(() => {});
  };

  return (
    <AiQuickPill
      onGenerate={() => void handleGenerate()}
      onCancel={() => { abortRef.current?.abort(); }}
      onSettingsChange={handleSettingsChange}
      settings={settings}
      loading={loading}
      disabled={!content.trim()}
      showAppendToggle
      showKeyTarget
      starTooltip={t("ai_pill_generate_keys")}
      gearTooltip={t("ai_pill_generate_keys_settings")}
      size="md"
    />
  );
}
