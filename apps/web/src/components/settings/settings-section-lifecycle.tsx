import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

type LeaveGuard = (continueLeaving: () => void) => void;
interface SectionLifecycle {
  guard: RefObject<LeaveGuard | null>;
  footerTarget: HTMLDivElement | null;
  setDirty: (dirty: boolean) => void;
  requestClose: () => void;
}
const SectionLifecycleContext = createContext<SectionLifecycle | null>(null);

/** One host per open settings modal; no section state is stored globally. */
export function SettingsSectionHost({ onClose, children }: {
  onClose: () => void;
  children: (controls: { footer: ReactNode; dirty: boolean; requestClose: () => void; requestLeave: LeaveGuard }) => ReactNode;
}) {
  const guard = useRef<LeaveGuard | null>(null);
  const [footerTarget, setFooterTarget] = useState<HTMLDivElement | null>(null);
  const [dirty, setDirty] = useState(false);
  const requestLeave = useCallback<LeaveGuard>((continueLeaving) => {
    if (guard.current) guard.current(continueLeaving);
    else continueLeaving();
  }, []);
  const requestClose = useCallback(() => requestLeave(onClose), [requestLeave, onClose]);
  const context = useMemo(() => ({ guard, footerTarget, setDirty, requestClose }), [footerTarget, requestClose]);
  return <SectionLifecycleContext.Provider value={context}>
    {children({ footer: <div ref={setFooterTarget} />, dirty, requestClose, requestLeave })}
  </SectionLifecycleContext.Provider>;
}

/** Portal the existing footer chrome outside the scrolling section, not a new footer dialect. */
export function SettingsSectionFooter({ children }: { children: ReactNode }) {
  const host = useContext(SectionLifecycleContext);
  return host?.footerTarget ? createPortal(children, host.footerTarget) : null;
}

export function useSettingsSectionLeaveGuard(guard: LeaveGuard) {
  const host = useContext(SectionLifecycleContext);
  useLayoutEffect(() => {
    if (!host) return;
    host.guard.current = guard;
    return () => { if (host.guard.current === guard) host.guard.current = null; };
  }, [host, guard]);
}

export function useSettingsSectionDirty(dirty: boolean) {
  const host = useContext(SectionLifecycleContext);
  const setDirty = host?.setDirty;
  useLayoutEffect(() => {
    setDirty?.(dirty);
    return () => setDirty?.(false);
  }, [setDirty, dirty]);
}

export function useSettingsSectionClose(): () => void {
  const host = useContext(SectionLifecycleContext);
  if (!host) throw new Error("Settings section actions require SettingsSectionHost");
  return host.requestClose;
}
