/**
 * ExperienceFrame — DOM + URL-lifecycle tests (IR-61).
 *
 * The live handshake/act round-trip is covered by the bridge integration test
 * (real MessagePort, no DOM). Here we pin what happy-dom CAN reliably assert:
 *   - the iframe sandbox attribute is `allow-scripts` and does NOT include
 *     `allow-same-origin` (the omission that forces the opaque origin);
 *   - the generated frame document carries the restrictive CSP
 *     (`connect-src 'none'`), the injected SDK, and the user visual source;
 *   - the blob URL is created on mount and revoked on unmount (no lingering
 *     reference to a stale frame document).
 *
 * URL.createObjectURL / revokeObjectURL are spied so we both observe the
 * lifecycle and can read back the exact document bytes handed to the frame.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import type { Window as HappyWindow } from "happy-dom";

import { createRef } from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import {
  ExperienceFrame,
  EXPERIENCE_FRAME_CSP,
  buildExperienceFrameDocument,
  type ExperienceFrameHandle,
} from "./ExperienceFrame.js";
import { VIBE_EXPERIENCE_SDK_SOURCE } from "../../lib/experience-sdk.js";
import {
  FRAME_MICRO_SCROLLBAR_SCRIPT,
  FRAME_SCROLLBAR_NEUTRAL_THUMB,
} from "./experience-frame-micro-scrollbar.js";

useDomEnv();

const { render, act, fireEvent } = await import("@testing-library/react");
const { waitFor } = await import("@testing-library/react");

const VISUAL = [
  "<div id=\"game\">hello</div>",
  "<script>VibeExperience.connect(function(v){document.getElementById('game').textContent=JSON.stringify(v);});</script>",
].join("\n");

// ─── spies ──────────────────────────────────────────────────────────────────

const createdBlobs: Blob[] = [];
const revokedUrls: string[] = [];
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
const browserSettings = (window as unknown as HappyWindow).happyDOM.settings;
const originalIframeLoading = browserSettings.enableIframePageLoading;
// CNR-8r: the phone-policy signal is the stylesheet-owned
// --vt-hide-content-scrollbars root custom property (set only inside the
// phone-policy media block in styles.css), driven in these tests through the
// same inline-style seam the old computed scrollbar-width pins used.
const HIDE_SIGNAL = "--vt-hide-content-scrollbars";

// These spies navigate ONLY to about:blank, never to the generated visual.
// Enable that supported local navigation instead of emitting a disabled-load
// error per mount; isolation/handshake behavior still belongs to live browsers.
beforeAll(() => { browserSettings.enableIframePageLoading = true; });
afterAll(() => {
  browserSettings.enableIframePageLoading = originalIframeLoading;
  document.documentElement.style.removeProperty(HIDE_SIGNAL);
  restoreUrl();
});

function installUrlSpies() {
  let n = 0;
  URL.createObjectURL = (blob: Blob) => {
    createdBlobs.push(blob);
    // Return `about:blank` so happy-dom does not attempt to navigate/fetch the
    // iframe (a real URL triggers BrowserFrameNavigator, whose async rejection
    // can interfere with passive-effect flush). The exact string is irrelevant
    // to these tests — only the blob lifecycle + document bytes are asserted.
    return `about:blank#blob-${n++}`;
  };
  URL.revokeObjectURL = (url: string) => {
    revokedUrls.push(url);
  };
}

function restoreUrl() {
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
}

afterEach(() => {
  createdBlobs.length = 0;
  revokedUrls.length = 0;
  restoreUrl();
  document.documentElement.style.removeProperty(HIDE_SIGNAL);
});

// ─── buildExperienceFrameDocument (pure) ────────────────────────────────────

describe("buildExperienceFrameDocument", () => {
  it("includes the restrictive CSP meta", () => {
    const doc = buildExperienceFrameDocument(VISUAL);
    expect(doc).toContain(`http-equiv="Content-Security-Policy"`);
    expect(doc).toContain(EXPERIENCE_FRAME_CSP);
    // network is explicitly closed
    expect(EXPERIENCE_FRAME_CSP).toContain("connect-src 'none'");
    expect(EXPERIENCE_FRAME_CSP).toContain("default-src 'none'");
  });

  it("injects the immutable VibeExperience SDK before the visual source", () => {
    const doc = buildExperienceFrameDocument(VISUAL);
    expect(doc).toContain(VIBE_EXPERIENCE_SDK_SOURCE);
    expect(doc).toContain(VISUAL);
    expect(doc.indexOf(VIBE_EXPERIENCE_SDK_SOURCE)).toBeLessThan(doc.indexOf(VISUAL));
  });

  it("runs under allow-scripts only (no allow-same-origin in the CSP)", () => {
    // The sandbox attribute is on the <iframe>, not the doc; here we only assert
    // the doc itself does not relax isolation. The attribute is asserted below.
    expect(EXPERIENCE_FRAME_CSP).not.toContain("allow-same-origin");
  });

  it("bakes the host scrollbar color into the thumb token (theme-aware)", () => {
    // The frame is opaque-origin, so it cannot inherit the host's scrollbar
    // CSS or --border2 token; the in-frame micro-scrollbar reads its thumb
    // color from the token baked into the base style.
    const doc = buildExperienceFrameDocument(VISUAL, "oklch(0.4 0.02 290)");
    expect(doc).toContain(":root{--vt-sb-thumb:oklch(0.4 0.02 290)}");
  });

  it("falls back to a neutral scrollbar when no theme color is provided", () => {
    const doc = buildExperienceFrameDocument(VISUAL);
    expect(doc).toContain(`:root{--vt-sb-thumb:${FRAME_SCROLLBAR_NEUTRAL_THUMB}}`);
  });

  it("frames drop the baked native fallback; the HOST is custom-chrome-only and its stylesheet owns the phone-policy signal", async () => {
    const host = await Bun.file(`${import.meta.dir}/../../styles.css`).text();
    const turn = buildExperienceFrameDocument(VISUAL, "var(--test-thumb)");
    const realtime = buildRealtimeExperienceFrameDocument(VISUAL, "", {
      rulesSource: "", seed: 1, tickMs: 33, initialState: {}, initialSettings: {},
      participants: [], scriptSeats: [], viewer: { kind: "human", participantId: "p1" },
    }, "var(--test-thumb)");
    // CNR-8r end state: the host's global native fallback (8px WebKit geometry
    // + the Firefox-thin @supports rule) is REMOVED — every desktop-visible
    // scrollbar is the shared custom lane system. The only surviving
    // ::-webkit-scrollbar rules are sanctioned DISPLAY-NONE hiding (the
    // .scrollbar-hide utility and the phone-policy block), and no standard
    // scrollbar-width:thin / scrollbar-color remains anywhere in the host.
    expect(host).not.toContain("::-webkit-scrollbar{width:8px");
    expect(host).not.toContain("@supports (-moz-appearance:none)");
    expect(host).not.toContain("scrollbar-width:thin");
    expect(host).not.toContain("scrollbar-color:");
    expect(host).toContain(".scrollbar-hide");
    for (const rule of host.match(/[^{}]*::-webkit-scrollbar[^{}]*\{[^}]*\}/g) ?? []) {
      expect(rule).toContain("display: none");
    }
    // The phone-policy block (7g hiding itself is NOT this unit's scope) now
    // owns the signal state: --vt-hide-content-scrollbars is set ONLY inside
    // that exact media policy, so the property and the hiding rule stay in
    // lockstep by construction (exactly one occurrence, none outside).
    const phonePolicy = "@media (max-width: 768px), (hover: none) and (pointer: coarse)";
    const blockStart = host.indexOf(phonePolicy);
    expect(blockStart).toBeGreaterThan(-1);
    let depth = 0;
    let blockEnd = -1;
    for (let i = host.indexOf("{", blockStart); i < host.length; i++) {
      if (host[i] === "{") depth++;
      else if (host[i] === "}") {
        depth--;
        if (depth === 0) {
          blockEnd = i + 1;
          break;
        }
      }
    }
    expect(blockEnd).toBeGreaterThan(blockStart);
    const phoneBlock = host.slice(blockStart, blockEnd);
    expect(phoneBlock).toContain("--vt-hide-content-scrollbars: 1;");
    expect(phoneBlock).toContain(":where(:not(textarea)) { scrollbar-width: none; }");
    const outsideBlock = host.slice(0, blockStart) + host.slice(blockEnd);
    expect(outsideBlock).not.toContain("--vt-hide-content-scrollbars");
    expect(host.split("--vt-hide-content-scrollbars").length - 1).toBe(1);
    // CNR-8q scope keeps holding: the custom overlay script replaces the
    // baked native chrome inside BOTH frame documents (its own CSS hides
    // native chrome).
    for (const doc of [turn, realtime]) {
      expect(doc).not.toContain("::-webkit-scrollbar{width:8px");
      expect(doc).not.toContain("border-radius:4px");
      expect(doc).not.toContain("@supports (-moz-appearance:none)");
      expect(doc).not.toContain("scrollbar-width:thin");
    }
    const baseStyle = (doc: string) => doc.slice(doc.indexOf("<style>"), doc.indexOf("</style>"));
    expect(baseStyle(turn)).toBe(baseStyle(realtime));
  });
});

// ─── inline script embedding (the RM-12 live-render regression) ─────────────
// A literal `</script` inside an embedded JS source closes the host tag early
// and dumps the rest of the bundle into the frame as visible text — exactly
// what the first live Try-it render showed (builtin visual sources had leaked
// into the runtime bundle via the domain barrel). These pins hold the boundary
// at the ASSEMBLED document, which no mock-level test ever covered.
describe("inline script embedding", () => {
  it("the REAL generated runtime bundle contains no script-tag-breaking sequence", async () => {
    const { EXPERIENCE_FRAME_RUNTIME_SOURCE } = await import(
      "../../generated/experience-frame-runtime.source.js",
    );
    // Purity: builtin sources (fat HTML blobs) must stay out of the frame graph
    // — the domain barrel no longer re-exports them (see domain/src/index.ts).
    expect(EXPERIENCE_FRAME_RUNTIME_SOURCE).not.toContain("model_conversation");
    expect(EXPERIENCE_FRAME_RUNTIME_SOURCE).not.toContain("xp-conv");
    expect(EXPERIENCE_FRAME_RUNTIME_SOURCE).not.toContain("breakout_arcade");
    expect(EXPERIENCE_FRAME_RUNTIME_SOURCE).not.toContain("xp-brk");
    // Safety: even a hostile literal `</script` carried inside the runtime
    // source must not break the assembled document's script block.
    const hostile = 'var x = "</script>"; console.log(x);';
    const doc = buildRealtimeExperienceFrameDocument(
      "<div>visual</div>",
      hostile + "\n" + EXPERIENCE_FRAME_RUNTIME_SOURCE,
      {
        rulesSource: "context.experience.register({});",
        seed: 42,
        tickMs: 33,
        initialState: {},
        initialSettings: {},
        participants: [{ id: "p1", label: "P", controller: "human" }],
        scriptSeats: [],
        viewer: { kind: "human", participantId: "p1" },
      },
    );
    // Extract the runtime script block: from the marker comment's following
    // <script> to the config tag, strip the block's own closing tag, and the
    // remainder must carry no raw `</script` (only the escaped `<\/script`).
    const marker = doc.indexOf("realtime frame runtime");
    const open = doc.indexOf("<script>", marker);
    const close = doc.indexOf("</script>", open);
    const embedded = doc.slice(open + 8, close);
    expect(embedded).not.toContain("</script");
    expect(embedded).toContain("<\\/script>");
  });
});

// ─── ExperienceFrame component (DOM + URL lifecycle) ────────────────────────

describe("ExperienceFrame", () => {
  it("renders an iframe sandboxed with allow-scripts and WITHOUT allow-same-origin", () => {
    installUrlSpies();
    const { container } = render(
      <ExperienceFrame
        visualSource={VISUAL}
        sessionId="sess_1"
        initialRevision={0}
        onAction={() => {}}
      />,
    );
    const iframe = container.querySelector("iframe")!;
    expect(iframe).not.toBeNull();
    const sandbox = iframe.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("creates a blob URL on mount and revokes it on unmount", () => {
    installUrlSpies();
    const { unmount } = render(
      <ExperienceFrame
        visualSource={VISUAL}
        sessionId="sess_1"
        initialRevision={0}
        onAction={() => {}}
      />,
    );
    expect(createdBlobs.length).toBe(1);
    expect(revokedUrls.length).toBe(0);
    unmount();
    expect(revokedUrls.length).toBe(1);
  });

  it("revokes the previous blob URL when the visual source changes", () => {
    installUrlSpies();
    const { rerender } = render(
      <ExperienceFrame
        visualSource={VISUAL}
        sessionId="sess_1"
        initialRevision={0}
        onAction={() => {}}
      />,
    );
    expect(createdBlobs.length).toBe(1);
    rerender(
      <ExperienceFrame
        visualSource="<div>new source</div>"
        sessionId="sess_1"
        initialRevision={0}
        onAction={() => {}}
      />,
    );
    // first URL revoked; a second blob created for the new source
    expect(revokedUrls.length).toBe(1);
    expect(createdBlobs.length).toBe(2);
  });

  it("hands the frame document (CSP + SDK + visual source) to createObjectURL", async () => {
    installUrlSpies();
    render(
      <ExperienceFrame
        visualSource={VISUAL}
        sessionId="sess_1"
        initialRevision={0}
        onAction={() => {}}
      />,
    );
    const doc = await createdBlobs[0]!.text();
    expect(doc).toContain(EXPERIENCE_FRAME_CSP);
    expect(doc).toContain(VIBE_EXPERIENCE_SDK_SOURCE);
    expect(doc).toContain(VISUAL);
  });

  it("exposes the imperative push surface through the ref", async () => {
    installUrlSpies();
    const ref = createRef<ExperienceFrameHandle>();
    await act(async () => {
      render(
        <ExperienceFrame
          ref={ref}
          visualSource={VISUAL}
          sessionId="sess_1"
          initialRevision={0}
          onAction={() => {}}
        />,
      );
    });
    const handle = ref.current;
    // The handle is wired (methods exist). isReady is false until a real
    // handshake, which happy-dom's iframe cannot drive — covered by the bridge
    // integration test. We assert the surface shape here.
    expect(handle).not.toBeNull();
    expect(typeof handle!.sendState).toBe("function");
    expect(typeof handle!.sendResult).toBe("function");
    expect(typeof handle!.sendError).toBe("function");
    expect(typeof handle!.sendPending).toBe("function");
    expect(typeof handle!.sendLifecycle).toBe("function");
    expect(handle!.isReady).toBe(false);
    // The bridge is created (nonce generated in its constructor) but not yet
    // attached to a frame port (no iframe load in happy-dom) — so isReady is
    // false but the session nonce is already a valid 32-hex identity token.
    expect(handle!.sessionNonce).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("ExperienceFrame — session-scoped bridge lifetime (IR-73B seam #4)", () => {
  it("does NOT recreate/strand the bridge when only initialRevision changes", async () => {
    installUrlSpies();
    const ref = createRef<ExperienceFrameHandle>();
    const { rerender } = render(
      <ExperienceFrame
        ref={ref}
        visualSource={VISUAL}
        sessionId="sess_1"
        initialRevision={3}
        onAction={() => {}}
      />,
    );
    const nonceBefore = ref.current!.sessionNonce;
    // A revision prop update for the SAME session must NOT dispose/recreate
    // the bridge — later authoritative revisions arrive through sendState, not
    // bridge reconstruction. The session nonce stays identical.
    await act(async () => {
      rerender(
        <ExperienceFrame
          ref={ref}
          visualSource={VISUAL}
          sessionId="sess_1"
          initialRevision={42}
          onAction={() => {}}
        />,
      );
    });
    expect(ref.current).not.toBeNull();
    expect(ref.current!.sessionNonce).toBe(nonceBefore);
  });

  it("recreates the bridge (new nonce) when the sessionId changes", async () => {
    installUrlSpies();
    const ref = createRef<ExperienceFrameHandle>();
    const { rerender } = render(
      <ExperienceFrame
        ref={ref}
        visualSource={VISUAL}
        sessionId="sess_a"
        initialRevision={0}
        onAction={() => {}}
      />,
    );
    const nonceA = ref.current!.sessionNonce;
    await act(async () => {
      rerender(
        <ExperienceFrame
          ref={ref}
          visualSource={VISUAL}
          sessionId="sess_b"
          initialRevision={0}
          onAction={() => {}}
        />,
      );
    });
    const nonceB = ref.current!.sessionNonce;
    // A genuine session id change creates a fresh handshake → new nonce.
    expect(nonceA).not.toBe(nonceB);
    expect(nonceA).toMatch(/^[0-9a-f]{32}$/);
    expect(nonceB).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ─── realtime frame document (RM-4) ─────────────────────────────────────────

import {
  buildRealtimeExperienceFrameDocument,
  EXPERIENCE_FRAME_REALTIME_CSP,
} from "./ExperienceFrame.js";
import type { ExperienceLoopConfig } from "../../lib/experience-loop-host.js";


const RUNTIME_STUB = "/*__RUNTIME_STUB__*/ var __vtFrameRuntime = 1;";

