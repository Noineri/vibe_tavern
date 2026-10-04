import { ProviderSection } from "../provider-section.js";
import { SttProfileList } from "./SttProfileList.js";
import type { useSttProfiles } from "./use-stt-profiles.js";

type SttHook = ReturnType<typeof useSttProfiles>;

export function SttSection({ stt }: { stt: SttHook }) {
  return (
    <ProviderSection
      testidStem="stt"
      titleKey="stt_section_title"
      loadingKey="loading"
      errorKey="stt_profiles_load_failed"
      loading={stt.loading}
      error={stt.error}
    >
      <SttProfileList
        profiles={stt.profiles}
        editingId={stt.editingId}
        onSelectProfile={stt.select}
        onAddProfile={stt.startCreate}
      />
    </ProviderSection>
  );
}
