import type { UploadUserTheme, UserTheme, UserThemeSummary } from "@vibe-tavern/api-contracts";
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";

export interface UserThemeApi {
  list: () => Promise<UserThemeSummary[]>;
  read: (id: string) => Promise<UserTheme | null>;
  upload: (input: UploadUserTheme) => Promise<UserTheme>;
  remove: (id: string) => Promise<void>;
}

export class UserThemeUploadError extends Error {
  constructor(readonly status: number) { super("User theme upload failed"); }
}

export const userThemeApi: UserThemeApi = {
  list: async () => unwrapRpc(await client.api["user-themes"].$get()),
  read: async (themeId) => {
    const response = await client.api["user-themes"][":themeId"].$get({ param: { themeId } });
    if (response.status === 404) return null;
    return unwrapRpc(response);
  },
  upload: async (input) => {
    const response = await client.api["user-themes"].$post({ json: input });
    if (!response.ok) throw new UserThemeUploadError(response.status);
    return unwrapRpc(response);
  },
  remove: async (themeId) => {
    const response = await client.api["user-themes"][":themeId"].$delete({ param: { themeId } });
    if (response.status !== 404) await unwrapRpc(response);
  },
};
