/**
 * CharacterFilterPicker — the id-bound character filter for a lore entry:
 * avatar chips (with ghost-binding to reserve a slot) plus an "exclude" toggle.
 * Extracted from LoreEntryEditor.tsx (behavior-preserving decomposition — see
 * reports/lorebook-editor-form-state-gap.md Step 1).
 *
 * Owns its picker open-state (`charFilterPicker`: null | "add" | index). Reads
 * `characterFilter` / `characterFilterExclude` and writes them DIRECTLY to the
 * lifted RHF form via `useFormContext` (the form→entries mirror in
 * useLorebookEditorState keeps the master list live + re-arms the debounced
 * autosave); pulls the character list from the snapshot store itself.
 */
import { useState } from "react";
import { useFormContext, useController } from "react-hook-form";
import * as Popover from "@radix-ui/react-popover";

import { useAllCharacters } from "../../../stores/snapshot-store.js";
import { FieldLabel } from "../fields/field-label.js";
import { Checkbox } from "../../shared/Checkbox.js";
import { cn } from "../../../lib/cn.js";
import { resolveEntityAvatarUrl } from "../../../lib/avatar.js";
import { getModalPortal } from "../../shared/modal-helpers.js";
import { popoverMaxHeight } from "../../shared/popover-constants.js";
import { useT, type TFunc } from "../../../i18n/context.js";
import type { LoreEntryRecord } from "../../../app-client.js";

export function CharacterFilterPicker({ t }: { t: TFunc }) {
  const form = useFormContext<LoreEntryRecord>();
  // characterFilter drives the avatar-chip render (map/filter/some) — watch it
  // so the chips stay live as entries are added/removed.
  const characterFilter = form.watch("characterFilter");
  // The exclude toggle is a single controlled checkbox — bind it directly via
  // useController (scoped subscription, no whole-picker re-render on toggle).
  const { field: excludeField } = useController({
    control: form.control,
    name: "characterFilterExclude",
  });
  const allCharacters = useAllCharacters();
  const [charFilterPicker, setCharFilterPicker] = useState<"add" | number | null>(null);

  return (
    <div className="mb-6 pb-6 border-b border-border/50">
      <FieldLabel>
        {t("lore_charfilter_section")}
      </FieldLabel>
      <Popover.Root open={charFilterPicker !== null} onOpenChange={(o) => { if (!o) setCharFilterPicker(null); }}>
        <Popover.Anchor asChild>
          <div
            className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-s2 px-2.5 py-1.5"
            style={{ minHeight: 38 }}
          >
            {characterFilter.map((f, idx) => {
              const isGhost = f.id === null;
              const ch = f.id ? allCharacters.find((c) => c.id === f.id) : undefined;
              const avatarUrl = ch
                ? resolveEntityAvatarUrl({
                    kind: "characters",
                    id: ch.id,
                    avatarExt: ch.avatarExt,
                    avatarAssetId: ch.avatarAssetId,
                    avatarFullExt: ch.avatarFullExt,
                    avatarFullAssetId: ch.avatarFullAssetId,
                    updatedAt: ch.updatedAt,
                  })
                : null;
              return (
                <span
                  key={`${f.id ?? "ghost"}-${idx}`}
                  className={cn(
                    "flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] transition-all",
                    isGhost
                      ? "cursor-pointer border border-dashed border-amber-500/60 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                      : "bg-accent-dim text-accent-t hover:bg-border2 hover:text-t1",
                  )}
                  title={isGhost ? t("lore_char_filter_bind") : undefined}
                  onClick={isGhost ? () => setCharFilterPicker(idx) : undefined}
                >
                  <span className="h-4 w-4 shrink-0 overflow-hidden rounded-full bg-s3">
                    {avatarUrl ? (
                      <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-[8px] font-bold text-t3">
                        {f.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                  </span>
                  <span className="max-w-[120px] truncate">{f.name}</span>
                  {!isGhost && (
                    <button
                      type="button"
                      className="ml-0.5 cursor-pointer text-t3 hover:text-t1"
                      onClick={(e) => {
                        e.stopPropagation();
                        form.setValue(
                          "characterFilter",
                          characterFilter.filter((_, i) => i !== idx),
                          { shouldDirty: true },
                        );
                      }}
                    >
                      ✕
                    </button>
                  )}
                </span>
              );
            })}
            <button
              type="button"
              className="cursor-pointer rounded px-2 py-0.5 text-[12px] text-t3 transition-all hover:bg-s3 hover:text-t1"
              onClick={() => setCharFilterPicker("add")}
            >
              + {t("lore_char_filter_placeholder")}
            </button>
          </div>
        </Popover.Anchor>
        <Popover.Portal container={getModalPortal() ?? undefined}>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={4}
            className="glass-blur z-[220] w-full overflow-y-auto rounded-lg border border-border2 bg-glass-bg py-1 shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
            style={{ maxHeight: popoverMaxHeight("singleLine") }}
          >
            {charFilterPicker !== null && (
              allCharacters.filter((c) => !characterFilter.some((f) => f.id === c.id)).length === 0 ? (
                <div className="px-3 py-2 text-[12px] text-t3">{t("lore_char_filter_empty")}</div>
              ) : (
                allCharacters
                  .filter((c) => !characterFilter.some((f) => f.id === c.id))
                  .map((c) => {
                    const url = resolveEntityAvatarUrl({
                      kind: "characters",
                      id: c.id,
                      avatarExt: c.avatarExt,
                      avatarAssetId: c.avatarAssetId,
                      avatarFullExt: c.avatarFullExt,
                      avatarFullAssetId: c.avatarFullAssetId,
                      updatedAt: c.updatedAt,
                    });
                    return (
                      <button
                        type="button"
                        key={c.id}
                        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[13px] text-t1 hover:bg-s2"
                        onClick={() => {
                          const next = [...characterFilter];
                          if (charFilterPicker === "add") {
                            next.push({ id: c.id, name: c.name });
                          } else {
                            // Bind the ghost at this index to the chosen character.
                            next[charFilterPicker] = { id: c.id, name: c.name };
                          }
                          form.setValue("characterFilter", next, { shouldDirty: true });
                          setCharFilterPicker(null);
                        }}
                      >
                        <span className="h-5 w-5 shrink-0 overflow-hidden rounded-full bg-s3">
                          {url ? (
                            <img src={url} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <span className="flex h-full w-full items-center justify-center text-[10px] font-bold text-t3">
                              {c.name.charAt(0).toUpperCase()}
                            </span>
                          )}
                        </span>
                        <span className="truncate">{c.name}</span>
                      </button>
                    );
                  })
              )
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <div className="mt-2">
        <Checkbox
          checked={excludeField.value}
          onChange={excludeField.onChange}
          label={t("lore_char_filter_exclude")}
        />
      </div>
    </div>
  );
}
