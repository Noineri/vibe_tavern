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
 *
 * LB-3B: the candidate list is searchable on large libraries and ordered by
 * recently edited. One data source (AGENTS.md §3): records become LinkTargets
 * through `lib/link-targets.ts` and order/filter through
 * `lib/link-binding-sections.ts` (`orderLinkTargets` with an empty bound set —
 * already-added characters are excluded from the list — = updatedAt desc, then
 * name, then id; `matchesLinkQuery` for the search). Dual-mode canon
 * (ImageGenFineTuningChip / LinkBindingPopover): ONE body element rendered by
 * both shells — the Radix popover on desktop, a BottomSheet on mobile.
 */
import { useEffect, useRef, useState } from "react";
import { useFormContext, useController } from "react-hook-form";
import type { LoreEntryDraft } from "./use-lorebook-editor-state.js";
import * as Popover from "@radix-ui/react-popover";

import { useAllCharacters } from "../../../stores/snapshot-store.js";
import { FieldLabel } from "../fields/field-label.js";
import { Checkbox } from "../../shared/Checkbox.js";
import { cn } from "../../../lib/cn.js";
import { resolveEntityAvatarUrl } from "../../../lib/avatar.js";
import { getModalPortal } from "../../shared/modal-helpers.js";
import { MAX_VISIBLE_ITEMS, popoverMaxHeight } from "../../shared/popover-constants.js";
import { SearchInput } from "../../shared/SearchInput.js";
import { BottomSheet } from "../../shared/BottomSheet.js";
import { resolveTargetAvatarUrl } from "../../shared/LinkBindingPopover.js";
import { characterToLinkTarget } from "../../../lib/link-targets.js";
import { matchesLinkQuery, orderLinkTargets } from "../../../lib/link-binding-sections.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useT, type TFunc } from "../../../i18n/context.js";

export function CharacterFilterPicker({ t }: { t: TFunc }) {
  const form = useFormContext<LoreEntryDraft>();
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
  const isMobile = useIsMobile();
  const [charFilterPicker, setCharFilterPicker] = useState<"add" | number | null>(null);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Query is per-open state: reset whenever the picker closes (add or ghost).
  useEffect(() => { if (charFilterPicker === null) setQuery(""); }, [charFilterPicker]);

  // Candidates = characters not yet in the filter, as LinkTargets through the
  // ONE mapper, ordered by recently updated (bound set is empty BY
  // CONSTRUCTION — bound characters are excluded above).
  const candidates = orderLinkTargets(
    allCharacters
      .filter((c) => !characterFilter.some((f) => f.id === c.id))
      .map(characterToLinkTarget),
    new Set<string>(),
  );
  const showSearch = candidates.length > MAX_VISIBLE_ITEMS;
  const visibleCandidates = query.trim()
    ? candidates.filter((c) => matchesLinkQuery(c.name, query))
    : candidates;

  // Focus the search row when it exists — desktop only (no keyboard pop on
  // phones); otherwise keep Radix's default focus.
  const handleOpenAutoFocus = (e: Event) => {
    if (showSearch && !isMobile) {
      e.preventDefault();
      searchInputRef.current?.focus();
    }
  };

  const pick = (id: string, name: string) => {
    const mode = charFilterPicker;
    if (mode === null) return;
    const next = [...characterFilter];
    if (mode === "add") {
      next.push({ id, name });
    } else {
      // Bind the ghost at this index to the chosen character.
      next[mode] = { id, name };
    }
    form.setValue("characterFilter", next, { shouldDirty: true });
    setCharFilterPicker(null);
  };

  // ONE body, rendered by both shells (desktop Radix popover / mobile
  // BottomSheet) — the dual-mode canon.
  const body = (
    <>
      {showSearch && (
        <div className="shrink-0 border-b border-border px-3 py-2">
          <SearchInput
            ref={searchInputRef}
            className="w-full"
            placeholder={t("link_binding_search_placeholder")}
            aria-label={t("link_binding_search_placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
      {/* Only the item list scrolls; the search row never scrolls away.
       *  Desktop keeps the MAX_VISIBLE_ITEMS cap on the list wrapper; the
       *  mobile sheet uses the viewport-relative sheet cap instead
       *  (popover-constants.ts) with thumb-sized 44px rows. */}
      <div
        className={cn("overflow-y-auto", isMobile && "max-h-[50vh] overscroll-contain")}
        style={isMobile ? undefined : { maxHeight: popoverMaxHeight("singleLine") }}
      >
        {candidates.length === 0 ? (
          <div className={cn("px-3 py-2 text-t3", isMobile ? "text-[14px]" : "text-[12px]")}>{t("lore_char_filter_empty")}</div>
        ) : visibleCandidates.length === 0 ? (
          <div className={cn("px-3 py-2 text-t3", isMobile ? "text-[14px]" : "text-[12px]")}>{t("link_binding_no_results")}</div>
        ) : (
          visibleCandidates.map((c) => {
            const url = resolveTargetAvatarUrl(c);
            return (
              <button
                type="button"
                key={c.id}
                className={cn(
                  "flex w-full cursor-pointer items-center text-left text-t1 hover:bg-s2",
                  isMobile ? "min-h-[44px] gap-3 px-4 py-2 text-[15px]" : "gap-2 px-3 py-1.5 text-[13px]",
                )}
                onClick={() => pick(c.id, c.name)}
              >
                <span className={cn("shrink-0 overflow-hidden rounded-full bg-s3", isMobile ? "h-6 w-6" : "h-5 w-5")}>
                  {url ? (
                    <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
                  ) : (
                    <span className={cn("flex h-full w-full items-center justify-center font-bold text-t3", isMobile ? "text-[11px]" : "text-[10px]")}>
                      {c.name.charAt(0).toUpperCase()}
                    </span>
                  )}
                </span>
                <span className="truncate">{c.name}</span>
              </button>
            );
          })
        )}
      </div>
    </>
  );

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
                      <img src={avatarUrl} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
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
        {charFilterPicker !== null && !isMobile && (
          <Popover.Portal container={getModalPortal() ?? undefined}>
            <Popover.Content
              side="bottom"
              align="start"
              sideOffset={4}
              onOpenAutoFocus={handleOpenAutoFocus}
              className="glass-blur z-[220] w-full flex flex-col overflow-hidden rounded-lg border border-border2 bg-glass-bg shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
            >
              {body}
            </Popover.Content>
          </Popover.Portal>
        )}
      </Popover.Root>
      {charFilterPicker !== null && isMobile && (
        <BottomSheet
          open={true}
          onClose={() => setCharFilterPicker(null)}
          title={t("lore_charfilter_section")}
        >
          <div className="max-h-[80dvh]">{body}</div>
        </BottomSheet>
      )}
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
