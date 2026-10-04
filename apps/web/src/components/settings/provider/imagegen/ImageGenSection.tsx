import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { ProviderSection } from "../provider-section.js";
import { ImageGenProfileList } from "./ImageGenProfileList.js";
import type { useImageProfiles } from "../../../../hooks/use-image-profiles.js";

type ImageGenHook = ReturnType<typeof useImageProfiles>;

/** Image-gen master column for the Providers modal (IMAGE_GENERATION_PLAN
 *  IG-11) — the SttSection fork: loading label, load-error banner, the
 *  profile list. The new-profile seed is a bare CUSTOM profile (presetId
 *  null): its wire backend is the OpenAI-images dialect (IG-CF8 — the only
 *  implemented cloud dialect for custom endpoints; an implementation fact,
 *  not a UI choice). */
export function ImageGenSection({ imageGen }: { imageGen: ImageGenHook }) {
  const { t } = useT();

  return (
    <ProviderSection
      testidStem="image-gen"
      titleKey="image_gen_section_title"
      loadingKey="loading"
      errorKey="image_gen_profiles_load_failed"
      loading={imageGen.loading}
      error={imageGen.error}
    >
      <ImageGenProfileList
        profiles={imageGen.profiles}
        editingId={imageGen.editingId}
        onSelectProfile={imageGen.select}
        onAddProfile={() => {
          imageGen.startCreate(t("image_gen_profile_default_name"), IMAGE_GEN_CUSTOM_SEED_BACKEND);
        }}
      />
    </ProviderSection>
  );
}

/** New-profile seed backend (IG-CF8): a fresh profile is a bare CUSTOM one
 *  (presetId null), and custom speaks the OpenAI-images dialect under the
 *  hood — the only implemented cloud dialect for custom endpoints. */
const IMAGE_GEN_CUSTOM_SEED_BACKEND = IMAGE_GEN_BACKENDS.OpenAiImages;
