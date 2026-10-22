/**
 * CopilotPermissionCard (SC-23f) — fork #1 of AgentAskCard: the permission
 * gate's states (awaiting/allowed/denied/expired), the send-once decision
 * buttons (Allow PRIMARY, Deny ghost), and the en+ru i18n parity.
 */
import { describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { AgentPermissionState } from "../../../stores/agent-turn-store.js";
import en from "../../../i18n/locales/en.json";
import ru from "../../../i18n/locales/ru.json";

useDomEnv();

// CustomTooltip (Radix) never anchors under happy-dom — the reply line's
// OverflowTooltip wraps its text in it. Render the text inline; this test
// pins the card's render contract (that the FULL first line reaches the
// tooltip primitive), not tooltip internals.
mock.module("../../../components/shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { render, fireEvent } = await import("@testing-library/react");
const { AgentPermissionCard } = await import("./AgentPermissionCard.js");

function permission(over: Partial<AgentPermissionState>): AgentPermissionState {
  return {
    status: "awaiting_permission",
    position: 7,
    variantNumber: 2,
    replyFirstLine: "First line of the swipe",
    promptTokens: 1234,
    presetName: "Preset",
    ...over,
  };
}

function renderCard(
  state: AgentPermissionState,
  opts?: { interactive?: boolean; onDecision?: (d: "allow" | "deny") => void },
) {
  const calls: ("allow" | "deny")[] = [];
  const onDecision = opts?.onDecision ?? ((d: "allow" | "deny") => calls.push(d));
  const utils = render(
    <AgentPermissionCard permission={state} interactive={opts?.interactive ?? true} onDecision={onDecision} />,
  );
  return { ...utils, calls };
}

describe("CopilotPermissionCard (SC-23f)", () => {
  it("interactive awaiting: title + reply line + variant/tokens meta + Allow (primary) + Deny", () => {
    const { getByTestId, getByText } = renderCard(permission({}));
    const card = getByTestId("copilot-permission-card");
    expect(card.getAttribute("data-state")).toBe("awaiting");
    // No i18n init in this suite — the default context echoes keys.
    expect(getByTestId("copilot-permission-title").textContent).toBe("copilot_permission_title");
    expect(getByText("First line of the swipe")).toBeDefined();
    expect(getByTestId("copilot-permission-meta").textContent).toBe(
      "copilot_permission_variant · copilot_permission_tokens",
    );
    const allow = getByTestId("copilot-permission-allow");
    const deny = getByTestId("copilot-permission-deny");
    expect(allow.textContent).toBe("copilot_permission_allow");
    expect(deny.textContent).toBe("copilot_permission_deny");
    // Allow is PRIMARY (the modal-footer's confirm idiom); Deny is the
    // ask-skip ghost (never the accent fill).
    expect(allow.className).toContain("bg-accent");
    expect(deny.className).not.toContain("bg-accent");
  });

  it("Allow sends its decision ONCE (the second click is a no-op)", () => {
    const { getByTestId, calls } = renderCard(permission({}));
    const allow = getByTestId("copilot-permission-allow") as HTMLButtonElement;
    fireEvent.click(allow);
    fireEvent.click(allow);
    expect(calls).toEqual(["allow"]);
    expect(allow.disabled).toBe(true);
    expect((getByTestId("copilot-permission-deny") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Deny sends its decision ONCE (the second click is a no-op)", () => {
    const { getByTestId, calls } = renderCard(permission({}));
    const deny = getByTestId("copilot-permission-deny") as HTMLButtonElement;
    fireEvent.click(deny);
    fireEvent.click(deny);
    expect(calls).toEqual(["deny"]);
    expect(deny.disabled).toBe(true);
  });

  it("granted renders the Allowed label read-only (the prompt text is never shown)", () => {
    const { getByTestId, queryByTestId } = renderCard(permission({ status: "granted" }));
    expect(getByTestId("copilot-permission-card").getAttribute("data-state")).toBe("allowed");
    expect(getByTestId("copilot-permission-allowed").textContent).toBe("copilot_permission_allowed");
    expect(queryByTestId("copilot-permission-allow")).toBeNull();
    expect(queryByTestId("copilot-permission-deny")).toBeNull();
  });

  it("denied renders the Denied label read-only (no form)", () => {
    const { getByTestId, queryByTestId } = renderCard(permission({ status: "denied" }));
    expect(getByTestId("copilot-permission-card").getAttribute("data-state")).toBe("denied");
    expect(getByTestId("copilot-permission-denied").textContent).toBe("copilot_permission_denied");
    expect(queryByTestId("copilot-permission-allow")).toBeNull();
    expect(queryByTestId("copilot-permission-deny")).toBeNull();
  });

  it("awaiting but NOT interactive (superseded / streaming) renders expired (no buttons)", () => {
    const { getByTestId, queryByTestId } = renderCard(permission({}), { interactive: false });
    const card = getByTestId("copilot-permission-card");
    expect(card.getAttribute("data-state")).toBe("expired");
    expect(getByTestId("copilot-permission-expired").textContent).toBe("copilot_permission_expired");
    expect(queryByTestId("copilot-permission-allow")).toBeNull();
    expect(queryByTestId("copilot-permission-deny")).toBeNull();
  });

  it("i18n parity: every permission-card key exists in en + ru with the plan's wording", () => {
    const enMap = en as Record<string, string>;
    const ruMap = ru as Record<string, string>;
    const expected: Record<string, { en: string; ru: string }> = {
      copilot_permission_title: {
        en: "The assistant wants to read a reply's prompt",
        ru: "Помощник хочет прочитать промпт ответа",
      },
      copilot_permission_allow: { en: "Allow", ru: "Разрешить" },
      copilot_permission_deny: { en: "Deny", ru: "Отказать" },
      copilot_permission_allowed: { en: "Allowed", ru: "Разрешено" },
      copilot_permission_denied: { en: "Denied", ru: "Отказано" },
    };
    for (const [key, wording] of Object.entries(expected)) {
      expect(enMap[key]).toBe(wording.en);
      expect(ruMap[key]).toBe(wording.ru);
    }
    // The interpolated meta keys carry single-brace placeholders in BOTH locales.
    expect(enMap["copilot_permission_variant"]).toContain("{variant}");
    expect(ruMap["copilot_permission_variant"]).toContain("{variant}");
    expect(ruMap["copilot_permission_variant"]).toContain("вариант");
    expect(enMap["copilot_permission_tokens"]).toContain("{tokens}");
    expect(ruMap["copilot_permission_tokens"]).toContain("{tokens}");
    expect(ruMap["copilot_permission_tokens"]).toContain("токенов");
    expect(typeof enMap["copilot_permission_expired"]).toBe("string");
    expect(typeof ruMap["copilot_permission_expired"]).toBe("string");
  });
});
