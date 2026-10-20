/**
 * RecordProposalFallbackCard — the neutral review card for unrenderable
 * record proposals (AS-5): unknown recordType renders without crashing, a
 * malformed (circular) payload renders the bad-payload fallback instead of
 * throwing, Accept stays disabled with the unsupported-type hint, and the
 * pending status chip shows.
 */
import { describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { RecordProposal } from "@vibe-tavern/api-contracts";
import en from "../../../i18n/locales/en.json";
import ru from "../../../i18n/locales/ru.json";

useDomEnv();

const { render } = await import("@testing-library/react");
const { RecordProposalFallbackCard } = await import("./RecordProposalFallbackCard.js");

function proposal(over: Partial<RecordProposal>): RecordProposal {
  return {
    kind: "record",
    id: "rec_1",
    recordType: "lorebook-entry",
    op: "create",
    payload: { title: "New entry", body: "text" },
    status: "pending",
    ...over,
  };
}

describe("RecordProposalFallbackCard (AS-5)", () => {
  it("renders an unknown recordType without crashing (type + op + target + payload preview)", () => {
    const { getByTestId } = render(
      <RecordProposalFallbackCard
        proposal={proposal({ recordType: "never-seen-widget", op: "update", targetId: "w_42" })}
        threadId="thread-1"
      />,
    );
    const card = getByTestId("record-proposal-fallback-card");
    expect(card.getAttribute("data-record-type")).toBe("never-seen-widget");
    expect(card.getAttribute("data-op")).toBe("update");
    // Identity i18n (no LocaleProvider): keys render verbatim.
    expect(getByTestId("record-proposal-fallback-title").textContent).toContain("never-seen-widget");
    expect(getByTestId("record-proposal-fallback-title").textContent).toContain(
      "agent.record_proposal.op.update",
    );
    expect(getByTestId("record-proposal-fallback-target").textContent).toBe("w_42");
    expect(getByTestId("record-proposal-fallback-payload").textContent).toContain("New entry");
  });

  it("malformed (circular) payload renders the bad-payload fallback — no throw", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    let card: ReturnType<typeof render> | null = null;
    expect(() => {
      card = render(<RecordProposalFallbackCard proposal={proposal({ payload: circular })} threadId="thread-1" />);
    }).not.toThrow();
    expect(card!.getByTestId("record-proposal-fallback-payload").textContent).toBe(
      "agent.record_proposal.bad_payload",
    );
  });

  it("Accept is disabled with the unsupported-type hint; pending status shows", () => {
    const { getByTestId } = render(<RecordProposalFallbackCard proposal={proposal({})} threadId="thread-1" />);
    const accept = getByTestId("record-proposal-fallback-accept");
    expect(accept.getAttribute("disabled")).not.toBeNull();
    expect(accept.getAttribute("title")).toBe("agent.record_proposal.hint");
    expect(getByTestId("record-proposal-fallback-hint").textContent).toBe(
      "agent.record_proposal.hint",
    );
    expect(getByTestId("record-proposal-fallback-status").textContent).toBe(
      "agent.record_proposal.status_pending",
    );
  });

  it("locale tables carry the fallback strings (RU disabled-accept hint is owner-specified, byte-exact)", () => {
    const record = en as Record<string, string>;
    expect(record["agent.record_proposal.unsupported_title"]).toBe("Unsupported proposal");
    expect(record["agent.record_proposal.bad_payload"]).toBe("(malformed data)");
    expect(record["agent.record_proposal.op.create"]).toBe("Create");
    expect(record["agent.record_proposal.op.update"]).toBe("Update");
    expect(record["agent.record_proposal.op.delete"]).toBe("Delete");
    const ruRecord = ru as Record<string, string>;
    expect(ruRecord["agent.record_proposal.hint"]).toBe("Этот тип предложения пока не поддерживается");
    expect(ruRecord["agent.record_proposal.bad_payload"]).toBe("(некорректные данные)");
  });
});
