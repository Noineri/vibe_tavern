/**
 * StoryCalendarView (DIRECTOR_DECK_CALENDAR_PLAN DK-9, mockup §5/§8) — the
 * story curtain's CALENDAR tab body:
 *
 *  - the OFF state (no marked day field, §8): the calendar-event icon, the
 *    title + explanation, «Включить время» — the write goes through the
 *    EXISTING tracker config PATCH (schema gains the three canonical clock
 *    fields; trackerEnabled rides along only when the tracker was off, and
 *    the cost hint under the button is shown exactly then);
 *  - the header buttons write the latest valid scene record through the
 *    EXISTING scene edit route — «→ Дальше» one part forward (night wraps to
 *    the next day's morning), «+1 день» same part next day; disabled with
 *    the hint while there is no record yet, and while locked;
 *  - grid placement: dated chips sit in their (day, part) cells (a null
 *    part ranks with morning), completed chips struck through, the current
 *    cell ringed (data-cell-state), past cells muted, the day range runs
 *    day 1 .. max(today, last dated) + 1;
 *  - today scrolled into view on mount (scrollLeft > 0 when the grid
 *    overflows);
 *  - assign from an empty cell: desktop the popover with the caption +
 *    undated pending options — picking one PUTs the plan with that event's
 *    `at` set (the SAME write the editor uses); phone the ActionSheet with
 *    the same caption and «Отмена»;
 *  - a CHIP opens the plan editor at that event (the onOpenEvent seam);
 *  - the undated list below the grid; the injection-off muted line exactly
 *    when tracker.injectLastN is 0.
 *
 * Runner: bun:test + happy-dom; the i18n seam's identity `t`; fetch-level
 * routing (the real useAgentPlan / editSceneAction /
 * updateInsightsConfigAction seams against canned payloads); the snapshot
 * store seeded per test (the scene-zone seeding pattern — messages carry
 * the sceneTracker records); per-test chat/branch ids keep the module-global
 * plan cache entries disjoint. The mobile hook is a module seam (the
 * scene-zone pattern) flipped per phone test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import type { AgentPlan } from "@vibe-tavern/api-contracts";
import type { MessageVariantId } from "@vibe-tavern/domain";
import type { AppMessage, AppSnapshot } from "../../../api/types.js";

useDomEnv();
const { fireEvent, render, waitFor, within } = await import("@testing-library/react");

installI18nContextSeam();

let isMobile = false;
const onOpenEvent = mock((taskId: string) => {});
const realMobileHook = await import("../../../hooks/use-mobile.js");
mock.module("../../../hooks/use-mobile.js", () => ({ ...realMobileHook, useIsMobile: () => isMobile }));

const { useSnapshotStore } = await import("../../../stores/snapshot-store.js");
const { SCENE_CLOCK_MARKER } = await import("@vibe-tavern/domain");

let StoryCalendarView: typeof import("./StoryCalendarView.js").StoryCalendarView;
beforeAll(async () => {
  ({ StoryCalendarView } = await import("./StoryCalendarView.js"));
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const CLOCK_SCHEMA = {
  mood: { $type: "string", label: "Mood" },
  story_day: { $type: "number", clock: SCENE_CLOCK_MARKER.day, label: "Story day" },
  story_time: { $type: "string", clock: SCENE_CLOCK_MARKER.part, label: "Part of day" },
  story_date: { $type: "string", clock: SCENE_CLOCK_MARKER.label, label: "Date label" },
} as unknown as Record<string, { $type: string; clock?: string }>;
const PLAIN_SCHEMA = { mood: { $type: "string", label: "Mood" } } as unknown as Record<string, { $type: string }>;
const SCHEMA_HASH = "clock-h1";
const REVISION = 4;

type SceneRecord = NonNullable<AppMessage["sceneTracker"]>;
type SceneState = SceneRecord["sceneState"];

// The branded-id fixture edge (the snapshot-store.test idiom — typed
// branders instead of never-casts).
const asVariantId = (id: string): MessageVariantId => id as MessageVariantId;
type Timestamp = SceneRecord["generatedAt"];
const asTimestamp = (value: string): Timestamp => value as Timestamp;

function record(variantId: string, sceneState: SceneState): SceneRecord {
  return {
    variantId: asVariantId(variantId),
    schemaHash: SCHEMA_HASH,
    configRevision: REVISION,
    sourceHash: "s1",
    sceneState,
    modelId: null,
    generatedAt: asTimestamp("2026-01-01T00:00:00.000Z"),
  };
}

function msg(id: string, opts: { rec?: SceneRecord | null } = {}): AppMessage {
  const variantId = `${id}-v0`;
  return {
    id,
    role: "assistant",
    chatId: "chat-1",
    branchId: "b1",
    content: `content ${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [{ id: variantId, messageId: id, variantIndex: 0, content: `content ${id}`, isSelected: true } as unknown as AppMessage["variants"][number]],
    selectedVariantIndex: 0,
    modelId: null,
    sceneTracker: opts.rec === undefined ? null : opts.rec,
  } as unknown as AppMessage;
}

function task(id: string, title: string, status: AgentPlan["tasks"][number]["status"], at?: AgentPlan["tasks"][number]["at"]): AgentPlan["tasks"][number] {
  return { id, title, body: "", status, ...(at !== undefined ? { at } : {}) };
}

/** The §5 board: day 1 morning done (struck), day 4 evening pending, an
 *  active undated event, one undated pending (the assign option), day 5
 *  morning pending (the far column). */
