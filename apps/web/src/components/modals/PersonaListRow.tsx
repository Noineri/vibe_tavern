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
 * collapsed/editing card pair anymore, just list rows). Layout per the
 * owner's ruled spec (defect D-2, 2026-09-07, Option A): LEFT column =
 * avatar (88px, default-persona star PR-8) with the explicit "use for chat"
 * button docked BELOW it (two-line wrap inside the avatar column,
 * «Выбрать для / чата», 11px desktop / 10px mobile, column 88px / 76px
 * mobile); RIGHT column = ONE metadata line (name left, token counter,
 * pronouns right) above the description, which lives ONLY in this column
 * (never wraps under the avatar) — clamp-6 desktop / clamp-4 mobile,
 * filling the height the left column (≈134px = avatar + button, ~158px
 * row) provides. Accepted trade-off (owner-approved): a 1-line
 * description leaves the right column mostly empty (row min-height is
 * driven by the left column). Row chrome (border-l-2, active bg,
 * drill-down caret) lives in the host's renderRow; row actions
 * (Export / Duplicate / Delete) live in the MasterDetailFooter.
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
    <div className="flex min-w-0 flex-1 items-start gap-3">
      {/* Left column (owner-ruled D-2): avatar, then the activation button
          under it — the button leaves the name line entirely, freeing the
          right column for text. */}
      <div className={cn("flex shrink-0 flex-col gap-2", isMobile ? "w-[76px]" : "w-[88px]")}>
        <div className="relative self-center">
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
          <span className="self-center font-ui text-[10px] text-t3">{t("persona_default_label")}</span>
        )}
        {/* Explicit activation — ProviderViewHeader make-active pattern:
            accent border + accent-dim fill, hover fills solid; the active
            persona renders it pressed and disabled. Owner-approved Option A:
            two-line wrap inside the avatar column («Выбрать для / чата»),
            11px desktop / 10px mobile — the RU label cannot fit one line at
            readable size in 88px, and widening the column would eat the
            description gain. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelectForChat();
          }}
          disabled={isActive}
          className={cn(
            "w-full shrink-0 cursor-pointer rounded-md border border-accent bg-accent-dim px-1 py-1 text-center font-ui font-medium leading-tight text-accent-t transition-colors hover:bg-accent hover:text-on-accent disabled:cursor-not-allowed disabled:opacity-50",
            isMobile ? "text-[10px]" : "text-[11px]",
          )}
        >
          {isActive ? t("persona_chat_active") : t("persona_use_for_chat")}
        </button>
      </div>
      {/* Right column: one metadata line (name + counter + pronouns) above
          the description. Name is the sole flexible element (min-w-0 +
          truncate + title); counter and pronouns are shrink-0, pushed right
          by the counter's ml-auto — worst RU case the name truncates first. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1 py-0.5">
        <div className="flex items-baseline gap-2">
          <div className="min-w-0 truncate font-ui text-[15px] font-semibold tracking-tight text-t1" title={persona.name}>{persona.name}</div>
          <TokenCounter text={persona.description} className="ml-auto shrink-0 font-ui text-[11px] tabular-nums text-t3" />
          {(() => {
            // For the 'custom' discriminator, show a compact subjective/objective
            // label derived from the structured forms (e.g. "ze/zir") instead of
            // the literal word "custom".
            if (persona.pronouns === "custom" && persona.pronounForms) {
              const f = persona.pronounForms;
              return <div className="shrink-0 font-ui text-[13px] text-t3">{f.subjective}/{f.objective}</div>;
            }
            if (persona.pronouns && persona.pronouns !== "custom") {
              return <div className="shrink-0 font-ui text-[13px] text-t3">{persona.pronouns}</div>;
            }
            return null;
          })()}
        </div>
        {/* Description — right column only (owner sketch): fills the height
            the left column provides; clamp-6 desktop (≈234 chars at 39/line,
            +44% vs the old full-width clamp-3) / clamp-4 mobile. */}
        <div className={cn("font-ui text-[13px] leading-snug text-t3", isMobile ? "line-clamp-4" : "line-clamp-6")}>{persona.description}</div>
      </div>
    </div>
  );
}
