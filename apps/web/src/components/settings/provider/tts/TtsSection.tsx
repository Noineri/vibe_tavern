import { ProviderSection } from "../provider-section.js";
import { TtsProfileList } from "./TtsProfileList.js";
import type { useTtsProfiles } from "./use-tts-profiles.js";

type TtsHook = ReturnType<typeof useTtsProfiles>;

export function TtsSection({ tts }: { tts: TtsHook }) {
  return (
    <ProviderSection
      testidStem="tts"
      titleKey="tts_section_title"
      loadingKey="loading"
      errorKey="tts_profiles_load_failed"
      loading={tts.loading}
      error={tts.error}
    >
      <TtsProfileList
        profiles={tts.profiles}
        editingId={tts.editingId}
        onSelectProfile={tts.select}
        onAddProfile={tts.startCreate}
      />
    </ProviderSection>
  );
}
