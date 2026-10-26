/**
 * AgentPendingStrip (AP-16) — the pending-changes strip above the composers
 * reads the ONE plain pending-review store AP-15 built: one chip per buffer
 * (the store's labelKeys rendered through the strip's display-key mapping),
 * «Открыть» calling the published `open`, «Принять всё» calling the
 * published `acceptAll` (hunks only — no save behavior asserted here because
 * none exists: the callables are invoked verbatim). Hidden with an empty
 * store and for the sidechat kind.
 *
 * The isolated i18n echoes keys (the AgentChatPane.test.tsx pattern), so the
 * label mapping asserts as keys: the visual chip reads
 * `agent_pending_appearance`, never the store's `agent_visual`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { useDomEnv } from "../../../../test/dom-env.js";
import { SIDECHAT_AGENT_KIND } from "../../../api/agent-kind-served-modes.js";
import { useAgentPendingReviewStore } from "../../../stores/agent-pending-review-store.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let AgentPendingStrip: typeof import("./AgentPendingStrip.js").AgentPendingStrip;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ AgentPendingStrip } = await import("./AgentPendingStrip.js"));
});

const THREAD = "thread-strip-1";

function makeIsolatedI18n() {
  const instance = createInstance();
  void instance.init({
    lng: "en",
    fallbackLng: "en",
    resources: {},
    ns: ["translation"],
    defaultNS: "translation",
    keySeparator: false,
    nsSeparator: false,
    interpolation: { prefix: "{", suffix: "}", escapeValue: false },
  });
  return instance;
}

function renderStrip(over: { kind?: string; threadId?: string } = {}) {
  return render(
    <I18nextProvider i18n={makeIsolatedI18n()}>
      <AgentPendingStrip kind={over.kind ?? "experience"} threadId={over.threadId ?? THREAD} />
    </I18nextProvider>,
  );
}

function seedExperience(over: { acceptAll?: () => void; open?: () => void } = {}) {
  const acceptAll = over.acceptAll ?? mock();
  const open = over.open ?? mock();
  useAgentPendingReviewStore.getState().publish("experience", THREAD, {
    buffers: [
      { labelKey: "agent_rules", pending: 3 },
      { labelKey: "agent_visual", pending: 5 },
    ],
    acceptAll,
    open,
  });
  return { acceptAll, open };
}

beforeEach(() => useAgentPendingReviewStore.setState({ summariesByThread: {} }));
afterAll(() => useAgentPendingReviewStore.setState({ summariesByThread: {} }));

describe("AgentPendingStrip — chips from the seeded store (AP-16)", () => {
  it("renders one chip per buffer with the mapped label and its count", () => {
    seedExperience();
    const { getByTestId } = renderStrip();

    expect(getByTestId("copilot-pending-changes-strip")).toBeDefined();
    expect(getByTestId("copilot-pending-chip-agent_rules").textContent).toBe("agent_pending_rules · 3");
    expect(getByTestId("copilot-pending-chip-agent_visual").textContent).toBe("agent_pending_appearance · 5");
  });

  it("the label mapping: the visual buffer renders the mockup's key, never the store's key", () => {
    seedExperience();
    const { getByTestId } = renderStrip();

    // The store carries `agent_visual` («Визуал»); the plan row owns the
    // strip copy («Внешний вид») — the chip must not echo the store key.
    expect(getByTestId("copilot-pending-chip-agent_visual").textContent).not.toContain("agent_visual");
    expect(getByTestId("copilot-pending-chip-agent_rules").textContent).not.toContain("agent_rules ");
  });

  it("the script kind renders its single code buffer through the same mapping", () => {
    useAgentPendingReviewStore.getState().publish("script", THREAD, {
      buffers: [{ labelKey: "script_code_label", pending: 2 }],
      acceptAll: mock(),
      open: mock(),
    });
    const { getByTestId } = renderStrip({ kind: "script" });

    expect(getByTestId("copilot-pending-changes-strip")).toBeDefined();
    expect(getByTestId("copilot-pending-chip-script_code_label").textContent).toBe("agent_pending_code · 2");
  });

  it("hidden with an empty store (nothing pending for this thread)", () => {
    const { queryByTestId } = renderStrip();

    expect(queryByTestId("copilot-pending-changes-strip")).toBeNull();
  });

  it("hidden for another thread's entry (per-thread isolation)", () => {
    seedExperience();
    const { queryByTestId } = renderStrip({ threadId: "thread-other" });

    expect(queryByTestId("copilot-pending-changes-strip")).toBeNull();
  });

  it("hidden for the sidechat kind even with a published entry", () => {
    useAgentPendingReviewStore.getState().publish(SIDECHAT_AGENT_KIND, THREAD, {
      buffers: [{ labelKey: "agent_rules", pending: 1 }],
      acceptAll: mock(),
      open: mock(),
    });
    const { queryByTestId } = renderStrip({ kind: SIDECHAT_AGENT_KIND });

    expect(queryByTestId("copilot-pending-changes-strip")).toBeNull();
  });
});

describe("AgentPendingStrip — actions call the published callables verbatim (AP-16)", () => {
  it("«Открыть» calls open and nothing else", () => {
    const { acceptAll, open } = seedExperience();
    const { getByTestId } = renderStrip();

    expect(getByTestId("copilot-pending-open").textContent).toBe("agent_pending_open");
    fireEvent.click(getByTestId("copilot-pending-open"));
    expect(open).toHaveBeenCalledTimes(1);
    expect(acceptAll).not.toHaveBeenCalled();
  });

  it("«Принять всё» calls acceptAll and nothing else (hunks only — no save exists to call)", () => {
    const { acceptAll, open } = seedExperience();
    const { getByTestId } = renderStrip();

    expect(getByTestId("copilot-pending-accept-all").textContent).toBe("agent_pending_accept_all");
    fireEvent.click(getByTestId("copilot-pending-accept-all"));
    expect(acceptAll).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });
});
