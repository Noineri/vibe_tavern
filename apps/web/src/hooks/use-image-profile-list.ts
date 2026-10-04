import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { reorderImageGenProfiles, type ImageGenProfileRecord } from "../api/image-gen-api.js";
import { getImageGenProfilePresetLabel } from "../components/settings/provider/imagegen/imagegen-profile-list-helpers.js";

/** Hook-owned ImageGen master-list search and manual-order persistence. */
export function useImageProfileList(
  profiles: ImageGenProfileRecord[],
  setProfiles: Dispatch<SetStateAction<ImageGenProfileRecord[]>>,
) {
  const [profileSearch, setProfileSearch] = useState("");
  const filteredProfiles = profileSearch.trim()
    ? profiles.filter((profile) => {
        const query = profileSearch.toLowerCase();
        return profile.name.toLowerCase().includes(query) ||
          getImageGenProfilePresetLabel(profile.backend, profile.presetId).toLowerCase().includes(query);
      })
    : profiles;
  const reorder = useCallback(async (updates: Array<{ id: string; sortOrder: number }>) => {
    setProfiles(await reorderImageGenProfiles(updates));
  }, [setProfiles]);

  return { profileSearch, setProfileSearch, filteredProfiles, reorder };
}