const REALTIME_CONFIG: ExperienceLoopConfig = {
  rulesSource: 'context.experience.register({ apiVersion: 1 });',
  tickMs: 100,
  initialState: { remaining: 1000 },
  seed: 42,
  viewer: { kind: "human", participantId: "p1" },
  scriptSeats: [],
};

describe("ExperienceFrame — host scrollbar visibility", () => {
  for (const mode of ["turn", "realtime"] as const) {
    const build = (hidden: boolean) => mode === "turn"
      ? buildExperienceFrameDocument(VISUAL, undefined, hidden)
      : buildRealtimeExperienceFrameDocument(VISUAL, RUNTIME_STUB, REALTIME_CONFIG, undefined, hidden);

    it(`${mode}: initializes the host policy and validates layout messages independently of the SDK`, () => {
      const mobile = build(true);
      expect(mobile).toContain('<html data-vt-hide-content-scrollbars>');
      expect(build(false)).toContain('<html>');
      expect(mobile).toContain(':not(textarea)');
      expect(mobile).toContain('scrollbar-width:none');
      // scrollbar-width is INHERITED: the :not(textarea) exemption stops the
      // rule from matching the textarea but does not reset the value it
      // inherits from its parent — without this explicit reset Firefox phones
      // lose the textarea's native scrollbar (CNR-8q/8r browser batch).
      expect(mobile).toContain(
        'html[data-vt-hide-content-scrollbars] textarea{scrollbar-width:auto}',
      );
      expect(mobile).not.toContain('max-width: 768px');
      const tag = '<script id="__vt_scrollbar_policy">';
      const start = mobile.indexOf(tag);
      expect(start).toBeGreaterThan(0);
      const script = mobile.slice(start + tag.length, mobile.indexOf('</script>', start));
      const root = document.createElement('html');
      const parent = {};
      const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
      const frameWindow = { parent, addEventListener: (type: string, listener: typeof listeners[number]) => {
        expect(type).toBe('message');
        listeners.push(listener);
      } };
      new Function('window', 'document', script)(frameWindow, { documentElement: root });
      expect(listeners.length).toBe(1);
      const send = (source: unknown, data: unknown) => listeners[0]!({ source, data });
      const valid = { type: 'vt:scrollbar-visibility', hidden: true };
      for (const source of [null, {}, frameWindow]) {
        send(source, valid);
        expect(root.hasAttribute('data-vt-hide-content-scrollbars')).toBe(false);
      }
      for (const data of [null, [], 'mobile', {}, { ...valid, type: 'hello' }, { ...valid, hidden: 'true' }, { ...valid, hidden: 1 }]) {
        send(parent, data);
        expect(root.hasAttribute('data-vt-hide-content-scrollbars')).toBe(false);
      }
      send(parent, valid);
      expect(root.hasAttribute('data-vt-hide-content-scrollbars')).toBe(true);
      send(parent, { ...valid, hidden: false });
      expect(root.hasAttribute('data-vt-hide-content-scrollbars')).toBe(false);
    });

    it(`${mode}: sends current stylesheet signal state on load/resize without replacing the document or session`, async () => {
      installUrlSpies();
      document.documentElement.style.setProperty(HIDE_SIGNAL, "1");
      const ref = createRef<ExperienceFrameHandle>();
      const { container, unmount } = render(<ExperienceFrame
        ref={ref} visualSource={VISUAL} sessionId="visibility-session" initialRevision={4}
        onAction={() => {}} realtime={mode === 'realtime' ? { config: REALTIME_CONFIG } : undefined}
      />);
      await waitFor(() => expect(createdBlobs.length).toBe(1));
      expect(await createdBlobs[0]!.text()).toContain('<html data-vt-hide-content-scrollbars>');
      const iframe = container.querySelector('iframe')!;
      const url = iframe.src;
      const nonce = ref.current!.sessionNonce;
      const messages: unknown[] = [];
      // Element-local window boundary, leaving the real session bridge intact.
      Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: {
        postMessage: (data: unknown) => messages.push(data),
      } });
      document.documentElement.style.removeProperty(HIDE_SIGNAL);
      fireEvent.load(iframe);
      expect(messages).toContainEqual({ type: 'vt:scrollbar-visibility', hidden: false });
      document.documentElement.style.setProperty(HIDE_SIGNAL, "1");
      fireEvent(window, new Event('resize'));
      expect(messages.at(-1)).toEqual({ type: 'vt:scrollbar-visibility', hidden: true });
      document.documentElement.style.removeProperty(HIDE_SIGNAL);
      fireEvent(window, new Event('resize'));
      expect(messages.at(-1)).toEqual({ type: 'vt:scrollbar-visibility', hidden: false });
      expect(iframe.src).toBe(url);
      expect(container.querySelector('iframe')).toBe(iframe);
      expect(ref.current!.sessionNonce).toBe(nonce);
      expect(createdBlobs.length).toBe(1);
      expect(revokedUrls.length).toBe(0);
      unmount();
      const count = messages.length;
      fireEvent(window, new Event('resize'));
      expect(messages.length).toBe(count);
      expect(revokedUrls.length).toBe(1);
    });
  }
});