const PLAN: AgentPlan = {
  goal: "A stray cat became a young man overnight",
  constraints: [],
  tasks: [
    task("ev1", "The morning after", "completed", { day: 1, part: "morning" }),
    task("ev2", "The fridge raid", "active"),
    task("ev3", "The vet visit", "pending", { day: 4, part: "evening" }),
    task("ev4", "House rules", "pending"),
    task("ev5", "The neighbour noticed", "pending", { day: 5, part: "morning" }),
  ],
};
const EMPTY_PLAN: AgentPlan = { goal: "", constraints: [], tasks: [] };

// ── The snapshot seed ───────────────────────────────────────────────────────

interface SeedOptions {
  schema?: unknown;
  trackerEnabled?: boolean;
  injectLastN?: number;
  messages: AppMessage[];
}

function seed({ schema = CLOCK_SCHEMA, trackerEnabled = true, injectLastN = 1, messages }: SeedOptions): void {
  const snap: AppSnapshot = {
    chats: [],
    allCharacters: [],
    activeChat: {
      id: "chat-1",
      title: "Chat 1",
      characterId: "c1",
      activeBranchId: "b1",
      insightsConfig: {
        objectiveEnabled: false,
        trackerEnabled,
        tracker: { schema, schemaHash: SCHEMA_HASH, revision: REVISION, injectLastN },
      },
    } as unknown as AppSnapshot["activeChat"],
    activeBranch: { id: "b1", chatId: "chat-1", label: "main" } as unknown as AppSnapshot["activeBranch"],
    branches: [],
    messages,
    summaries: [],
    promptTrace: null,
    character: null,
    persona: null,
  } as unknown as AppSnapshot;
  useSnapshotStore.getState().ingestSnapshot(snap);
}

// ── fetch routing (plan GET/PUT · scene edit · insights config PATCH) ───────

const originalFetch = globalThis.fetch;
const plansByBranch = new Map<string, AgentPlan>();
const planPuts: Array<{ branchId: string; body: AgentPlan }> = [];
const sceneEdits: Array<{ body: { target: { messageId: string; variantId: string }; sceneState: Record<string, unknown> } }> = [];
const insightPatches: Array<{ body: { insightsConfig?: { tracker?: { schema: unknown }; trackerEnabled?: boolean } } }> = [];
let configSchema: unknown = CLOCK_SCHEMA;
let configTrackerEnabled = true;

