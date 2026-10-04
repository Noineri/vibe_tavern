import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";

import { useT } from "../../i18n/context.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useProviderModels } from "../../hooks/use-provider-models.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import { useBootstrapStore, patchUiSettingsAction } from "../../stores/api-actions/bootstrap-actions.js";
import { cn } from "../../lib/cn.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { Toggle } from "../shared/Toggle.js";
import { AiAssistantConnectionFields } from "../shared/ai-assistant/AiAssistantConnectionFields.js";

/** Global lore-generation model binding, opened from the co-author document context block. */
export function CoauthorLoreAssistantSettings() {
  const { t } = useT();
  const isMobile = useIsMobile();
  const profiles = useProviderDataStore((state) => state.profiles);
  const uiSettings = useBootstrapStore((state) => state.data?.uiSettings);
  const storedProviderId = uiSettings?.coauthorLoreProviderId ?? null;
  const storedModelName = uiSettings?.coauthorLoreModelName ?? null;
  const [open, setOpen] = useState(false);
  const [useCoauthorModel, setUseCoauthorModel] = useState(storedProviderId === null && storedModelName === null);
  const [providerId, setProviderId] = useState(storedProviderId ?? "");
  const [modelName, setModelName] = useState(storedModelName ?? "");
  const [saveError, setSaveError] = useState<string | null>(null);
  const { models } = useProviderModels(providerId || null);
  const selectedProfile = profiles.find((profile) => profile.id === providerId) ?? null;
  const currentValue = storedModelName ?? t("coauthor.lore_assistant.same_as_coauthor");

  useEffect(() => {
    if (!open) return;
    setUseCoauthorModel(storedProviderId === null && storedModelName === null);
    setProviderId(storedProviderId ?? "");
    setModelName(storedModelName ?? "");
    setSaveError(null);
  }, [open, storedModelName, storedProviderId]);

  async function save(patch: { coauthorLoreProviderId: string | null; coauthorLoreModelName: string | null }) {
    setSaveError(null);
    try {
      await patchUiSettingsAction(patch);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t("coauthor.lore_assistant.save_error"));
    }
  }

  const body = (
    <div className="flex min-h-0 flex-col p-4">
      <div className="mb-3">
        {!isMobile && <div className="font-ui text-[calc(var(--ui-fs)+1px)] font-medium text-t1">{t("coauthor.lore_assistant.title")}</div>}
        <p className={cn("font-ui text-[calc(var(--ui-fs)-2px)] leading-snug text-t4", !isMobile && "mt-1")}>{t("coauthor.lore_assistant.shared_hint")}</p>
      </div>
      <label className="mb-3 flex items-center gap-2 font-ui text-[calc(var(--ui-fs)-1px)] text-t2">
        <Toggle
          checked={useCoauthorModel}
          onChange={(checked) => {
            setUseCoauthorModel(checked);
            if (checked) void save({ coauthorLoreProviderId: null, coauthorLoreModelName: null });
          }}
        />
        {t("coauthor.lore_assistant.same_as_coauthor")}
      </label>
      <AiAssistantConnectionFields
        providerProfiles={profiles}
        providerId={providerId}
        modelName={modelName}
        providerModels={models}
        selectedProfileDefaultModel={selectedProfile?.defaultModel ?? null}
        onProviderChange={(id) => {
          setProviderId(id);
          setModelName("");
          setSaveError(null);
        }}
        onModelChange={(id) => {
          setModelName(id);
          if (providerId) void save({ coauthorLoreProviderId: providerId, coauthorLoreModelName: id });
        }}
        disabled={useCoauthorModel}
        labels={{
          connection: t("coauthor.lore_assistant.provider"),
          model: t("coauthor.lore_assistant.model"),
          selectProvider: t("coauthor.lore_assistant.select_provider"),
          searchProvider: t("coauthor.lore_assistant.search_provider"),
          searchModel: t("coauthor.lore_assistant.search_model"),
        }}
      />
      {saveError && <p className="font-ui text-[calc(var(--ui-fs)-3px)] leading-snug text-danger">{saveError}</p>}
    </div>
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t("coauthor.lore_assistant.title")}
          aria-expanded={open}
          className="flex min-h-8 w-full items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 py-1.5 text-left font-ui text-[calc(var(--ui-fs)-3px)] text-t2 transition-all hover:bg-s2 hover:text-t1"
        >
          <span>{t("coauthor.lore_assistant.title")} ·</span>
          <span className="min-w-0 truncate" title={currentValue}>{currentValue}</span>
        </button>
      </Popover.Trigger>
      {!isMobile && (
        <Popover.Portal container={getModalPortal() ?? document.body}>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={8}
            className={cn("glass-blur z-[220] w-[min(460px,calc(100vw-2rem))] max-h-[min(70vh,var(--radix-popover-content-available-height))] overflow-y-auto rounded-lg border border-border2 bg-glass-bg shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95")}
          >
            {body}
          </Popover.Content>
        </Popover.Portal>
      )}
      {open && isMobile && (
        <BottomSheet open={true} onClose={() => setOpen(false)} title={t("coauthor.lore_assistant.title")}>
          <div className="max-h-[80dvh] overflow-y-auto">{body}</div>
        </BottomSheet>
      )}
    </Popover.Root>
  );
}