// ─── in-frame micro-scrollbar chrome (CNR-8q) ───────────────────────────────
// Probe D (CNR-8a): host CSS cannot cross the opaque-origin boundary, so the
// only DOM-custom mechanism for the frames is a vanilla script shipped through
// the document builders. These pins hold the BAKED DOCUMENT boundary — script
// presence, the removed native fallback, the CNR-7h interplay and the
// untouched gameplay surface. Rendered geometry is the browser harness's job;
// happy-dom cannot prove it and must not fake it.
describe("ExperienceFrame — in-frame micro-scrollbar chrome (CNR-8q)", () => {
  const buildBoth = () => ({
    turn: buildExperienceFrameDocument(VISUAL, "oklch(0.4 0.02 290)"),
    realtime: buildRealtimeExperienceFrameDocument(VISUAL, RUNTIME_STUB, REALTIME_CONFIG, "oklch(0.4 0.02 290)"),
  });

  it("ships the vanilla micro-scrollbar script in BOTH documents, after the CNR-7h policy script", () => {
    const { turn, realtime } = buildBoth();
    for (const doc of [turn, realtime]) {
      const tag = '<script id="__vt_micro_scrollbar">';
      expect(doc).toContain(tag);
      expect(doc).toContain(FRAME_MICRO_SCROLLBAR_SCRIPT);
      // The layout policy stays FIRST: the micro-scrollbar CSS is keyed on
      // the very attribute that receiver toggles.
      expect(doc.indexOf(tag)).toBeGreaterThan(doc.indexOf('<script id="__vt_scrollbar_policy">'));
    }
    // The static script must never terminate its own host tag.
    expect(FRAME_MICRO_SCROLLBAR_SCRIPT).not.toContain("</script");
  });

  it("the script self-installs its own CSS and defers DOM wiring to DOMContentLoaded", () => {
    // Element-local double (the CNR-7h receiver-test pattern): no real DOM,
    // no globals — only the synchronous install path runs.
    const styleEl = { id: "", textContent: "" };
    const appended: unknown[] = [];
    const listenerTypes: string[] = [];
    const documentDouble = {
      readyState: "loading",
      createElement: () => styleEl,
      head: { appendChild: (el: unknown) => { appended.push(el); } },
      addEventListener: (type: string) => { listenerTypes.push(type); },
    };
    expect(() =>
      new Function("window", "document", FRAME_MICRO_SCROLLBAR_SCRIPT)({}, documentDouble),
    ).not.toThrow();
    expect(appended).toEqual([styleEl]);
    expect(styleEl.id).toBe("__vt_micro_scrollbar_style");
    expect(listenerTypes).toEqual(["DOMContentLoaded"]);
    const css = styleEl.textContent;
    // Native chrome hidden on desktop only (scoped to the phone attribute) —
    // so textareas fall back to native chrome exactly when lanes hide.
    expect(css).toContain("html:not([data-vt-hide-content-scrollbars])");
    // Phone policy: every custom track hides with the layer.
    expect(css).toContain("html[data-vt-hide-content-scrollbars] .vt-sb-layer{display:none}");
    // 3px resting thumb on both axes, 5px expansion over the lane.
    expect(css).toContain("width:3px");
    expect(css).toContain("height:3px");
    expect(css).toContain("width:5px");
    expect(css).toContain("height:5px");
    // Reduced-motion override must match the axis rules' specificity
    // (.vt-sb-lane[data-axis] > thumb) — a bare .vt-sb-lane>.vt-sb-thumb
    // selector loses to the 120ms transition rules and reduce never applies
    // (found in the CNR-8q/8r browser batch — same bug as the host lane CSS).
    expect(css).toContain(
      '@media (prefers-reduced-motion:reduce){.vt-sb-lane[data-axis]>.vt-sb-thumb{transition:none}}',
    );
    // Hover expansion gated to real pointers; no sticky 5px thumb after a tap.
    expect(css).toContain("@media (hover:hover)");
    // The drag latch holds the expanded thumb through the drag.
    expect(css).toContain("[data-dragging]");
    // Correct states reachable without animation.
    expect(css).toContain("@media (prefers-reduced-motion:reduce)");
    // Themed via the baked token with the neutral fallback.
    expect(css).toContain(`var(--vt-sb-thumb,${FRAME_SCROLLBAR_NEUTRAL_THUMB})`);
  });

  it("keeps the CNR-7h phone exemption verbatim (native textareas keep their chrome)", () => {
    const { turn } = buildBoth();
    expect(turn).toContain(
      "html[data-vt-hide-content-scrollbars],html[data-vt-hide-content-scrollbars] :not(textarea){scrollbar-width:none!important}",
    );
    expect(turn).toContain(
      "html[data-vt-hide-content-scrollbars]::-webkit-scrollbar,html[data-vt-hide-content-scrollbars] :not(textarea)::-webkit-scrollbar{display:none!important}",
    );
  });

  it("leaves the gameplay boundary untouched: same CSP, pure vanilla script", () => {
    const { turn, realtime } = buildBoth();
    expect(turn).toContain(`<meta http-equiv="Content-Security-Policy" content="${EXPERIENCE_FRAME_CSP}">`);
    expect(realtime).toContain(`<meta http-equiv="Content-Security-Policy" content="${EXPERIENCE_FRAME_REALTIME_CSP}">`);
    expect(EXPERIENCE_FRAME_CSP).toContain("connect-src 'none'");
    // Opaque-origin constraints: no network, no module system, no host refs.
    // (Word-boundary: CSS !important is not a module system.)
    expect(FRAME_MICRO_SCROLLBAR_SCRIPT).not.toMatch(/\bimport\b/);
    expect(FRAME_MICRO_SCROLLBAR_SCRIPT).not.toMatch(/\bfetch\b/);
    expect(FRAME_MICRO_SCROLLBAR_SCRIPT).not.toContain("http://");
    expect(FRAME_MICRO_SCROLLBAR_SCRIPT).not.toContain("https://");
  });
});

