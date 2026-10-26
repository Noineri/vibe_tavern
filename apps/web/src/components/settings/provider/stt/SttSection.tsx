import { ProviderSection } from "../provider-section.js";
import { ProviderProfileList } from "../ProviderProfileList.js";
import type { useSttProfiles } from "../../../../hooks/use-stt-profiles.js";
import type { SttProfileRecord } from "../../../../api/stt-api.js";

type SttHook = ReturnType<typeof useSttProfiles>;

const sttRowSubLabel = (profile: SttProfileRecord) => profile.backend;

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
      <ProviderProfileList
        profiles={stt.profiles}
        filteredProfiles={stt.filteredProfiles ?? stt.profiles}
        editingId={stt.editingId}
        activeProfileId={stt.defaultProfileId ?? null}
        rowSubLabel={sttRowSubLabel}
        titleKey="stt_section_title"
        newProfileKey="stt_profile_new"
        testidStem="stt"
        profileSearch={stt.profileSearch ?? ""}
        onProfileSearchChange={stt.setProfileSearch ?? (() => {})}
        onSelectProfile={stt.select}
        onAddProfile={stt.startCreate}
        onReorder={stt.reorder}
      />
    </ProviderSection>
  );
}
