import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { useT } from "../../../../i18n/context.js";
import { useIsMobile } from "../../../../hooks/use-mobile.js";
import { Icons } from "../../../shared/icons.js";
import { cn } from "../../../../lib/cn.js";
import { getModalPortal } from "../../../shared/modal-helpers.js";

/**
 * TTS model picker — VERBATIM VISUAL FORK of ProviderModelSelector (owner
 * directive: the LLM picker design is the reference, no hand-rolled
 * patterns). Dropped LLM specifics: free-only / group-by-owner toggles,
 * favorites, context-budget sync, local-connection banner. Added: TTS
 * affordances — `isFree` / `description` row badges (aggregators like
 * OpenRouter ship both) and the same manual-input fallback the LLM
 * selector manual-input fallback was REMOVED (owner directive
 * 2026-08-29): the dropdown trigger always renders — while the first
 * fetch is in flight it reports loading, a hand-typed id stays reachable
 * through the popover's custom-slug row. Rendered BARE (no section card)
 * and must sit ABOVE the voice section (voices are model-dependent).
 */

const labelCls = "block text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.06em] uppercase text-t3";
/** Row option for the TTS model list. `id` is the wire model id; `label`
 *  the display name; `isFree` / `description` are optional enrichment the
 *  draft-models endpoint parses out of the provider's /models payload. */
export interface TtsModelOption {
  id: string;
  label: string;
  isFree?: boolean;
  description?: string;
  contextLength?: number;
}

interface TtsModelPickerProps {
  value: string;
  onChange: (modelId: string) => void;
  models: TtsModelOption[];
  fetching: boolean;
  fetchError: string | null;
  onRefresh: () => void;
  label: string;
}

