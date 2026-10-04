import { cn } from "../../../lib/cn.js";
import type { TFunc } from "../../../i18n/locale-helpers.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { LinkBindingPopover, type LinkTarget } from "../../shared/LinkBindingPopover.js";
import type { LorebookLinkRecord } from "../../../api/types.js";

interface LorebookOwnerPickerProps {
  links: LorebookLinkRecord[];
  characters: LinkTarget[];
  personas: LinkTarget[];
  onSetLinks: (links: Array<{ targetType: "character" | "persona"; targetId: string }>) => void;
  t: TFunc;
  isMobile: boolean;
  showLabel?: boolean;
  className?: string;
}

/** Renders the shared LinkBindingPopover for both lorebook creation and editing. */
export function LorebookOwnerPicker({
  links,
  characters,
  personas,
  onSetLinks,
  t,
  isMobile,
  showLabel = false,
  className,
}: LorebookOwnerPickerProps) {
  return (
    <div className={cn(className)}>
      {showLabel && <label className={lblCls}>{t("lore_link_targets")}</label>}
      <LinkBindingPopover
        links={links}
        characters={characters}
        personas={personas}
        onSetLinks={(nextLinks) => onSetLinks(
          nextLinks
            .filter((link): link is { targetType: "character" | "persona"; targetId: string } =>
              link.targetType === "character" || link.targetType === "persona",
            )
            .map(({ targetType, targetId }) => ({ targetType, targetId })),
        )}
        t={t}
        isMobile={isMobile}
      />
    </div>
  );
}
