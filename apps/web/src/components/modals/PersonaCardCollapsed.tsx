import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { TokenCounter } from "../shared/TokenCounter.js";
import type { PersonaListItem } from "./PersonaModal.js";

interface PersonaCardCollapsedProps {
  persona: PersonaListItem;
  isActive: boolean;
  avatar: string | null;
  isLastPersona: boolean;
  isMobile: boolean;
  /** Shared with the host: the actual mobile ActionSheet renders at content level. */
  menuOpenId: string | null;
  setMenuOpenId: (id: string | null) => void;
  /** All actions are zero-arg; the host binds `persona.id` and any gating. */
  onStartEdit: () => void;
  onExport: () => void;
  onDuplicate: () => void;
  onSetDefault: () => void;
  onDelete: () => void;
}

/**
 * PersonaCardCollapsed — the non-editing (display) view of a persona card,
 * extracted from PersonaModal's renderCard (PERSONA_MODAL_GOD_OBJECT_AUDIT.md,
 * Finding 2 / step 2). Owns the avatar + default-persona star (PR-8), the info
 * block (name / pronouns / description + token count), and the row actions
 * (Edit / Export / Duplicate / Delete inline on desktop; Edit inline + a
 * three-dots menu on mobile — PR-10). Rendered inside the host card wrapper, so
 * the `group`-hover affordances still apply. Actions are zero-arg callbacks
 * supplied by the host; the mobile three-dots `menuOpenId` is shared because the
 * ActionSheet itself lives at the content level.
 */
export function PersonaCardCollapsed({
  persona,
  isActive,
  avatar,
  isLastPersona,
  isMobile,
  menuOpenId,
  setMenuOpenId,
  onStartEdit,
  onExport,
  onDuplicate,
  onSetDefault,
  onDelete,
}: PersonaCardCollapsedProps) {
  const { t } = useT();

  return (
    <>
      {/* Avatar + default-persona star (PR-8) */}
      <div className="flex shrink-0 flex-col items-center gap-1">
        <div className="relative">
          <div
            className={cn(
              "flex items-center justify-center overflow-hidden rounded-full text-base shadow-inner ring-1 ring-white/5",
              isMobile ? "h-[68px] w-[68px]" : "h-[88px] w-[88px] text-lg",
              avatar
                ? "bg-s3"
                : isActive
                  ? "bg-accent text-on-accent"
                  : "bg-s3 text-t2",
            )}
          >
            {avatar
              ? <img src={avatar} alt="" className="h-full w-full object-cover" />
              : persona.name.slice(0, 1).toUpperCase()
            }
          </div>
          <CustomTooltip content={persona.defaultForNewChats ? t("default_persona_is") : t("set_default_persona")}>
            <button
              type="button"
              aria-label={t("set_default_persona")}
              className={cn(
                "absolute -right-1 -bottom-1 z-10 flex items-center justify-center rounded-full border border-border bg-surface transition-all hover:scale-110",
                isMobile ? "h-6 w-6" : "h-6 w-6",
                persona.defaultForNewChats ? "text-accent" : "text-t4 hover:text-accent",
              )}
              onClick={(e) => {
                e.stopPropagation();
                onSetDefault();
              }}
            >
              <Icons.Star />
            </button>
          </CustomTooltip>
        </div>
        {isMobile && persona.defaultForNewChats && (
          <span className="font-ui text-[10px] text-t3">{t("persona_default_label")}</span>
        )}
      </div>
      {/* Info */}
      <div className="min-w-0 flex-1 overflow-hidden py-0.5">
        <div className="flex items-center gap-2">
          <div className="font-ui text-[15px] font-semibold tracking-tight text-t1">{persona.name}</div>
        </div>
        {(() => {
          // For the 'custom' discriminator, show a compact subjective/objective
          // label derived from the structured forms (e.g. "ze/zir") instead of
          // the literal word "custom".
          if (persona.pronouns === "custom" && persona.pronounForms) {
            const f = persona.pronounForms;
            return <div className="font-ui text-[13px] text-t3">{f.subjective}/{f.objective}</div>;
          }
          if (persona.pronouns && persona.pronouns !== "custom") {
            return <div className="font-ui text-[13px] text-t3">{persona.pronouns}</div>;
          }
          return null;
        })()}
        <div className={cn("font-ui text-[13px] leading-snug text-t3", isMobile ? "line-clamp-2" : "line-clamp-3")}>{persona.description}</div>
        <TokenCounter text={persona.description} className="font-ui text-[11px] tabular-nums text-t3" />
      </div>
      {/* Actions — PR-10 revised:
          Desktop: all 4 buttons (Edit/Export/Copy/Delete) inline, visible on card hover.
          Mobile: Edit stays as a direct inline button (primary action); Export/Copy/Delete collapse into a three-dots menu (row too narrow for 4 inline buttons). */}
      <div className="relative flex shrink-0 items-start gap-0.5 self-start">
        <CustomTooltip content={t("persona_edit")}>
          <div
            className={cn(
              "flex cursor-pointer items-center justify-center rounded-md text-t3 transition-all hover:bg-s2 hover:text-t1 active:bg-s3",
              isMobile ? "min-h-[44px] min-w-[44px]" : "h-7 w-7",
              // Desktop: hidden until the card is hovered. Mobile: always visible.
              !isMobile && "opacity-0 group-hover:opacity-100",
            )}
            onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
          >
            <Icons.Edit />
          </div>
        </CustomTooltip>

        {!isMobile ? (
          /* Desktop: direct inline icon buttons */
          <>
            <CustomTooltip content={t("persona_export")}>
              <div
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-t3 opacity-0 transition-all hover:bg-s2 hover:text-t1 active:bg-s3 group-hover:opacity-100"
                onClick={(e) => { e.stopPropagation(); onExport(); }}
              >
                <Icons.download />
              </div>
            </CustomTooltip>
            <CustomTooltip content={t("duplicate")}>
              <div
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-t3 opacity-0 transition-all hover:bg-s2 hover:text-t1 active:bg-s3 group-hover:opacity-100"
                onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
              >
                <Icons.Copy />
              </div>
            </CustomTooltip>
            <CustomTooltip content={t("delete")}>
              <div
                className={cn(
                  "flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-all active:bg-s3 opacity-0 group-hover:opacity-100",
                  isLastPersona ? "text-t4" : "text-t3 hover:bg-s2 hover:text-danger",
                )}
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
              >
                <Icons.del />
              </div>
            </CustomTooltip>
          </>
        ) : (
          /* Mobile: Edit stays inline; Export/Copy/Delete in a bottom ActionSheet (reuses the same component the character rail uses). */
          <>
            <div
              className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s2 hover:text-t1 active:bg-s3"
              onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === persona.id ? null : persona.id); }}
            >
              <Icons.ellipsis />
            </div>
          </>
        )}
      </div>
    </>
  );
}