export function TtsModelPicker({
  value,
  onChange,
  models,
  fetching,
  fetchError,
  onRefresh,
  label,
}: TtsModelPickerProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selectedModel = models.find((model) => model.id === value);
  // The selected id always stays visible even when it is not in the
  // fetched list (a hand-typed or since-removed model) — same rule as
  // the LLM selector.
  const listModels =
    selectedModel || !value ? models : [{ id: value, label: value }, ...models];
  const portalContainer = getModalPortal() ?? undefined;

  const selectModel = (model: TtsModelOption) => {
    onChange(model.id);
    setOpen(false);
    setSearch("");
  };
  const useCustomSlug = (slug: string) => {
    onChange(slug);
    setOpen(false);
    setSearch("");
  };

  const query = search.trim().toLowerCase();
  const formatContext = (contextLength?: number) => {
    if (contextLength == null || !Number.isFinite(contextLength)) return null;
    return contextLength >= 1000
      ? `${(contextLength / 1000).toFixed(contextLength % 1000 === 0 ? 0 : 1)}k ctx`
      : `${contextLength} ctx`;
  };
  const visible = listModels
    .filter((model) => !query || model.id.toLowerCase().includes(query) || model.label.toLowerCase().includes(query))
    .sort((a, b) => a.label.localeCompare(b.label));
  const customSlug = search.trim();
  const hasExactMatch = listModels.some((model) => model.id === customSlug);

  return (
    <div className="my-4">
      <div className="mb-3 border-b border-border2 pb-2 font-ui text-[14px] font-semibold text-t1">{label}</div>
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className={`${labelCls} mb-[6px]`}>{t("selected_model_label")}</label>
          <div className="relative">
              <Popover.Root open={open} onOpenChange={setOpen}>
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    data-testid="tts-field-model"
                    className="flex w-full items-center justify-between rounded-md border border-border bg-s2 px-3 py-[6px] font-ui text-[13px] text-t1 transition-colors hover:border-accent"
                  >
                    <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left">
                      {/* No placeholder stub (owner directive 2026-08-29): the
                       * trigger reports loading while the first fetch is in
                       * flight — a bare input with a fake example id must
                       * never stand in for the real fetched list. */}
                      {fetching && models.length === 0 ? t("tts_models_loading") : selectedModel?.label || value || t("select_model")}
                    </span>
                    <span className="text-t3">
                      <Icons.Caret direction="d" />
                    </span>
                  </button>
                </Popover.Trigger>
                <Popover.Portal container={portalContainer}>
                  <Popover.Content
                    sideOffset={4}
                    align="start"
                    onCloseAutoFocus={(event) => event.preventDefault()}
                    className="glass-blur z-[600] overflow-hidden rounded-md border border-border bg-surface shadow-[0_8px_30px_rgba(0,0,0,0.6)]"
                    style={{ width: "var(--radix-popover-trigger-width)", maxHeight: 260 }}
                  >
                    <Command shouldFilter={false} loop className="flex flex-col outline-none">
                      <div className="border-b border-border2 bg-s2 p-2">
                        <Command.Input
                          placeholder={t("search_models")}
                          value={search}
                          onValueChange={setSearch}
                          className="w-full rounded border border-border bg-surface px-2 py-[5px] font-ui text-[12px] text-t1 outline-none focus:border-accent"
                        />
                      </div>
                      <Command.List className="max-h-[200px] overflow-y-auto bg-surface p-1">
                        {visible.map((model) => (
                          <Command.Item
                            key={model.id}
                            value={model.id}
                            onSelect={() => selectModel(model)}
                            className={cn(
                              "flex cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 font-ui text-[12px] outline-none transition-colors",
                              model.id === value
                                ? "bg-accent-dim font-medium text-accent-t"
                                : "text-t2 hover:bg-s2 hover:text-t1 data-[selected=true]:bg-s2 data-[selected=true]:text-t1",
                            )}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-t1">{model.label || model.id}</span>
                                {model.isFree && (
                                  <span className="shrink-0 rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">free</span>
                                )}
                                {formatContext(model.contextLength) && (
                                  <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 text-[10px] font-medium text-t2">{formatContext(model.contextLength)}</span>
                                )}
                              </div>
                              {model.label && model.label !== model.id && (
                                <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[10px] text-t4">
                                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{model.id}</span>
                                </div>
                              )}
                              {model.description && (
                                <div className="mt-0.5 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-t4">{model.description}</div>
                              )}
                            </div>
                          </Command.Item>
                        ))}
                        {customSlug && !hasExactMatch && (
                          <Command.Item
                            data-testid="use-custom-model"
                            value={`use-${customSlug}`}
                            onSelect={() => useCustomSlug(customSlug)}
                            className="cursor-pointer rounded px-2.5 py-1.5 font-ui text-[12px] text-accent-t data-[selected=true]:bg-s2"
                          >
                            {t("use_custom_model_id", { id: customSlug })}
                          </Command.Item>
                        )}
                        {visible.length === 0 && !customSlug && (
                          <div className="px-2.5 py-1.5 text-center font-ui text-[11px] text-t4">{t("no_models_found")}</div>
                        )}
                      </Command.List>
                    </Command>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
              {!selectedModel && value && (
                <div className="mt-2 font-ui text-[12px] font-medium text-accent">{t("custom_model", { name: value })}</div>
              )}
          </div>
        </div>
        <button
          type="button"
          data-testid="tts-models-refresh"
          onClick={() => onRefresh()}
          disabled={fetching}
          className={cn(
            "shrink-0 items-center gap-2 rounded-md border border-border bg-s2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50",
            isMobile ? "flex w-[34px] justify-center px-0 py-[6px]" : "flex px-4 py-[6px] font-ui text-[13px] font-medium text-t2",
          )}
          title={t("refresh_models")}
        >
          {fetching ? (
            <span className="ml-[3px] inline-flex items-center gap-[3px] align-middle">
              <span className="h-1 w-1 animate-genp rounded-full bg-accent" />
              <span className="h-1 w-1 animate-genp rounded-full bg-accent [animation-delay:0.18s]" />
              <span className="h-1 w-1 animate-genp rounded-full bg-accent [animation-delay:0.36s]" />
            </span>
          ) : (
            <Icons.Regen />
          )}
          {!isMobile && <> {t("refresh_models")}</>}
        </button>
      </div>
      {fetchError && (
        <div className="mt-3">
          <span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger">
            <Icons.Close />
            {fetchError}
          </span>
        </div>
      )}
    </div>
  );
}
