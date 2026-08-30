import { useT } from "../../../../i18n/context.js";
import { TtsProfileList } from "./TtsProfileList.js";
import type { useTtsProfiles } from "./use-tts-profiles.js";

type TtsHook = ReturnType<typeof useTtsProfiles>;

export function TtsSection({ tts }: { tts: TtsHook }) {
  const { t } = useT();

  if (tts.loading) {
    return (
      <div data-testid="tts-section" className="flex flex-col p-3">
        <div className="mb-3 font-ui text-[12px] font-semibold uppercase tracking-wide text-t3">
          {t("tts_section_title")}
        </div>
        <div className="font-ui text-[13px] text-t3">{t("loading")}</div>
      </div>
    );
  }

  return (
    <div data-testid="tts-section" className="flex flex-col flex-1 min-h-0">
      {tts.error && (
        <div data-testid="tts-load-error" className="mx-3 mt-2 rounded-md bg-danger/10 px-3 py-2 font-ui text-[12px] text-danger">
          {t("tts_profiles_load_failed")}: {tts.error}
        </div>
      )}
      <TtsProfileList
        profiles={tts.profiles}
        editingId={tts.editingId}
        onSelectProfile={tts.select}
        onAddProfile={tts.startCreate}
      />
    </div>
  );
}
