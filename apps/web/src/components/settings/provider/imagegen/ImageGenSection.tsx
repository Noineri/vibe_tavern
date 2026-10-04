import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { ProviderSection } from "../provider-section.js";
import { ProviderProfileList } from "../ProviderProfileList.js";
import type { useImageProfiles } from "../../../../hooks/use-image-profiles.js";
import type { ImageGenProfileRecord } from "../../../../api/image-gen-api.js";
import { useImageGenChatStore } from "../../../../stores/image-gen-chat-store.js";
import { getImageGenProfilePresetLabel } from "./imagegen-profile-list-helpers.js";

type ImageGenHook = ReturnType<typeof useImageProfiles>;

/** Image-gen master column for the Providers modal (IMAGE_GENERATION_PLAN
 *  IG-11) — a ProviderSection / ProviderProfileList consumer. The new-profile
 *  seed is a bare CUSTOM profile (presetId
 *  null): its wire backend is the OpenAI-images dialect (IG-CF8 — the only
 *  implemented cloud dialect for custom endpoints; an implementation fact,
 *  not a UI choice). */
export function ImageGenSection({ imageGen }: { imageGen: ImageGenHook }) {
  const { t } = useT();
  const activeImageGenProfileId = useImageGenChatStore((state) => state.activeImageGenProfileId);
  // MR-12: session pointer wins; otherwise use the persisted default after a
  // reload/restart, when the session pointer is null.
  const effectiveActiveId =
    activeImageGenProfileId ?? imageGen.profiles.find((profile) => profile.isDefault)?.id ?? null;

  return (
    <ProviderSection
      testidStem="image-gen"
      titleKey="image_gen_section_title"
      loadingKey="loading"
      errorKey="image_gen_profiles_load_failed"
      loading={imageGen.loading}
      error={imageGen.error}
    >
      <ProviderProfileList
        profiles={imageGen.profiles}
        filteredProfiles={imageGen.filteredProfiles ?? imageGen.profiles}
        editingId={imageGen.editingId}
        activeProfileId={null}
        rowActive={(profile) => effectiveActiveId === profile.id}
        rowSubLabel={(profile) => getImageGenProfilePresetLabel(profile.backend, profile.presetId)}
        statusClassName={imageGenStatusClassName}
        titleKey="image_gen_section_title"
        newProfileKey="image_gen_profile_new"
        testidStem="image-gen"
        profileSearch={imageGen.profileSearch ?? ""}
        onProfileSearchChange={imageGen.setProfileSearch ?? (() => {})}
        onSelectProfile={imageGen.select}
        onAddProfile={() => {
          imageGen.startCreate(t("image_gen_profile_default_name"), IMAGE_GEN_CUSTOM_SEED_BACKEND);
        }}
        onReorder={imageGen.reorder}
      />
    </ProviderSection>
  );
}

/** New-profile seed backend (IG-CF8): a fresh profile is a bare CUSTOM one
 *  (presetId null), and custom speaks the OpenAI-images dialect under the
 *  hood — the only implemented cloud dialect for custom endpoints. */
const IMAGE_GEN_CUSTOM_SEED_BACKEND = IMAGE_GEN_BACKENDS.OpenAiImages;

const imageGenStatusClassName = (_profile: ImageGenProfileRecord, _isActive: boolean, isEditing: boolean) =>
  isEditing ? "bg-accent" : "bg-t4";
