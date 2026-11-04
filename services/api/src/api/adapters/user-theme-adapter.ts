import type { UserThemeRuntimeApi } from "../contract/user-theme-api.js";
import type { UserThemeLibrary } from "../../domain/themes/user-theme-library.js";

/** Same delegation boundary as the file-backed skill adapter; CSS has no DB row. */
export class UserThemeAdapter implements UserThemeRuntimeApi {
  constructor(private readonly library: UserThemeLibrary) {}
  listUserThemes = () => this.library.list();
  readUserTheme = (id: string) => this.library.read(id);
  uploadUserTheme = (input: Parameters<UserThemeRuntimeApi["uploadUserTheme"]>[0]) => this.library.upload(input);
  deleteUserTheme = (id: string) => this.library.delete(id);
}
