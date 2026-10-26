// fork #1 of ImagePromptTemplatesPane renderRowDisclosure row chrome
// (apps/web/src/components/settings/prompt/ImagePromptTemplatesPane.tsx) —
// SC-8e carved the assist row out of the pane when the pane hit its
// file-size ratchet (995). Correspondence map: the section wrapper, the
// disclosure toggle, and the family DropdownSelect mirror the template rows
// exactly; deviations: no canon/custom status dot (each editor's own Reset
// button carries its canon/custom state), the family switch runs the
// discard guard, and a canon-less family keeps the no-addendum line with no
// editor. The draft map, whole-profile save, and profile-switch guard stay
// in the pane — this row only reads its two draft bodies and reports edits
// back through callbacks.

import { useState } from "react";
import type {
  ImagePromptFamilyValue,
  ImagePromptProfileDetailResponse,
  ImagePromptProfileValue,
} from "@vibe-tavern/api-contracts";
import { IMAGE_PROMPT_DEFAULT_FAMILY } from "@vibe-tavern/domain";
import { useT } from "../../../i18n/context.js";
import { normalizeDraftCell } from "./image-prompt-draft.js";
import { cn } from "../../../lib/cn.js";
import { codeQuoteCls, lblCls } from "../../../lib/field-tokens.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { AnimatedDisclosure } from "../../shared/AnimatedDisclosure.js";
import { DestructiveConfirmModal } from "../../shared/destructive-confirm-modal.js";
import { DropdownSelect } from "../../shared/DropdownSelect.js";
import { Icons } from "../../shared/icons.js";

/** SC-8e — the assist extraction-core override key (one per profile, every
 *  family); addenda ride `assist|<family>` for the canon-addendum family. */
export const ASSIST_CORE_KEY = `assist|${IMAGE_PROMPT_DEFAULT_FAMILY}`;

/** SC-8e — the saved override entry for an assist key; undefined = that part
 *  is canon. Compared against the profile overrides (the dirty machine's
 *  source of truth), not the catalog's derived custom tier. */
export function savedAssistEntry(overrides: ImagePromptProfileValue["overrides"], key: string) {
  return Object.entries(overrides).find(([entryKey]) => entryKey === key)?.[1];
}

export interface ImagePromptAssistRowProps {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  saving: boolean;
  /** The Default profile stays a read-only canon view, like every other row. */
  readOnly: boolean;
  family: ImagePromptFamilyValue | undefined;
  familyOptions: Array<{ id: string; label: string; detail?: string }>;
  /** Raw family select — the discard guard below intercepts dirty switches. */
  onFamilySelect: (family: ImagePromptFamilyValue) => void;
  /** The profile detail: the row reads the assist canon/custom tiers and the
   *  saved overrides from it (dirty compare + discard revert). */
  detail: ImagePromptProfileDetailResponse;
  /** The pane's draft-map read: null = the core, otherwise that family's
   *  addendum; returns null when no draft (the custom tier or canon shows). */
  getDraftBody: (family: ImagePromptFamilyValue | null) => string | null;
  /** The pane's draft-map write (whole-profile save and dirty detection ride
   *  the pane's shared cell path unchanged). */
  writeDraft: (
    apply: (
      drafts: Record<string, { body: string; qualityText: string | null }>,
    ) => Record<string, { body: string; qualityText: string | null }>,
  ) => void;
}

