import React from "react";
import { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app.js";
import "./lib/register-core-panels.jsx";
import { LocaleProvider } from "./i18n/context.js";
import { initI18n } from "./i18n/i18n.js";
import { isLocale, detectBrowserLocale, type Locale } from "./i18n/registry.js";
import { ThemeTuner } from "./components/dev/ThemeTuner.js";
import { VibeMdThemePreview } from "./components/build/editors/VibeMdThemePreview.js";
import { ExperienceDetachedHost, isDetachedExperienceWindow } from "./components/experience/ExperienceDetachedWindow.js";
import { clearMobileToken, extractTokenFromHash, saveMobileToken } from "./lib/mobile-token.js";
// D5 (v1.2.1): last-resort boundary — a render throw anywhere in the app must
// show the crash screen, never unmount the tree into a blank page.
import { RootErrorBoundary } from "./components/shared/RootErrorBoundary.js";
import "./styles.css";

// Extract the mobile token from the URL hash BEFORE React mounts. Child
// components (AppShell → providers/personas fetches) fire useEffects before
// the parent App's useEffect, so saving the token inside useVibeTavernApp's
// load() is too late — those early calls go out without a token and 401.
if (typeof window !== "undefined") {
  const hashToken = extractTokenFromHash();
  if (hashToken) saveMobileToken(hashToken);
}

// NOTE (2026-09-29 mobile outage): there is deliberately NO global fetch
// patching here anymore. Mobile auth (Bearer injection) and the 401
// "session revoked" watch both live in ONE seam — apiFetch in api/client.ts —
// and every same-origin /api call must go through it; scripts/check-bare-api-fetch.ts
// blocks a bare `fetch("/api/…")` from ever landing again (that bug class
// bricked LAN/mobile clients while desktop loopback stayed green).

function detectLocale(): Locale {
  // 1. Explicit user choice (saved in TweaksPanel) takes priority
  try {
    const raw = localStorage.getItem("vibe-tavern.tweaks");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isLocale(parsed.lang)) return parsed.lang;
    }
  } catch { /* ignore */ }

  // 2. Auto-detect from browser language, falling back to the default locale
  //    inside detectBrowserLocale when nothing matches.
  return detectBrowserLocale(navigator.language ?? "");
}

const initialLocale = detectLocale();

// Initialize i18next synchronously BEFORE React mounts. With `initAsync: false`
// and bundled resources, `i18next.t` is usable the instant this returns, so
// non-React `getT()` callers (store actions, api-actions, utils) have correct
// translations from the very first tick — including effects that fire before
// the LocaleProvider mount effect. The LocaleProvider effect re-calls this
// idempotently to cover the test/SSR path where this module isn't the entry.
initI18n(initialLocale);

/**
 * Top-level router. The app has no real router (single-page), but dev surfaces
 * are exposed at hash anchors so they can be opened directly without loading
 * the full app (and without needing the backend):
 *  - `#theme-tuner` — live theme variable editor.
 *  - `#vtf-preview` — Vibe MD amber-theme preview (TEMPORARY, VTF-10; remove
 *    once VTF-13 ships the real editor).
 * When the hash changes we re-render so entering/leaving is instant.
 */
function Root() {
  const [view, setView] = useState<"app" | "tuner" | "vtf" | "experience">(() => {
    if (isDetachedExperienceWindow()) return "experience";
    if (window.location.hash === "#theme-tuner") return "tuner";
    if (window.location.hash === "#vtf-preview") return "vtf";
    return "app";
  });
  useEffect(() => {
    const onHash = () => {
      if (isDetachedExperienceWindow()) setView("experience");
      else if (window.location.hash === "#theme-tuner") setView("tuner");
      else if (window.location.hash === "#vtf-preview") setView("vtf");
      else setView("app");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (view === "experience") return <ExperienceDetachedHost />;
  if (view === "tuner") return <ThemeTuner />;
  if (view === "vtf") return <VibeMdThemePreview />;
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocaleProvider initialLocale={initialLocale}>
      <RootErrorBoundary>
        <Root />
      </RootErrorBoundary>
    </LocaleProvider>
  </React.StrictMode>,
);