beforeEach(() => {
  plansByBranch.clear();
  planPuts.length = 0;
  sceneEdits.length = 0;
  insightPatches.length = 0;
  configSchema = CLOCK_SCHEMA;
  configTrackerEnabled = true;
  isMobile = false;
  onOpenEvent.mockClear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input), "http://gateway.test").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    if (/\/plan$/.test(path)) {
      const branchId = path.split("/branches/")[1]?.split("/")[0] ?? "";
      if (method === "GET") {
        return new Response(JSON.stringify({ plan: plansByBranch.get(branchId) ?? EMPTY_PLAN }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const body = (JSON.parse(String(init?.body ?? "{}")) as { plan: AgentPlan }).plan;
      planPuts.push({ branchId, body });
      return new Response(JSON.stringify({ plan: body }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (/\/scene\/edit$/.test(path)) {
      const pushed = { body: JSON.parse(String(init?.body ?? "{}")) as { target: { messageId: string; variantId: string }; sceneState: SceneState } };
      sceneEdits.push(pushed);
      // The confirmed patch carries the message with the NEW record (the
      // server's contract) — the store keeps a valid latest record.
      return new Response(JSON.stringify({
        target: { chatId: "chat-1", branchId: "b1", messageId: pushed.body.target.messageId, variantId: pushed.body.target.variantId },
        message: msg("m1", { rec: record("m1-v0", pushed.body.sceneState) }),
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (/\/insights-config$/.test(path)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { insightsConfig?: { tracker?: { schema: unknown }; trackerEnabled?: boolean } };
      insightPatches.push({ body });
      if (body.insightsConfig?.tracker?.schema !== undefined) configSchema = body.insightsConfig.tracker.schema;
      if (body.insightsConfig?.trackerEnabled !== undefined) configTrackerEnabled = body.insightsConfig.trackerEnabled;
      // The confirmed snapshot (the same seed, config swapped) — the store
      // ingests it, so post-write assertions can read the new state.
      seed({ schema: configSchema, trackerEnabled: configTrackerEnabled, messages: [msg("m1", { rec: null })] });
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { message: `unrouted ${method} ${path}` } }), { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  useSnapshotStore.setState({ activeChat: null, messagesById: {}, messageOrder: [] });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/** Seed the clocked chat (record day 3, evening) + plan and mount. */
async function mountCalendar(over: {
  branchId?: string;
  plan?: AgentPlan;
  sceneState?: SceneState;
  seed?: Partial<SeedOptions>;
  locked?: boolean;
} = {}) {
  const branchId = over.branchId ?? "b1";
  plansByBranch.set(branchId, over.plan ?? PLAN);
  seed({
    ...over.seed,
    messages: over.seed?.messages ?? [msg("m1", { rec: record("m1-v0", over.sceneState ?? { story_day: 3, story_time: "evening", story_date: "Tuesday, October 14", mood: "tense" }) })],
  });
  const view = render(
    <StoryCalendarView
      chatId="chat-1"
      branchId={branchId}
      locked={over.locked ?? false}
      onOpenEvent={onOpenEvent}
    />,
  );
  // The plan GET settles before any interaction.
  await waitFor(() => expect(view.queryByTestId("story-cal-grid")).not.toBeNull());
  return view;
}

// ── The off state + the enable write (§8) ─────────────────────────────────────

describe("StoryCalendarView — the off state (§8)", () => {
  it("unmarked schema: the centered off state; the tracker-off hint rides only when the tracker is off; «Включить время» adds the canonical fields and turns the tracker on", async () => {
    seed({ schema: PLAIN_SCHEMA, trackerEnabled: false, messages: [msg("m1")] });
    const view = render(<StoryCalendarView chatId="chat-1" branchId="b-off" locked={false} onOpenEvent={onOpenEvent} />);
    const off = await waitFor(() => view.getByTestId("story-cal-off"));
    expect(off.textContent).toContain("story_cal_off_title");
    expect(off.textContent).toContain("story_cal_off_hint");
    expect(off.querySelector("[data-testid='story-cal-enable']")).not.toBeNull();
    // The tracker is off → the cost hint under the button names it.
    expect(view.getByTestId("story-cal-enable-tracker-hint").textContent).toContain("story_cal_enable_tracker_hint");
    expect(view.queryByTestId("story-cal-grid")).toBeNull();

    fireEvent.click(view.getByTestId("story-cal-enable"));
    await waitFor(() => expect(insightPatches).toHaveLength(1));
    const patch = insightPatches[0]!.body.insightsConfig!;
    // The schema gains the THREE canonical clock fields (the domain adder).
    const schema = patch.tracker?.schema as Record<string, Record<string, unknown>>;
    expect(schema.story_day?.clock).toBe("day");
    expect(schema.story_time?.clock).toBe("part");
    expect(schema.story_date?.clock).toBe("label");
    // The user's own field survives untouched (no clock marker, its label
    // intact).
    expect(schema.mood?.clock).toBeUndefined();
    expect(schema.mood?.label).toBe("Mood");
    // The tracker was off → this click turns it on.
    expect(patch.trackerEnabled).toBe(true);
    view.unmount();

    // The tracker already on: no trackerEnabled in the patch, no hint.
    seed({ schema: PLAIN_SCHEMA, trackerEnabled: true, messages: [msg("m1")] });
    const view2 = render(<StoryCalendarView chatId="chat-1" branchId="b-off2" locked={false} onOpenEvent={onOpenEvent} />);
    await waitFor(() => expect(view2.getByTestId("story-cal-off")).toBeDefined());
    expect(view2.queryByTestId("story-cal-enable-tracker-hint")).toBeNull();
    fireEvent.click(view2.getByTestId("story-cal-enable"));
    await waitFor(() => expect(insightPatches).toHaveLength(2));
    expect(insightPatches[1]!.body.insightsConfig?.trackerEnabled).toBeUndefined();
    expect(insightPatches[1]!.body.insightsConfig?.tracker?.schema).toBeDefined();
  });
});

// ── The header buttons write the record ───────────────────────────────────────

describe("StoryCalendarView — the clock moves (§5/§8)", () => {
  it("«→ Дальше» advances one part (evening → night) through the EXISTING scene edit route", async () => {
    const view = await mountCalendar();
    fireEvent.click(view.getByTestId("story-cal-next-part"));
    await waitFor(() => expect(sceneEdits).toHaveLength(1));
    const { sceneState } = sceneEdits[0]!.body;
    expect(sceneState.story_day).toBe(3);
    expect(sceneState.story_time).toBe("night");
    // The untouched user field rides along (the write is the full record).
    expect(sceneState.mood).toBe("tense");
    // The date label stays out of the write (model-owned display text).
    expect(sceneState.story_date).toBe("Tuesday, October 14");
  });

  it("night wraps to the NEXT day's morning; «+1 день» keeps the part", async () => {
    const view = await mountCalendar({ branchId: "b-night", sceneState: { story_day: 3, story_time: "night" } });
    fireEvent.click(view.getByTestId("story-cal-next-part"));
    await waitFor(() => expect(sceneEdits).toHaveLength(1));
    expect(sceneEdits[0]!.body.sceneState.story_day).toBe(4);
    expect(sceneEdits[0]!.body.sceneState.story_time).toBe("morning");
    view.unmount();

    const view2 = await mountCalendar({ branchId: "b-day", plan: EMPTY_PLAN });
    fireEvent.click(view2.getByTestId("story-cal-add-day"));
    await waitFor(() => expect(sceneEdits).toHaveLength(2));
    expect(sceneEdits[1]!.body.sceneState.story_day).toBe(4);
    expect(sceneEdits[1]!.body.sceneState.story_time).toBe("evening");
  });

  it("no record yet: «День — · —» + the hint, both buttons disabled; locked disables them too", async () => {
    seed({ messages: [msg("m1", { rec: null })] });
    plansByBranch.set("b-norec", EMPTY_PLAN);
    const view = render(<StoryCalendarView chatId="chat-1" branchId="b-norec" locked={false} onOpenEvent={onOpenEvent} />);
    await waitFor(() => expect(view.getByTestId("story-cal-header")).toBeDefined());
    expect(view.getByTestId("story-cal-no-record-hint").textContent).toContain("story_cal_no_record_hint");
    expect(view.getByTestId("story-cal-next-part").getAttribute("disabled")).toBe("");
    expect(view.getByTestId("story-cal-add-day").getAttribute("disabled")).toBe("");
    view.unmount();

    const locked = await mountCalendar({ branchId: "b-locked", locked: true });
    expect(locked.getByTestId("story-cal-next-part").getAttribute("disabled")).toBe("");
    expect(locked.getByTestId("story-cal-add-day").getAttribute("disabled")).toBe("");
    fireEvent.click(locked.getByTestId("story-cal-next-part"));
    expect(sceneEdits).toHaveLength(0);
  });
});

// ── The grid (§5) ──────────────────────────────────────────────────────────────

describe("StoryCalendarView — the grid (§5)", () => {
  it("dated chips sit in their (day, part) cells; completed struck; today ringed; past muted; the range is max(today, last dated) + 1", async () => {
    const view = await mountCalendar();
    // Day range: today 3, last dated 5 → columns 1..6.
    expect(view.queryByTestId("story-cal-day-header-6")).not.toBeNull();
    expect(view.queryByTestId("story-cal-day-header-7")).toBeNull();
    // The chips land in their cells.
    const vetCell = view.getByTestId("story-cal-cell-4-evening");
    const vetChip = within(vetCell).getByTestId("story-cal-chip");
    expect(vetChip.getAttribute("data-task-id")).toBe("ev3");
    const neighbourCell = view.getByTestId("story-cal-cell-5-morning");
    expect(within(neighbourCell).getByTestId("story-cal-chip").getAttribute("data-task-id")).toBe("ev5");
    // The done chip (day 1 morning) is struck through.
    const doneChip = within(view.getByTestId("story-cal-cell-1-morning")).getByTestId("story-cal-chip");
    expect(doneChip.className).toContain("line-through");
    // The current cell (today 3, evening) is ringed; past cells muted; a
    // future cell neither.
    expect(view.getByTestId("story-cal-cell-3-evening").getAttribute("data-cell-state")).toBe("now");
    expect(view.getByTestId("story-cal-cell-2-evening").getAttribute("data-cell-state")).toBe("past");
    expect(view.getByTestId("story-cal-cell-4-evening").getAttribute("data-cell-state")).toBe("open");
    // The today column header carries the «· сегодня» suffix (desktop).
    expect(view.getByTestId("story-cal-day-header-3").textContent).toContain("story_cal_day_today");
    expect(view.getByTestId("story-cal-day-header-2").textContent).toContain("story_cal_day_column");
  });

  it("today scrolls into view on mount (the viewport scrolls when the grid overflows)", async () => {
    const view = await mountCalendar({
      branchId: "b-scroll",
      sceneState: { story_day: 8, story_time: "morning" },
    });
    const viewport = view.container.querySelector<HTMLElement>("[data-scroll-viewport]");
    expect(viewport).not.toBeNull();
    await waitFor(() => expect((viewport?.scrollLeft ?? 0)).toBeGreaterThan(0));
  });

  it("a chip opens the plan editor at that event (the onOpenEvent seam)", async () => {
    const view = await mountCalendar({ branchId: "b-chip" });
    fireEvent.click(within(view.getByTestId("story-cal-cell-4-evening")).getByTestId("story-cal-chip"));
    expect(onOpenEvent).toHaveBeenCalledTimes(1);
    expect(onOpenEvent.mock.calls[0]).toEqual(["ev3"]);
  });
});

// ── Assign from an empty cell (§5 popover / §8 sheet) ─────────────────────────

describe("StoryCalendarView — assigning an undated event", () => {
  it("desktop: the «+» opens the popover with the caption + the undated pending options; picking one PUTs the plan with the `at` stamp", async () => {
    const view = await mountCalendar({ branchId: "b-assign" });
    // The plus exists only on empty open cells with undated pending events.
    fireEvent.click(view.getByTestId("story-cal-plus-4-morning"));
    const popper = await waitFor(() => {
      const el = document.body.querySelector("[data-radix-popper-content-wrapper]");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(popper.textContent).toContain("story_cal_assign_title");
    const option = within(popper).getByTestId("story-cal-assign-option");
    expect(option.getAttribute("data-task-id")).toBe("ev4");
    expect(popper.textContent).toContain("House rules");
    fireEvent.click(option);
    await waitFor(() => expect(planPuts).toHaveLength(1));
    const saved = planPuts[0]!.body.tasks.find((task) => task.id === "ev4");
    expect(saved?.at).toEqual({ day: 4, part: "morning" });
    // The other tasks ride unchanged.
    expect(planPuts[0]!.body.tasks.find((task) => task.id === "ev3")?.at).toEqual({ day: 4, part: "evening" });
  });

  it("phone (§8): the «+» opens the ActionSheet with the caption + «Отмена»; picking assigns the same write", async () => {
    isMobile = true;
    const view = await mountCalendar({ branchId: "b-sheet" });
    fireEvent.click(view.getByTestId("story-cal-plus-4-morning"));
    // The sheet (a BottomSheet in happy-dom) carries the caption + options
    // (the sheet popup is the `.glass-blur` container — BottomSheet.test's
    // own selector).
    const sheet = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".glass-blur");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(sheet.textContent).toContain("story_cal_assign_title");
    expect(sheet.textContent).toContain("House rules");
    expect(sheet.textContent).toContain("cancel");
    // The ActionSheet rows are the shared primitive's (its label is the row).
    const option = within(sheet).getByText("House rules").closest("button");
    expect(option).not.toBeNull();
    fireEvent.click(option!);
    await waitFor(() => expect(planPuts).toHaveLength(1));
    expect(planPuts[0]!.body.tasks.find((task) => task.id === "ev4")?.at).toEqual({ day: 4, part: "morning" });
  });
});

// ── The undated list + the injection line ──────────────────────────────────────

describe("StoryCalendarView — the undated list + injection (§5/§8)", () => {
  it("the undated events list below the grid, in plan order with status glyphs", async () => {
    const view = await mountCalendar({ branchId: "b-undated" });
    const list = view.getByTestId("story-cal-undated-list");
    expect(view.getByTestId("story-cal-undated-title").textContent).toContain("story_cal_undated_title");
    const titles = [...list.querySelectorAll("li")].map((li) => li.lastElementChild?.textContent);
    expect(titles).toEqual(["The fridge raid", "House rules"]);
    expect(list.querySelectorAll("li").length).toBe(2);
  });

  it("scene injection off: the muted line under the header; on: no line", async () => {
    seed({ injectLastN: 0, messages: [msg("m1", { rec: record("m1-v0", { story_day: 3, story_time: "evening" }) })] });
    plansByBranch.set("b-inject", EMPTY_PLAN);
    const view = render(<StoryCalendarView chatId="chat-1" branchId="b-inject" locked={false} onOpenEvent={onOpenEvent} />);
    await waitFor(() => expect(view.getByTestId("story-cal-header")).toBeDefined());
    expect(view.getByTestId("story-cal-inject-off").textContent).toContain("story_cal_inject_off");
    view.unmount();

    const view2 = await mountCalendar({ branchId: "b-inject2" });
    expect(view2.queryByTestId("story-cal-inject-off")).toBeNull();
  });
});