function roundtripDocConfig(doc: string): unknown {
  const open = '<script type="application/json" id="__vt_round_config">';
  const start = doc.indexOf(open);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = doc.indexOf("</script>", start);
  expect(end).toBeGreaterThan(start);
  return JSON.parse(doc.slice(start + open.length, end));
}

describe("buildRealtimeExperienceFrameDocument", () => {
  it("embeds runtime + config + boot, in order, under the realtime CSP", () => {
    const doc = buildRealtimeExperienceFrameDocument(VISUAL, RUNTIME_STUB, REALTIME_CONFIG);
    expect(doc).toContain(EXPERIENCE_FRAME_REALTIME_CSP);
    expect(EXPERIENCE_FRAME_REALTIME_CSP).toContain("'unsafe-eval'");
    expect(EXPERIENCE_FRAME_REALTIME_CSP).toContain("connect-src 'none'");
    expect(doc).toContain(VIBE_EXPERIENCE_SDK_SOURCE);
    expect(doc).toContain(RUNTIME_STUB);
    // SDK → runtime → visual → boot (the boot line must come LAST so a visual
    // that registers listeners at load sees every loop event).
    expect(doc.indexOf(VIBE_EXPERIENCE_SDK_SOURCE)).toBeLessThan(doc.indexOf(RUNTIME_STUB));
    expect(doc.indexOf(RUNTIME_STUB)).toBeLessThan(doc.indexOf(VISUAL));
    expect(doc.indexOf(VISUAL)).toBeLessThan(doc.lastIndexOf("bootFromDocument"));
    expect(doc).toContain("globalThis.__vtFrameRuntime.bootFromDocument();");
  });

  it("round-trips the config JSON through the tag byte-safely", () => {
    const hostile: ExperienceLoopConfig = {
      ...REALTIME_CONFIG,
      rulesSource: '</script><script>alert(1)</script>',
    };
    const doc = buildRealtimeExperienceFrameDocument(VISUAL, RUNTIME_STUB, hostile);
    // The config JSON must not contain a raw `</script>` (it would terminate
    // the tag early and inject markup into the frame document).
    const parsed = roundtripDocConfig(doc) as { rulesSource: string };
    expect(parsed.rulesSource).toBe(hostile.rulesSource);
  });

  it("leaves the TURN document untouched: no runtime, no realtime CSP", () => {
    const doc = buildExperienceFrameDocument(VISUAL);
    expect(doc).not.toContain("__vt_round_config");
    expect(doc).not.toContain("bootFromDocument");
    expect(doc).not.toContain("'unsafe-eval'");
    expect(doc).toContain(EXPERIENCE_FRAME_CSP);
  });
});

