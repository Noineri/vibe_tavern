import { useT } from "../../../../i18n/context.js";
import { SttProfileList } from "./SttProfileList.js";
import type { useSttProfiles } from "./use-stt-profiles.js";

type SttHook = ReturnType<typeof useSttProfiles>;

export function SttSection({ stt }: { stt: SttHook }) {
  const { t } = useT();

  if (stt.loading) {
    return (
      <div data-testid="stt-section" className="flex flex-col p-3">
        <div className="mb-3 font-ui text-[12px] font-semibold uppercase tracking-wide text-t3">
          {t("stt_section_title")}
        </div>
        <div className="font-ui text-[13px] text-t3">{t("loading")}</div>
      </div>
    );
  }

  return (
    <div data-testid="stt-section" className="flex flex-col flex-1 min-h-0">
      {stt.error && (
        <div data-testid="stt-load-error" className="mx-3 mt-2 rounded-md bg-danger/10 px-3 py-2 font-ui text-[12px] text-danger">
          {t("stt_profiles_load_failed")}: {stt.error}
        </div>
      )}
      <SttProfileList
        profiles={stt.profiles}
        editingId={stt.editingId}
        onSelectProfile={stt.select}
        onAddProfile={stt.startCreate}
      />
    </div>
  );
}