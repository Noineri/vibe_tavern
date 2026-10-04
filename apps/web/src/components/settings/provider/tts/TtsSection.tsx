import { ProviderSection } from "../provider-section.js";
import { ProviderProfileList } from "../ProviderProfileList.js";
import type { useTtsProfiles } from "./use-tts-profiles.js";
import type { TtsProfileRecord } from "../../../../api/tts-api.js";

type TtsHook = ReturnType<typeof useTtsProfiles>;

const ttsRowSubLabel = (profile: TtsProfileRecord) => profile.backend;
const ttsStatusClassName = (_profile: TtsProfileRecord, _isActive: boolean, isEditing: boolean) =>
  isEditing ? "bg-accent" : "bg-t4";

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
        activeProfileId={null}
        rowSubLabel={ttsRowSubLabel}
        statusClassName={ttsStatusClassName}
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
