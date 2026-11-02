/**
 * Path B body of the first-run SetupWizard: the SillyTavern bulk-import step.
 *
 * Extracted from SetupWizard.tsx when CNR-8g moved the wizard step bodies onto
 * the shared thin ScrollArea lane — the file-size ratchet requires growth to
 * leave the file as an extraction, never as trimming. Behavior is identical to
 * the former inline component: the step body scrolls on the thin lane (3px
 * rest / 5px hover), the wizard panel's max-h cap stays outside the scroller,
 * and the body padding rides the content element so it scrolls with the body.
 */
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { StFolderImport } from "../modals/ImportModals.js";
import { ScrollArea } from "../shared/scroll-area.js";

export function StMigrationStep({ onImported }: { onImported: () => void }) {
  const { t } = useT();
  const isMobile = useIsMobile();

  return (
    <ScrollArea scrollbarSize="thin" className="flex-1" contentClassName={cn("flex flex-col gap-4", isMobile ? "px-4 pb-4" : "px-7 pb-7")}>
      <div className="font-ui text-[var(--ui-fs)] text-t2">{t("wizard_st_hint")}</div>
      <StFolderImport onImported={onImported} />
    </ScrollArea>
  );
}
