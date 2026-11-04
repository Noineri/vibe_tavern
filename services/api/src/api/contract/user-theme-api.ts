import type { UploadUserTheme, UserTheme, UserThemeSummary } from "@vibe-tavern/api-contracts";

export interface UserThemeRuntimeApi {
  listUserThemes: () => Promise<UserThemeSummary[]>;
  readUserTheme: (id: string) => Promise<UserTheme>;
  uploadUserTheme: (input: UploadUserTheme) => Promise<UserTheme>;
  deleteUserTheme: (id: string) => Promise<void>;
}