describe("ExperienceFrame (realtime path)", () => {
  it("builds a realtime blob document when realtime config is present", async () => {
    installUrlSpies();
    await act(async () => {
      render(
        <ExperienceFrame
          visualSource={VISUAL}
          sessionId="sess_rt"
          initialRevision={0}
          onAction={() => {}}
          realtime={{ config: REALTIME_CONFIG }}
        />,
      );
    });
    // The artifact loads lazily — the blob appears once it resolves.
    await waitFor(() => {
      expect(createdBlobs.length).toBe(1);
    });
    const blob = createdBlobs[0]!;
    const doc = await blob.text();
    expect(doc).toContain("__vt_round_config");
    expect(doc).toContain("bootFromDocument");
    expect(doc).toContain(EXPERIENCE_FRAME_REALTIME_CSP);
    expect(doc).toContain(VISUAL);
    const parsed = roundtripDocConfig(doc) as { seed: number; tickMs: number };
    expect(parsed.seed).toBe(42);
    expect(parsed.tickMs).toBe(100);
  });

  it("never loads the runtime artifact on the turn-based path", async () => {
    installUrlSpies();
    await act(async () => {
      render(
        <ExperienceFrame
          visualSource={VISUAL}
          sessionId="sess_turn"
          initialRevision={0}
          onAction={() => {}}
        />,
      );
    });
    expect(createdBlobs.length).toBe(1);
    const doc = await createdBlobs[0]!.text();
    expect(doc).not.toContain("__vt_round_config");
    expect(doc).not.toContain("unsafe-eval");
  });
});

describe("ExperienceFrame — realtime handle ripple (RM-6)", () => {
  it("the ref handle exposes a callable sendModelResult that is a safe no-op before the bridge attaches", () => {
    installUrlSpies();
    const ref = createRef<ExperienceFrameHandle>();
    render(
      <ExperienceFrame
        ref={ref}
        visualSource={VISUAL}
        sessionId="sess_rt_handle"
        initialRevision={0}
        onAction={() => {}}
      />,
    );
    // The bridge exists post-mount but has no port yet — sending must not
    // throw (the bridge reports via onProtocolError, covered by bridge tests).
    expect(() => ref.current!.sendModelResult("m1", { type: "speak" }, "rq-1")).not.toThrow();
  });
});
