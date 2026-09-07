/**
 * Last-resort error boundary around the whole app.
 *
 * v1.2.1 mobile defect D5: the lightbox pinch crash threw DURING RENDER, and
 * with no boundary anywhere near the root the whole tree unmounted — the user
 * saw a blank themed page that stayed dead until a manual reload. This
 * boundary converts any future render crash into a themed fallback screen
 * (same layout as the session-revoked screen in app.tsx) with a reload
 * action instead of a blank page.
 */
import { Component, type ReactNode } from "react";
import { useT } from "../../i18n/context.js";

interface RootErrorBoundaryProps {
  children: ReactNode;
}

interface RootErrorBoundaryState {
  hasError: boolean;
}

function CrashFallback(): ReactNode {
  const { t } = useT();
  return (
    <div className="flex h-screen overflow-hidden bg-bg text-t1 font-ui">
      <main className="flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden">
        <div style={{ display: "grid", gap: 12, maxWidth: 420, padding: 24, textAlign: "center" }}>
          <div className="build-section-title">{t("root_crash_title")}</div>
          <div className="build-section-sub">{t("root_crash_body")}</div>
          <button
            className="api-save-btn"
            onClick={() => window.location.reload()}
          >
            {t("root_crash_reload")}
          </button>
        </div>
      </main>
    </div>
  );
}

export class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): RootErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    // Developer-facing trace for prod console / remote device debugging;
    // CrashFallback is the user-facing part.
    console.error("[RootErrorBoundary] uncaught render error:", error);
  }

  render(): ReactNode {
    if (this.state.hasError) return <CrashFallback />;
    return this.props.children;
  }
}
