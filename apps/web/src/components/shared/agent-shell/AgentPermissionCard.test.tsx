/**
 * CopilotPermissionCard (SC-23f) — fork #1 of AgentAskCard: the permission
 * gate's states (awaiting/allowed/denied/expired), the send-once decision
 * buttons (Allow PRIMARY, Deny ghost), and the en+ru i18n parity.
 * SC-23g — the meta line's token count is pluralised (the
 * sidechat_event_rp_sync shape: base + suffixed forms, `count` at the call
 * site), pinned byte-exact in both locales and rendered through the real
 * i18next for the RU cardinal rules.
 * DMT-32 — the `request_message_swipe` family: the FULL instruction editable
 * inline (draft store survives remounts), Allow sends the exact edited text,
 * Reject sends only the decision, the empty-field guard, the send-failure
 * rollback (the draft kept), the generation-specific receipts, and the
 * unchanged prompt-read presentation.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import type { AgentPermissionState } from "../../../stores/agent-turn-store.js";
import { useDirectorSwipeDraftStore } from "../../../stores/director-swipe-draft-store.js";
import en from "../../../i18n/locales/en.json";
import ru from "../../../i18n/locales/ru.json";

useDomEnv();

// CO-LOAD CONTRACT (i18n-context-seam family): the non-plural pins echo raw
// keys provider-lessly (`copilot_permission_tokens` with a `count` option —
// the real default context returns the bare key); the RU/EN plural tests
// mount a real provider (delegation keeps them on real i18next). Without its
// OWN registration the file inherits a co-loaded custom spec — reproduced:
// rail-character-browser's `key#count` stub rendered
// `copilot_permission_tokens#1234` and broke the meta pin (2026-10-27 unit).
installI18nContextSeam();

// CustomTooltip (Radix) never anchors under happy-dom — the reply line's
// OverflowTooltip wraps its text in it. Render the text inline; this test
// pins the card's render contract (that the FULL first line reaches the
// tooltip primitive), not tooltip internals.
const realTooltip = await import("../../../components/shared/Tooltip.js");
// Spread `...real` (R4): files sharing this worker may load the CA-4f graph
// (AttachmentGrid → sent-file-attachment) whose `TooltipProvider` import a
// spread-less factory would break.
mock.module("../../../components/shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { render, fireEvent, act } = await import("@testing-library/react");
const { AgentPermissionCard } = await import("./AgentPermissionCard.js");
const { LocaleProvider } = await import("../../../i18n/context.js");
const { i18next, initI18n } = await import("../../../i18n/i18n.js");

// SC-23g: the plural cases below render through the real i18next (the
// identity-echo default `t` cannot observe plural selection). Booting here
// makes the bundled resources synchronously available from the first render
// (`initAsync` is false); the RU switch happens inside those tests only.
initI18n("en");

afterAll(async () => {
  // R13: the plural tests drive the process-global i18next language; restore
  // the default so no sibling file in the shared worker observes RU.
  await i18next.changeLanguage("en");
});

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
    // AP-7 frame: the accent left rule while awaiting, phone-size targets.
    expect(card.className).toContain("border-l-accent");
    expect(allow.className).toContain("min-h-[44px]");
    expect(deny.className).toContain("min-h-[44px]");
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

  it("granted renders the muted arrow receipt read-only (the prompt text is never shown)", () => {
    const { getByTestId, queryByTestId } = renderCard(permission({ status: "granted" }));
    const card = getByTestId("copilot-permission-card");
    expect(card.getAttribute("data-state")).toBe("allowed");
    // Was: the green "Allowed" label. Now (owner 2026-10-22 frame
    // ruling): the ask's receipt style — muted, no green, arrow prefix.
    expect(getByTestId("copilot-permission-allowed").textContent).toBe("→ copilot_permission_allowed");
    expect(card.className).not.toContain("border-l-accent");
    expect(card.className).not.toContain("success-text");
    expect(queryByTestId("copilot-permission-allow")).toBeNull();
    expect(queryByTestId("copilot-permission-deny")).toBeNull();
  });

  it("denied renders the muted arrow receipt read-only (no form)", () => {
    const { getByTestId, queryByTestId } = renderCard(permission({ status: "denied" }));
    expect(getByTestId("copilot-permission-card").getAttribute("data-state")).toBe("denied");
    // Was: the bare "Denied" label. Now (owner 2026-10-22 frame ruling):
    // the ask's receipt style with the arrow prefix.
    expect(getByTestId("copilot-permission-denied").textContent).toBe("→ copilot_permission_denied");
    expect(queryByTestId("copilot-permission-allow")).toBeNull();
    expect(queryByTestId("copilot-permission-deny")).toBeNull();
  });

  it("awaiting but NOT interactive (superseded / streaming) renders expired (no buttons)", () => {
    const { getByTestId, queryByTestId } = renderCard(permission({}), { interactive: false });
    const card = getByTestId("copilot-permission-card");
    expect(card.getAttribute("data-state")).toBe("expired");
    // Muted like the ask's expired state — no accent rule.
    expect(card.className).not.toContain("border-l-accent");
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
    // SC-23g: the token count is pluralised — base + suffixed forms in both
    // locales (the sidechat_event_rp_sync shape; the call site passes
    // `count` alongside the `{tokens}` placeholder).
    expect(enMap["copilot_permission_tokens"]).toBe("≈{tokens} tokens");
    expect(enMap["copilot_permission_tokens_one"]).toBe("≈{tokens} token");
    expect(enMap["copilot_permission_tokens_other"]).toBe("≈{tokens} tokens");
    expect(ruMap["copilot_permission_tokens"]).toBe("≈{tokens} токенов");
    expect(ruMap["copilot_permission_tokens_one"]).toBe("≈{tokens} токен");
    expect(ruMap["copilot_permission_tokens_few"]).toBe("≈{tokens} токена");
    expect(ruMap["copilot_permission_tokens_many"]).toBe("≈{tokens} токенов");
    expect(ruMap["copilot_permission_tokens_other"]).toBe("≈{tokens} токенов");
    expect(typeof enMap["copilot_permission_expired"]).toBe("string");
    expect(typeof ruMap["copilot_permission_expired"]).toBe("string");
  });
});

describe("CopilotPermissionCard — token count pluralisation (SC-23g)", () => {
  it("RU: the meta line follows the RU cardinal rules (1/21 → токен, 3/1234 → токена, 5 → токенов)", async () => {
    await act(async () => {
      await i18next.changeLanguage("ru");
    });
    // The factory's variantNumber is 2, so the full meta line is the RU
    // variant label · the pluralised token estimate.
    const cases: [number, string][] = [
      [1, "вариант 2 · ≈1 токен"],
      [3, "вариант 2 · ≈3 токена"],
      [5, "вариант 2 · ≈5 токенов"],
      [21, "вариант 2 · ≈21 токен"],
      [1234, "вариант 2 · ≈1234 токена"],
    ];
    for (const [promptTokens, expected] of cases) {
      const { getByTestId, unmount } = render(
        <LocaleProvider>
          <AgentPermissionCard permission={permission({ promptTokens })} interactive onDecision={() => {}} />
        </LocaleProvider>,
      );
      expect(getByTestId("copilot-permission-meta").textContent).toBe(expected);
      unmount();
    }
  });

  it("EN: count 1 renders the singular token form", async () => {
    await act(async () => {
      await i18next.changeLanguage("en");
    });
    const { getByTestId } = render(
      <LocaleProvider>
        <AgentPermissionCard permission={permission({ promptTokens: 1 })} interactive onDecision={() => {}} />
      </LocaleProvider>,
    );
    expect(getByTestId("copilot-permission-meta").textContent).toBe("variant 2 · ≈1 token");
  });
});

// ─── Page translation (owner follow-up 2026-10-24) ───────────────────────
// behavior change: was → now, basis: AGENT_SHELL_POLISH_PLAN owner follow-up
// 2026-10-24 (page translation). The reply's first line is the USER's RP
// text — it opts back in; the title / meta / buttons are chrome and stay out.
describe("CopilotPermissionCard — page translation (follow-up 2026-10-24)", () => {
  it("reply first line carries translate=yes (user text)", () => {
    const { getByText } = renderCard(permission({}));
    expect(getByText("First line of the swipe").closest("div[translate]")!.getAttribute("translate")).toBe("yes");
  });

  it("chrome carries no opt-in: title, meta and both buttons stay untranslated", () => {
    const { getByTestId } = renderCard(permission({}));
    expect(getByTestId("copilot-permission-title").getAttribute("translate")).toBeNull();
    expect(getByTestId("copilot-permission-meta").getAttribute("translate")).toBeNull();
    expect(getByTestId("copilot-permission-allow").getAttribute("translate")).toBeNull();
    expect(getByTestId("copilot-permission-deny").getAttribute("translate")).toBeNull();
  });
});

// ─── Director swipe instruction (DMT-32, DIRECTOR_MESSAGE_TOOLS_PLAN) ────
// The `request_message_swipe` family extends the SAME card frame: the
// instruction is visible and editable INLINE (never ellipsized), Allow sends
// the EXACT edited text, Reject sends ONLY the decision, an empty field is
// refused card-side, a transport refusal returns the card to interactive
// with the user's draft kept, the receipts show the generation-specific
// facts (the approved text on grant — never a reset to the Director's
// draft), and the prompt-read presentation is untouched.
const THREAD_KEY = "swipe-thread-1";
const SWIPE_CALL = "tc-swipe-1";

function swipePermission(over: Partial<AgentPermissionState>): AgentPermissionState {
  return {
    status: "awaiting_permission",
    kind: "swipe",
    position: 7,
    variantNumber: 2,
    replyFirstLine: "First line of the swipe",
    messageId: "msg-1",
    variantId: "var-2",
    instruction: "Rewrite it spicier",
    ...over,
  };
}

type DecisionCall = ["allow" | "deny", string | undefined];

function renderSwipeCard(
  state: AgentPermissionState,
  opts?: {
    interactive?: boolean;
    onDecision?: (d: "allow" | "deny", instruction?: string) => void;
    pendingDecision?: "allow" | "deny" | null;
    persistedStatus?: AgentPermissionState["status"];
  },
) {
  const calls: DecisionCall[] = [];
  const onDecision =
    opts?.onDecision ?? ((d: "allow" | "deny", instruction?: string) => calls.push([d, instruction]));
  const utils = render(
    <AgentPermissionCard
      permission={state}
      interactive={opts?.interactive ?? true}
      onDecision={onDecision}
      draftThreadKey={THREAD_KEY}
      draftToolCallId={SWIPE_CALL}
      pendingDecision={opts?.pendingDecision}
      persistedStatus={opts?.persistedStatus ?? state.status}
    />,
  );
  return { ...utils, calls };
}

describe("CopilotPermissionCard — director swipe instruction (DMT-32)", () => {
  beforeEach(() => {
    useDirectorSwipeDraftStore.setState({ draftsByThread: {} });
  });

  it("awaiting swipe: swipe title, target line, variant meta and the FULL instruction editable inline (no token meta)", () => {
    const { getByTestId, getByText, queryByTestId } = renderSwipeCard(swipePermission({}));
    const card = getByTestId("copilot-permission-card");
    expect(card.getAttribute("data-state")).toBe("awaiting");
    // The action-specific title (not the read's), the target reply line and
    // the variant meta — but no prompt-token estimate (the marker has none).
    expect(getByTestId("copilot-permission-title").textContent).toBe("copilot_permission_swipe_title");
    expect(getByText("First line of the swipe")).toBeDefined();
    expect(getByTestId("copilot-permission-meta").textContent).toBe("copilot_permission_variant");
    expect(queryByTestId("copilot-permission-allow")).toBeNull();
    // The proposed instruction is IN the field, full text, editable.
    const field = getByTestId("copilot-permission-swipe-instruction") as HTMLTextAreaElement;
    expect(field.value).toBe("Rewrite it spicier");
    expect(field.getAttribute("aria-label")).toBe("copilot_permission_swipe_instruction_aria");
    // The card frame: the accent left rule while awaiting.
    expect(card.className).toContain("border-l-accent");
  });

  it("the field is editable and the edit lands in the draft store (survives a remount)", () => {
    const first = renderSwipeCard(swipePermission({}));
    fireEvent.change(first.getByTestId("copilot-permission-swipe-instruction"), {
      target: { value: "Make it spicier, keep the accent" },
    });
    expect(
      useDirectorSwipeDraftStore.getState().draftsByThread[THREAD_KEY]?.[SWIPE_CALL],
    ).toBe("Make it spicier, keep the accent");
    first.unmount();
    // Remount (feed virtualization): the card re-reads the retained edit.
    const second = renderSwipeCard(swipePermission({}));
    expect((second.getByTestId("copilot-permission-swipe-instruction") as HTMLTextAreaElement).value).toBe(
      "Make it spicier, keep the accent",
    );
  });

  it("allow sends the EXACT edited text ONCE (the second click is a no-op)", () => {
    const { getByTestId, calls } = renderSwipeCard(swipePermission({}));
    fireEvent.change(getByTestId("copilot-permission-swipe-instruction"), {
      target: { value: "Make it spicier, keep the accent" },
    });
    const allow = getByTestId("copilot-permission-swipe-allow") as HTMLButtonElement;
    fireEvent.click(allow);
    fireEvent.click(allow);
    expect(calls).toEqual([["allow", "Make it spicier, keep the accent"]]);
    expect(allow.disabled).toBe(true);
    expect((getByTestId("copilot-permission-swipe-reject") as HTMLButtonElement).disabled).toBe(true);
  });

  it("allow with the UNTOUCHED draft sends the proposed text verbatim", () => {
    const { getByTestId, calls } = renderSwipeCard(swipePermission({}));
    fireEvent.click(getByTestId("copilot-permission-swipe-allow"));
    expect(calls).toEqual([["allow", "Rewrite it spicier"]]);
  });

  it("reject sends ONLY the decision — the edited text never rides it", () => {
    const { getByTestId, calls } = renderSwipeCard(swipePermission({}));
    fireEvent.change(getByTestId("copilot-permission-swipe-instruction"), {
      target: { value: "an edit that must not be saved" },
    });
    fireEvent.click(getByTestId("copilot-permission-swipe-reject"));
    expect(calls).toEqual([["deny", undefined]]);
  });

  it("allow with an EMPTY field does not send — the required line renders, the card stays actionable", () => {
    const { getByTestId, queryByTestId, calls } = renderSwipeCard(swipePermission({}));
    fireEvent.change(getByTestId("copilot-permission-swipe-instruction"), { target: { value: "   " } });
    fireEvent.click(getByTestId("copilot-permission-swipe-allow"));
    expect(calls).toEqual([]);
    expect(getByTestId("copilot-permission-swipe-error").textContent).toBe(
      "copilot_permission_swipe_instruction_required",
    );
    // Not latched: writing a real instruction and clicking again sends.
    fireEvent.change(getByTestId("copilot-permission-swipe-instruction"), { target: { value: "now real" } });
    expect(queryByTestId("copilot-permission-swipe-error")).toBeNull();
    fireEvent.click(getByTestId("copilot-permission-swipe-allow"));
    expect(calls).toEqual([["allow", "now real"]]);
  });

  it("a transport refusal returns the card to interactive with the send-failed line; the draft STAYS and a retry re-sends", () => {
    const view = renderSwipeCard(swipePermission({}));
    fireEvent.change(view.getByTestId("copilot-permission-swipe-instruction"), {
      target: { value: "my kept edit" },
    });
    fireEvent.click(view.getByTestId("copilot-permission-swipe-allow"));
    expect(view.calls).toEqual([["allow", "my kept edit"]]);
    // The optimistic flight: the anchor's pendingDecision echo.
    view.rerender(
      <AgentPermissionCard
        permission={swipePermission({})}
        interactive
        onDecision={(d, i) => view.calls.push([d, i])}
        draftThreadKey={THREAD_KEY}
        draftToolCallId={SWIPE_CALL}
        pendingDecision="allow"
        persistedStatus="awaiting_permission"
      />,
    );
    // The refusal: the override rolls back, the row still awaits.
    view.rerender(
      <AgentPermissionCard
        permission={swipePermission({})}
        interactive
        onDecision={(d, i) => view.calls.push([d, i])}
        draftThreadKey={THREAD_KEY}
        draftToolCallId={SWIPE_CALL}
        pendingDecision={null}
        persistedStatus="awaiting_permission"
      />,
    );
    expect(view.getByTestId("copilot-permission-card").getAttribute("data-state")).toBe("awaiting");
    expect(view.getByTestId("copilot-permission-swipe-send-failed").textContent).toBe(
      "copilot_permission_swipe_send_failed",
    );
    // The user's edit is kept (a retry must not revert to the original text).
    expect((view.getByTestId("copilot-permission-swipe-instruction") as HTMLTextAreaElement).value).toBe(
      "my kept edit",
    );
    const allow = view.getByTestId("copilot-permission-swipe-allow") as HTMLButtonElement;
    expect(allow.disabled).toBe(false);
    fireEvent.click(allow);
    expect(view.calls).toEqual([["allow", "my kept edit"], ["allow", "my kept edit"]]);
  });

  it("the granted receipt shows the APPROVED text under the approved label (translate=yes), read-only", () => {
    const { getByTestId, queryByTestId } = renderSwipeCard(
      swipePermission({ status: "granted", instruction: "the final approved text" }),
    );
    const card = getByTestId("copilot-permission-card");
    expect(card.getAttribute("data-state")).toBe("allowed");
    // The receipt asserts only "sent to generation" — never that a variant
    // was saved (the row carries no run outcome).
    expect(getByTestId("copilot-permission-swipe-allowed").textContent).toBe(
      "→ copilot_permission_swipe_allowed_receipt",
    );
    const approved = getByTestId("copilot-permission-swipe-approved-text");
    expect(approved.textContent).toBe("the final approved text");
    expect(approved.getAttribute("translate")).toBe("yes");
    expect(queryByTestId("copilot-permission-swipe-allow")).toBeNull();
    expect(queryByTestId("copilot-permission-swipe-reject")).toBeNull();
    expect(queryByTestId("copilot-permission-swipe-instruction")).toBeNull();
    expect(card.className).not.toContain("border-l-accent");
  });

  it("the denied receipt is read-only with no field and no draft text", () => {
    useDirectorSwipeDraftStore.setState({
      draftsByThread: { [THREAD_KEY]: { [SWIPE_CALL]: "stale edit" } },
    });
    const { getByTestId, queryByTestId } = renderSwipeCard(
      swipePermission({ status: "denied", instruction: undefined }),
      { persistedStatus: "denied" },
    );
    expect(getByTestId("copilot-permission-card").getAttribute("data-state")).toBe("denied");
    expect(getByTestId("copilot-permission-swipe-denied").textContent).toBe(
      "→ copilot_permission_swipe_denied_receipt",
    );
    expect(queryByTestId("copilot-permission-swipe-instruction")).toBeNull();
    expect(queryByTestId("copilot-permission-swipe-approved-text")).toBeNull();
    // The stale draft cleared with the resolution.
    expect(useDirectorSwipeDraftStore.getState().draftsByThread[THREAD_KEY]?.[SWIPE_CALL]).toBeUndefined();
  });

  it("expired swipe renders read-only with the generation-specific copy", () => {
    const { getByTestId, queryByTestId } = renderSwipeCard(swipePermission({}), { interactive: false });
    const card = getByTestId("copilot-permission-card");
    expect(card.getAttribute("data-state")).toBe("expired");
    expect(card.className).not.toContain("border-l-accent");
    expect(getByTestId("copilot-permission-swipe-expired").textContent).toBe(
      "copilot_permission_swipe_expired",
    );
    expect(queryByTestId("copilot-permission-swipe-allow")).toBeNull();
    expect(queryByTestId("copilot-permission-swipe-reject")).toBeNull();
    expect(queryByTestId("copilot-permission-swipe-instruction")).toBeNull();
  });

  it("the draft clears when the PERSISTED row resolves — never on the optimistic flip", () => {
    useDirectorSwipeDraftStore.setState({
      draftsByThread: { [THREAD_KEY]: { [SWIPE_CALL]: "kept edit" } },
    });
    const view = renderSwipeCard(swipePermission({}), { persistedStatus: "awaiting_permission" });
    // The optimistic flip alone must NOT clear the draft (a refusal has to
    // keep it): the granted state renders, but the persisted row awaits.
    view.rerender(
      <AgentPermissionCard
        permission={swipePermission({ status: "granted" })}
        interactive={false}
        onDecision={() => {}}
        draftThreadKey={THREAD_KEY}
        draftToolCallId={SWIPE_CALL}
        pendingDecision="allow"
        persistedStatus="awaiting_permission"
      />,
    );
    expect(useDirectorSwipeDraftStore.getState().draftsByThread[THREAD_KEY]?.[SWIPE_CALL]).toBe("kept edit");
    // The persisted grant resolves the request — the transient draft clears.
    view.rerender(
      <AgentPermissionCard
        permission={swipePermission({ status: "granted", instruction: "the final approved text" })}
        interactive={false}
        onDecision={() => {}}
        draftThreadKey={THREAD_KEY}
        draftToolCallId={SWIPE_CALL}
        pendingDecision="allow"
        persistedStatus="granted"
      />,
    );
    expect(useDirectorSwipeDraftStore.getState().draftsByThread[THREAD_KEY]?.[SWIPE_CALL]).toBeUndefined();
  });

  it("responsive controls: the action pair wraps and keeps phone-sized targets", () => {
    const { getByTestId } = renderSwipeCard(swipePermission({}));
    const allow = getByTestId("copilot-permission-swipe-allow");
    const reject = getByTestId("copilot-permission-swipe-reject");
    // AD-022: the RU copy of the pair (ru.json `copilot_permission_swipe_allow`
    // + `copilot_permission_swipe_reject`) exceeds the narrowest mobile
    // content width, so the row wraps — authored copy is never truncated and
    // each button alone fits.
    expect(allow.className).toContain("min-h-[44px]");
    expect(reject.className).toContain("min-h-[44px]");
    expect(allow.parentElement!.className).toContain("flex-wrap");
    // Allow is PRIMARY; Reject is the ghost idiom.
    expect(allow.className).toContain("bg-accent");
    expect(reject.className).not.toContain("bg-accent");
  });

  it("prompt-read rendering is unchanged: no instruction field, no swipe testids", () => {
    const { getByTestId, queryByTestId } = renderCard(permission({}));
    expect(getByTestId("copilot-permission-card").getAttribute("data-state")).toBe("awaiting");
    expect(queryByTestId("copilot-permission-swipe-instruction")).toBeNull();
    expect(queryByTestId("copilot-permission-swipe-allow")).toBeNull();
    expect(queryByTestId("copilot-permission-swipe-reject")).toBeNull();
    expect(getByTestId("copilot-permission-allow")).toBeDefined();
  });

  it("i18n parity: every swipe-card key exists in en + ru with the plan's wording", () => {
    const enMap = en as Record<string, string>;
    const ruMap = ru as Record<string, string>;
    const expected: Record<string, { en: string; ru: string }> = {
      copilot_permission_swipe_title: {
        en: "The director wants to generate a new variant of this reply",
        ru: "Режиссёр хочет сгенерировать новый вариант этого ответа",
      },
      copilot_permission_swipe_instruction_label: {
        en: "Instruction for this generation",
        ru: "Инструкция для этой генерации",
      },
      copilot_permission_swipe_instruction_aria: {
        en: "Edit the generation instruction",
        ru: "Редактировать инструкцию для генерации",
      },
      copilot_permission_swipe_allow: { en: "Allow generation", ru: "Разрешить генерацию" },
      copilot_permission_swipe_reject: { en: "Reject", ru: "Отклонить" },
      copilot_permission_swipe_instruction_required: {
        en: "Write an instruction first — an empty one cannot be sent.",
        ru: "Сначала напишите инструкцию — пустую отправить нельзя.",
      },
      copilot_permission_swipe_send_failed: {
        en: "Couldn't send the decision — your edit is kept, try again.",
        ru: "Не удалось отправить решение — ваша правка сохранена, попробуйте ещё раз.",
      },
      copilot_permission_swipe_allowed_receipt: {
        en: "Allowed — the instruction was sent to generation.",
        ru: "Разрешено — инструкция отправлена на генерацию.",
      },
      copilot_permission_swipe_approved_label: { en: "Approved instruction", ru: "Утверждённая инструкция" },
      copilot_permission_swipe_denied_receipt: {
        en: "Rejected — no generation was started.",
        ru: "Отклонено — генерация не запускалась.",
      },
      copilot_permission_swipe_expired: {
        en: "Left unanswered — no generation was started.",
        ru: "Осталось без ответа — генерация не запускалась.",
      },
    };
    for (const [key, wording] of Object.entries(expected)) {
      expect(enMap[key]).toBe(wording.en);
      expect(ruMap[key]).toBe(wording.ru);
    }
  });
});
