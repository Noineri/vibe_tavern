import { useEffect } from "react";
import { applyThemeClass, DEFAULT_THEME, userThemeSlug } from "../themes/registry.js";
import { useInterfaceSettingsStore } from "../stores/interface-settings-store.js";
import { useUserThemesStore } from "../stores/user-themes-store.js";

/** One owner for the root theme class and the lifetime of the selected user stylesheet. */
export function useInterfaceTheme(themes = useUserThemesStore, preferences = useInterfaceSettingsStore) {
  const id = preferences((state) => state.settings.theme);
  const catalog = themes((state) => state.themes);
  const loaded = themes((state) => state.loaded);
  const load = themes((state) => state.load);
  const read = themes((state) => state.read);
  useEffect(() => {
    // Errors are retained in the catalog store for the settings retry UI.
    void load().catch(() => undefined);
  }, [load]);
  useEffect(() => {
    const root = document.documentElement;
    let active = true;
    let style: HTMLStyleElement | undefined;
    themes.setState({ appliedThemeId: null, appliedLava: false });
    const apply = (theme: string) => {
      applyThemeClass(root, theme);
      // Splash inline tokens must not beat the real stylesheet's cascade.
      for (const token of ["--bg", "--accent", "--accent-mid"]) root.style.removeProperty(token);
    };
    const slug = userThemeSlug(id);
    if (slug === null) apply(id);
    else {
      apply(DEFAULT_THEME);
      if (loaded && !catalog.some((theme) => theme.id === slug)) preferences.getState().setSetting("theme", DEFAULT_THEME);
      else void read(slug).then((theme) => {
        if (!active) return;
        if (!theme) { preferences.getState().setSetting("theme", DEFAULT_THEME); return; }
        style = document.createElement("style");
        style.dataset.vtUserTheme = theme.id;
        style.textContent = theme.css;
        document.head.appendChild(style);
        apply(id);
        themes.setState({ appliedThemeId: id, appliedLava: getComputedStyle(root).getPropertyValue("--lamp-glass").trim().length > 0 });
      }).catch(() => undefined); // A transient read failure must not erase a saved selection.
    }
    return () => {
      active = false;
      style?.remove();
      if (themes.getState().appliedThemeId === id) themes.setState({ appliedThemeId: null, appliedLava: false });
    };
  }, [id, catalog, loaded, read, preferences, themes]);
}