export function ImagePromptAssistRow({
  label,
  expanded,
  onToggle,
  saving,
  readOnly,
  family,
  familyOptions,
  onFamilySelect,
  detail,
  getDraftBody,
  writeDraft,
}: ImagePromptAssistRowProps) {
  const { t } = useT();
  /** The family-switch discard target: leaving the addendum family with a
   *  dirty addendum draft asks first (mirrors the pane's pendingSelectId
   *  machine for profile switches). */
  const [pendingFamily, setPendingFamily] = useState<ImagePromptFamilyValue | null>(null);
  const assist = detail.catalog.assist;
  const addendumKey = family ? `assist|${family}` : null;
  const addendumCanon = family ? assist.addenda[family] : undefined;
  const coreDraftBody = getDraftBody(null);
  const addendumDraftBody = addendumKey ? getDraftBody(family ?? null) : null;
  const savedAddendumBody = addendumKey ? savedAssistEntry(detail.profile.overrides, addendumKey)?.body ?? null : null;
  const isCoreCustomized = coreDraftBody !== null;
  const isAddendumCustomized = addendumDraftBody !== null;
  const isAddendumDirty = addendumCanon !== undefined && addendumDraftBody !== savedAddendumBody;

  const resetDraftKey = (key: string) => {
    writeDraft((drafts) => {
      const next = { ...drafts };
      delete next[key];
      return next;
    });
  };

  /** The discard half of the family-switch guard: revert the left family's
   *  addendum draft to its saved state (canon when no saved override) and
   *  complete the switch. Mirrors the pane's confirmDiscard. */
  const confirmFamilySwitch = () => {
    const target = pendingFamily;
    setPendingFamily(null);
    if (!target || !addendumKey) return;
    const leftKey = addendumKey;
    const saved = savedAssistEntry(detail.profile.overrides, leftKey);
    writeDraft((drafts) => {
      const next = { ...drafts };
      if (saved) next[leftKey] = normalizeDraftCell(saved);
      else delete next[leftKey];
      return next;
    });
    onFamilySelect(target);
  };

  return (
    <section data-testid="image-prompt-template-row-assist" className="flex flex-col rounded-md border border-border">
      <div className="flex min-w-0 items-center gap-1.5 px-3 py-2.5">
        {/* The toggle bleeds over the wrapper's padding (-ml/-my restores the
            same text position via pl/py), so the ENTIRE row surface — not a
            narrow content-height band — is the disclosure's hit area. */}
        <button
          type="button"
          onClick={onToggle}
          disabled={saving}
          className="-ml-3 -my-2.5 flex min-w-0 flex-1 items-center gap-1.5 py-2.5 pl-3 text-left"
        >
          <span className="min-w-0 flex-shrink font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2">{label}</span>
          <span className="ml-auto flex shrink-0 text-t4">
            <Icons.Caret direction={expanded ? "u" : "d"} />
          </span>
        </button>
        {family && (
          <DropdownSelect
            value={family}
            options={familyOptions}
            onChange={(next) => {
              const nextFamily = next as ImagePromptFamilyValue;
              if (nextFamily !== family && isAddendumDirty) {
                setPendingFamily(nextFamily);
                return;
              }
              onFamilySelect(nextFamily);
            }}
            disabled={saving}
            searchable={false}
            triggerDetail={false}
            contentWidth={300}
            triggerTestId="image-prompt-template-family-assist"
            triggerClassName="h-7 w-auto max-w-[136px] rounded border border-border bg-s2 px-2 py-0 font-ui text-[calc(var(--ui-fs)-3px)] text-t1 hover:border-accent"
          />
        )}
      </div>
      <AnimatedDisclosure open={expanded}>
        <div className="flex flex-col gap-4 px-3 pb-3">
          {readOnly && (
            <>
              <div>
                <div className={lblCls}>{t("imagePromptTemplates.assistCore")}</div>
                <div data-testid="image-prompt-template-assist-core" className={cn(codeQuoteCls, "max-h-56 overflow-auto")}>{assist.core}</div>
              </div>
              <div>
                <div className={lblCls}>{t("imagePromptTemplates.assistAddendum")}</div>
                <div data-testid="image-prompt-template-assist-addendum" className={cn(codeQuoteCls, "max-h-56 overflow-auto")}>{addendumCanon ?? t("imagePromptTemplates.noAssistAddendum")}</div>
              </div>
            </>
          )}
          {!readOnly && (
            <>
              <div>
                <div className={lblCls}>{t("imagePromptTemplates.assistCore")}</div>
                <AutoTextarea
                  mono
                  value={coreDraftBody ?? assist.coreCustom.text ?? assist.core}
                  onChange={(event) => {
                    const body = event.target.value;
                    writeDraft((drafts) => ({ ...drafts, [ASSIST_CORE_KEY]: { body, qualityText: null } }));
                  }}
                  disabled={saving}
                  minRows={4}
                  maxRows={12}
                  aria-label={t("imagePromptTemplates.assistCore")}
                  data-testid="image-prompt-template-assist-core"
                />
                {isCoreCustomized && (
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => resetDraftKey(ASSIST_CORE_KEY)}
                      disabled={saving}
                      className="h-7 cursor-pointer rounded-md border border-border bg-transparent px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:bg-s2 hover:text-t1 disabled:opacity-50"
                    >
                      {t("reset")}
                    </button>
                  </div>
                )}
              </div>
              <div>
                <div className={lblCls}>{t("imagePromptTemplates.assistAddendum")}</div>
                {addendumCanon === undefined ? (
                  <div data-testid="image-prompt-template-assist-addendum" className={cn(codeQuoteCls, "max-h-56 overflow-auto")}>{t("imagePromptTemplates.noAssistAddendum")}</div>
                ) : (
                  <>
                    <AutoTextarea
                      mono
                      value={addendumDraftBody ?? (family ? assist.addendaCustom[family]?.text ?? null : null) ?? addendumCanon}
                      onChange={(event) => {
                        if (!addendumKey) return;
                        const key = addendumKey;
                        const body = event.target.value;
                        writeDraft((drafts) => ({ ...drafts, [key]: { body, qualityText: null } }));
                      }}
                      disabled={saving}
                      minRows={3}
                      maxRows={10}
                      aria-label={t("imagePromptTemplates.assistAddendum")}
                      data-testid="image-prompt-template-assist-addendum"
                    />
                    {isAddendumCustomized && (
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => addendumKey && resetDraftKey(addendumKey)}
                          disabled={saving}
                          className="h-7 cursor-pointer rounded-md border border-border bg-transparent px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:bg-s2 hover:text-t1 disabled:opacity-50"
                        >
                          {t("reset")}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
              {pendingFamily && (
                <DestructiveConfirmModal
                  title={t("promptManager.servicePrompts.discardTitle")}
                  body={t("promptManager.servicePrompts.discardBody")}
                  confirmLabel={t("confirm")}
                  onConfirm={confirmFamilySwitch}
                  onCancel={() => setPendingFamily(null)}
                />
              )}
            </>
          )}
        </div>
      </AnimatedDisclosure>
    </section>
  );
}
