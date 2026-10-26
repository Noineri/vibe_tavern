import { ProviderSection } from "../provider-section.js";
import { ProviderProfileList } from "../ProviderProfileList.js";
import type { useTtsProfiles } from "../../../../hooks/use-tts-profiles.js";
import type { TtsProfileRecord } from "../../../../api/tts-api.js";

type TtsHook = ReturnType<typeof useTtsProfiles>;

const ttsRowSubLabel = (profile: TtsProfileRecord) => profile.backend;

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
      <ProviderProfileList
        profiles={tts.profiles}
        filteredProfiles={tts.filteredProfiles ?? tts.profiles}
        editingId={tts.editingId}
        activeProfileId={tts.defaultProfileId ?? null}
        rowSubLabel={ttsRowSubLabel}
        titleKey="tts_section_title"
        newProfileKey="tts_profile_new"
        testidStem="tts"
        profileSearch={tts.profileSearch ?? ""}
        onProfileSearchChange={tts.setProfileSearch ?? (() => {})}
        onSelectProfile={tts.select}
        onAddProfile={tts.startCreate}
        onReorder={tts.reorder}
      />
    </ProviderSection>
  );
}
