import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { TokenCounter } from "../shared/TokenCounter.js";
import type { PersonaListItem } from "./PersonaModal.js";

interface PersonaListRowProps {
  persona: PersonaListItem;
  isActive: boolean;
  avatar: string | null;
  isMobile: boolean;
  /** Zero-arg; the host binds `persona.id` and any gating. */
  onSetDefault: () => void;
  /** Explicit activation ("use for chat"): activate this persona AND seed the editor. */
  onSelectForChat: () => void;
}

/**
 * PersonaListRow — the master-list row content for a persona (renamed from
 * PersonaCardCollapsed in Wave 4: after the master-detail port there is no
 * collapsed/editing card pair anymore, just list rows), in the
 * messenger layout (Wave 4): header line = avatar (88px, default-persona star
 * PR-8) + name with the explicit "use for chat" button (ProviderViewHeader
 * make-active pattern: accent border, pressed/disabled on the active persona)
 * + pronouns; the description (clamp-3) and token counter span the FULL row
 * width below (354px of text vs the old 256px side column — see the plan's
 * layout arithmetic). Row chrome (border-l-2, active bg, drill-down caret)
 * lives in the host's renderRow; row actions (Export / Duplicate / Delete)
 * live in the MasterDetailFooter.
 */
export function PersonaListRow({
  persona,
  isActive,
  avatar,
  isMobile,
  onSetDefault,
  onSelectForChat,
}: PersonaListRowProps) {
  const { t } = useT();

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      {/* Header line: avatar + star (PR-8) | name + use-for-chat + pronouns */}
      <div className="flex items-start gap-3">
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
        <div className="min-w-0 flex-1 py-0.5">
          <div className="flex items-center gap-2">
            <div className="min-w-0 truncate font-ui text-[15px] font-semibold tracking-tight text-t1" title={persona.name}>{persona.name}</div>
            {/* Explicit activation — ProviderViewHeader make-active pattern:
                accent border + accent-dim fill, hover fills solid; the active
                persona renders it pressed and disabled. */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSelectForChat();
              }}
              disabled={isActive}
              className="shrink-0 cursor-pointer rounded-md border border-accent bg-accent-dim px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-accent-t transition-colors hover:bg-accent hover:text-on-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isActive ? t("persona_chat_active") : t("persona_use_for_chat")}
            </button>
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
        </div>
      </div>
      {/* Description — spans the full row width (Wave 4 layout arithmetic). */}
      <div>
        <div className={cn("font-ui text-[13px] leading-snug text-t3", isMobile ? "line-clamp-2" : "line-clamp-3")}>{persona.description}</div>
        <TokenCounter text={persona.description} className="font-ui text-[11px] tabular-nums text-t3" />
      </div>
    </div>
  );
}
