/**
 * The fine-tuning chip's LoRA section (COMFYUI_BACKEND_PLAN CG-C3): a
 * family-filtered picker over the profile's live lora list — per-lora
 * enable + single-slider strength (FT-A5), activation words displayed
 * BESIDE the entry with CLICK-TO-COPY (owner 2026-09-18: NO auto-insert —
 * the prompt is never silently modified; the only writer of the prompt is
 * the user's own hand).
 *
 * Family filter: AUTO-PRESELECTS the effective model's family (resolved
 * from the models list the chip already fetched) while untouched; a manual
 * switch pins the choice, and the null-family «Неизвестно» bucket rides
 * the same dropdown. A search field narrows by name (79 loras on the
 * owner's install — the list scrolls in its own capped well).
 *
 * Gated upstream on `capabilities.supportsLoras` — this component never
 * fetches for an unsupported profile (the route 400s; the chip gates the
 * fetch the same way it gates samplers).
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Icons } from "../shared/icons.js";
import { DropdownSelect } from "../shared/DropdownSelect.js";
import { SearchInput } from "../shared/SearchInput.js";
import { SliderField } from "../shared/SliderField.js";
import { Toggle } from "../shared/Toggle.js";
import { IMAGE_GEN_PARAM_RANGES } from "@vibe-tavern/domain";
import { useT } from "../../i18n/context.js";
import { EMPTY_IMAGE_GEN_DRAFT, useImageGenChatStore } from "../../stores/image-gen-chat-store.js";
import type { ImageGenLora } from "../../api/image-gen-api.js";

/** The dropdown's sentinel ids (family names themselves are option ids). */
const FAMILY_ALL = "all";
const FAMILY_UNKNOWN = "__unknown__";

export interface ImageGenLoraSectionProps {
  chatId: string;
  /** The effective model's family — `undefined` while the models list is
   *  still loading (or the family is unresolved); drives the untouched
   *  filter's auto-preselect. */
  modelFamily: string | undefined;
  /** The live lora list (null = loading, `failed` = the fetch died). */
  loras: ImageGenLora[] | null;
  failed: boolean;
  disabled: boolean;
}

