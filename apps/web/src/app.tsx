import { useVibeTavernApp } from "./hooks/use-vibe-tavern-app.js";
import { useT } from "./i18n/context.js";
import { AppShell } from "./components/layout/AppShell.js";
import { TooltipProvider } from "./components/shared/Tooltip.js";
import { Logo } from "./components/shared/Logo.js";
import { useSessionStore } from "./stores/session-store.js";
// CA-15: rehydrate any persisted co-author proposals before the app renders,
// so an in-review diff survives a page reload. No-op without localStorage
// (runs at module load, once, before App() mounts any co-author surface).
import { rehydrateCoauthorDrafts } from "./lib/coauthor-draft.js";
rehydrateCoauthorDrafts();

export function App() {
  const { t } = useT();
  const { isLoading, loadError, retryLoad, tweaksSettings, setTweaksSettings } = useVibeTavernApp();
  const sessionRevoked = useSessionStore((s) => s.revoked);
  const resetSession = useSessionStore((s) => s.reset);

  if (sessionRevoked) {
    return (
      <div className="flex h-screen overflow-hidden bg-bg text-t1 font-ui">
        <main className="flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden">
          <div style={{ display: "grid", gap: 12, maxWidth: 420, padding: 24, textAlign: "center" }}>
            <Logo className="h-[80px] w-[80px] mx-auto" />
            <div className="build-section-title">{t("session_revoked")}</div>
            <div className="build-section-sub">{t("session_revoked_description")}</div>
            <button
              className="api-save-btn"
              onClick={() => {
                resetSession();
                void retryLoad();
              }}
            >
              {t("retry")}
            </button>
          </div>
        </main>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-screen overflow-hidden bg-bg text-t1 font-ui">
        <main className="flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden">
          <div className="flex flex-col items-center gap-6">
            <Logo animated className="h-[180px] w-[180px]" />
            <div className="font-body text-[12.5px] italic text-t3">{t("loading_app")}</div>
          </div>
        </main>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-screen overflow-hidden bg-bg text-t1 font-ui">
        <main className="flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden">
          <div style={{ display: "grid", gap: 12, maxWidth: 420, padding: 24 }}>
            <div className="build-section-title">{t("bootstrap_failed")}</div>
            <div className="build-section-sub">{loadError}</div>
            <button className="api-save-btn" onClick={() => void retryLoad()}>
              {t("retry")}
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <AppShell
        tweaksSettings={tweaksSettings}
        setTweaksSettings={setTweaksSettings}
      />
    </TooltipProvider>
  );
}
