import { useRpPlatformApp } from "./hooks/use-vibe-tavern-app.js";
import { useT } from "./i18n/context.js";
import { AppShell } from "./components/AppShell.js";
import { fetchBootstrapAction } from "./stores/api-actions/bootstrap-actions.js";
import { TooltipProvider } from "./components/shared/Tooltip.js";

export function App() {
  const { t } = useT();
  const { isLoading, loadError, tweaksSettings, setTweaksSettings } = useRpPlatformApp();

  if (isLoading) {
    return (
      <div className="flex h-screen overflow-hidden bg-bg text-t1 font-ui">
        <main className="flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden">
          <div className="font-body text-[12.5px] italic text-t3">{t("loading_app")}</div>
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
            <button className="api-save-btn" onClick={() => void fetchBootstrapAction()}>
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
