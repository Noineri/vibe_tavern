import { createPortal } from "react-dom";
import { Toaster } from "sonner";
import { useIsMobile } from "../../hooks/use-mobile.js";

/**
 * The app's single sonner toaster mount (AppShell renders exactly this).
 *
 * Portaled to <body> on purpose: #root carries `position:relative;z-index:1`
 * (styles.css — it must paint above the lava canvas portaled to <body> at
 * z-index:0), which makes #root a STACKING CONTEXT. A toaster mounted inside
 * it is trapped at #root's z≈1 while every modal overlay portals to <body>
 * (Modal z-[500]/[501], MediaModal z-[700]) — so in-modal error toasts
 * painted UNDER the modal scrim (owner report: «тост под затемнением
 * модалки»). At body level sonner's own z-index:999999999 applies in the
 * root stacking context, above every app overlay — restoring what the
 * styles.css comment already assumed ("portaled modals/toasts (body
 * children) still stack above both"). Position, animation, and glass
 * theming are unchanged; AppToaster.test.tsx pins the boundary.
 */
export function AppToaster() {
  const isMobile = useIsMobile();
  return createPortal(
    <Toaster
      position={isMobile ? "top-center" : "bottom-right"}
      toastOptions={{
        // glass-blur is a no-op in opaque themes (--glass-blur: 0) and frosts
        // the lava blobs behind the toast in glass themes. --glass-bg is the
        // translucent tint tuned to survive the blur (vs --s2, which reads
        // muddy when blurred).
        className: "glass-blur",
        style: { background: "var(--glass-bg)", color: "var(--t1)", border: "1px solid var(--border)" },
      }}
    />,
    document.body,
  );
}
