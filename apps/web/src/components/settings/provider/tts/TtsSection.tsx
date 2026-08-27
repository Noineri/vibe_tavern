import { EmptyState } from "../../../shared/empty-state.js";
import { Icons } from "../../../shared/icons.js";
import { useT } from "../../../../i18n/context.js";

export function TtsSection() {
  const { t } = useT();
  return (
    <div data-testid="tts-section" className="flex flex-col p-3">
      <div className="mb-3 font-ui text-[12px] font-semibold uppercase tracking-wide text-t3">
        {t("tts_section_title")}
      </div>
      <EmptyState icon={<Icons.sparkles />} title={t("tts_section_title")} sub={t("tts_section_placeholder")} />
    </div>
  );
}
