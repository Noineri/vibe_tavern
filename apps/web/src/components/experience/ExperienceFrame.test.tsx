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
import { describe, it, expect, afterEach } from "bun:test";
import { render, act } from "@testing-library/react";
import { createRef } from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import {
  ExperienceFrame,
  EXPERIENCE_FRAME_CSP,
  buildExperienceFrameDocument,
  type ExperienceFrameHandle,
} from "./ExperienceFrame.js";
import { VIBE_EXPERIENCE_SDK_SOURCE } from "../../lib/experience-sdk.js";

useDomEnv();

const VISUAL = [
  "<div id=\"game\">hello</div>",
  "<script>VibeExperience.connect(function(v){document.getElementById('game').textContent=JSON.stringify(v);});</script>",
].join("\n");

// ─── spies ──────────────────────────────────────────────────────────────────

const createdBlobs: Blob[] = [];
const revokedUrls: string[] = [];
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

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

  it("bakes the host scrollbar color into the base style (theme-aware)", () => {
    // The frame is opaque-origin, so it cannot inherit the host's ::-webkit-scrollbar
    // rule or --border2 token; the color must be baked into the srcdoc.
    const doc = buildExperienceFrameDocument(VISUAL, "oklch(0.4 0.02 290)");
    expect(doc).toContain("::-webkit-scrollbar");
    expect(doc).toContain("scrollbar-width:thin");
    expect(doc).toContain("oklch(0.4 0.02 290)");
  });

  it("falls back to a neutral scrollbar when no theme color is provided", () => {
    const doc = buildExperienceFrameDocument(VISUAL);
    expect(doc).toContain("::-webkit-scrollbar");
    expect(doc).toContain("rgba(140,140,140,0.5)");
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
    expect(EXPERIENCE_FRAME_RUNTIME_SOURCE).not.toContain("catch_arcade");
    expect(EXPERIENCE_FRAME_RUNTIME_SOURCE).not.toContain("xp-catch");
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
import { waitFor } from "@testing-library/react";

const RUNTIME_STUB = "/*__RUNTIME_STUB__*/ var __vtFrameRuntime = 1;";

const REALTIME_CONFIG: ExperienceLoopConfig = {
  rulesSource: 'context.experience.register({ apiVersion: 1 });',
  tickMs: 100,
  initialState: { remaining: 1000 },
  seed: 42,
  viewer: { kind: "human", participantId: "p1" },
  scriptSeats: [],
};

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
