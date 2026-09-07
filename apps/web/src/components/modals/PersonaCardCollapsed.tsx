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
  isMobile: boolean;
  /** Zero-arg; the host binds `persona.id` and any gating. */
  onSetDefault: () => void;
}

/**
 * PersonaCardCollapsed — the master-list row content for a persona: avatar +
 * default-persona star (PR-8) and the info block (name / pronouns / description
 * + token count). Row chrome (border-l-2, active bg, drill-down caret) lives
 * in the host's renderRow; row actions (Export / Duplicate / Delete) live in
 * the MasterDetailFooter (desktop) / footer icon buttons (mobile).
 */
export function PersonaCardCollapsed({
  persona,
  isActive,
  avatar,
  isMobile,
  onSetDefault,
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
    </>
  );
}