export function ImageGenLoraSection({ chatId, modelFamily, loras, failed, disabled }: ImageGenLoraSectionProps) {
  const { t } = useT();
  const draft = useImageGenChatStore((s) => s.fineTuningDraftByChat[chatId] ?? EMPTY_IMAGE_GEN_DRAFT);
  const setLoraEnabled = useImageGenChatStore((s) => s.setFineTuningLoraEnabled);
  const setLoraStrength = useImageGenChatStore((s) => s.setFineTuningLoraStrength);
  const [open, setOpen] = useState(false);
  const [familyFilter, setFamilyFilter] = useState<string>(FAMILY_ALL);
  const [filterTouched, setFilterTouched] = useState(false);
  const [search, setSearch] = useState("");

  const families = useMemo(() => {
    const set = new Set<string>();
    let hasUnknown = false;
    for (const lora of loras ?? []) {
      if (lora.family === null) hasUnknown = true;
      else set.add(lora.family);
    }
    return { named: [...set].sort((a, b) => a.localeCompare(b)), hasUnknown };
  }, [loras]);

  // Auto-preselect: the effective model's family, applied while the filter
  // is untouched (a manual pick pins the choice for the chat's lifetime).
  useEffect(() => {
    if (filterTouched || modelFamily === undefined) return;
    if (families.named.includes(modelFamily)) setFamilyFilter(modelFamily);
  }, [filterTouched, modelFamily, families.named]);

  const enabledCount = draft.loras?.length ?? 0;

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (loras ?? []).filter((lora) => {
      if (familyFilter === FAMILY_UNKNOWN && lora.family !== null) return false;
      if (
        familyFilter !== FAMILY_ALL &&
        familyFilter !== FAMILY_UNKNOWN &&
        lora.family !== familyFilter
      ) {
        return false;
      }
      return query === "" || lora.name.toLowerCase().includes(query);
    });
  }, [loras, familyFilter, search]);

  /** Copy the lora's activation words — the FULL joined string, regardless
   *  of how the row truncates it for display (owner 2026-09-18: copy, never
   *  auto-insert — nothing here writes `draft.prompt`). */
  function copyTriggers(words: readonly string[]): void {
    const text = words.join(", ");
    const clipboard = navigator.clipboard;
    if (clipboard === undefined) {
      toast.error(t("image_gen_lora_triggers_copy_failed"));
      return;
    }
    void clipboard
      .writeText(text)
      .then(() => toast.success(t("image_gen_lora_triggers_copied")))
      .catch(() => toast.error(t("image_gen_lora_triggers_copy_failed")));
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="image-gen-ft-loras">
      <button
        type="button"
        data-testid="image-gen-ft-loras-header"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center justify-between rounded-md px-1.5 py-1.5 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t2 transition-colors hover:bg-s2 hover:text-t1"
      >
        <span>
          {t("image_gen_loras_label")}
          {enabledCount > 0 && (
            <span className="ml-1.5 font-normal text-t3" data-testid="image-gen-ft-loras-count">
              {t("image_gen_loras_enabled", { count: enabledCount })}
            </span>
          )}
        </span>
        <Icons.Caret direction={open ? "d" : "u"} />
      </button>

      {open && (
        <div className="flex flex-col gap-2 px-1.5" data-testid="image-gen-ft-loras-body">
          {failed ? (
            <span
              className="px-1 py-2 text-[calc(var(--ui-fs)-3px)] text-danger"
              data-testid="image-gen-ft-loras-failed"
            >
              {t("image_gen_loras_failed")}
            </span>
          ) : loras === null ? (
            <div className="flex h-8 items-center justify-center" data-testid="image-gen-ft-loras-loading">
              <span className="text-[calc(var(--ui-fs)-3px)] text-t3">…</span>
            </div>
          ) : (
            <>
              <DropdownSelect
                value={familyFilter}
                options={[
                  { id: FAMILY_ALL, label: t("image_gen_loras_family_all") },
                  ...families.named.map((f) => ({ id: f, label: f })),
                  ...(families.hasUnknown
                    ? [{ id: FAMILY_UNKNOWN, label: t("image_gen_loras_family_unknown") }]
                    : []),
                ]}
                onChange={(id) => {
                  setFilterTouched(true);
                  setFamilyFilter(id);
                }}
                disabled={disabled}
                triggerTestId="image-gen-ft-loras-family"
              />

              <SearchInput
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("image_gen_loras_search_placeholder")}
                aria-label={t("image_gen_loras_search_placeholder")}
                data-testid="image-gen-ft-loras-search"
              />

              <div className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-0.5" data-testid="image-gen-ft-loras-list">
                {rows.length === 0 && (
                  <span
                    className="px-1 py-2 text-[calc(var(--ui-fs)-3px)] text-t4"
                    data-testid="image-gen-ft-loras-none"
                  >
                    {t("image_gen_loras_none")}
                  </span>
                )}
                {rows.map((lora) => {
                  const pick = draft.loras?.find((p) => p.name === lora.name);
                  const enabled = pick !== undefined;
                  return (
                    <div
                      key={lora.name}
                      data-testid="image-gen-ft-lora-row"
                      data-lora={lora.name}
                      className="flex flex-col gap-1 rounded-md px-1 py-1 transition-colors hover:bg-s2/60"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Toggle
                          checked={enabled}
                          onChange={(checked) => setLoraEnabled(chatId, lora.name, checked)}
                          disabled={disabled}
                          aria-label={lora.name}
                        />
                        <span
                          className="min-w-0 flex-1 truncate font-ui text-[calc(var(--ui-fs)-2px)] text-t2"
                          title={lora.name}
                        >
                          {lora.name}
                        </span>
                        {lora.triggerWords.length > 0 && (
                          <button
                            type="button"
                            data-testid="image-gen-ft-lora-triggers"
                            // Full words in the tooltip: the row may truncate the
                            // chip, but the full value must stay reachable (the
                            // truncation contract; some loras carry a whole
                            // prompt template as their trigger).
                            title={lora.triggerWords.join(", ")}
                            aria-label={`${lora.name}: ${t("image_gen_lora_triggers_label")}`}
                            onClick={() => copyTriggers(lora.triggerWords)}
                            className="max-w-[60%] shrink-0 cursor-pointer truncate rounded border border-border bg-s2 px-1.5 py-0.5 text-left font-mono text-[calc(var(--ui-fs)-4px)] text-t3 transition-colors hover:border-accent/50 hover:text-t1"
                          >
                            {lora.triggerWords.join(", ")}
                          </button>
                        )}
                      </div>
                      {enabled && (
                        <SliderField
                          label={t("image_gen_lora_strength_label")}
                          value={pick.strength}
                          min={IMAGE_GEN_PARAM_RANGES.loraStrength.min}
                          max={IMAGE_GEN_PARAM_RANGES.loraStrength.max}
                          step={IMAGE_GEN_PARAM_RANGES.loraStrength.step}
                          onChange={(value) => setLoraStrength(chatId, lora.name, value)}
                          disabled={disabled}
                          rangeTestId="image-gen-ft-lora-strength"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
