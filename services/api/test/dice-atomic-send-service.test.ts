import { describe, it, expect, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { DiceBindError } from "@vibe-tavern/db";
import type { ChatId } from "@vibe-tavern/domain";

// DICE-B10 (Wave B4 unit 1) — chat-application-service boundary. The db-level
// test (packages/db/test/dice-atomic-send.test.ts) pins every atomic-bind
// invariant at the store boundary. This complementary test pins the THREADING:
// `ChatApplicationService.appendUserMessage` selects the dice-aware atomic path
// when `diceCommit` is present and the unchanged `addMessage` path when absent,
// and a stale revision propagates as a thrown error (no message committed).

const tmpDirs: string[] = [];

async function setup(): Promise<{
  chatApp: import("../src/domain/chat/chat-application-service.js").ChatApplicationService;
  diceRolls: import("@vibe-tavern/db").DiceRollStore;
  messages: import("@vibe-tavern/db").MessageStore;
  chatId: ChatId;
  branchId: string;
}> {
  const tmpDir = resolve(tmpdir(), "vt-dice-b10-svc-" + crypto.randomUUID().slice(0, 8));
  tmpDirs.push(tmpDir);
  await mkdir(resolve(tmpDir, "data"), { recursive: true });
  const stores = await createRuntimeStore(resolve(tmpDir, "data"));
  await Promise.all([
    stores.personas.ensureDefault(),
    stores.presets.ensureDefault(),
    stores.uiSettings.ensureDefaults(),
  ]);
  const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
  const created = await runtime.character.createFromScratch({
    name: "DiceProbe",
    description: "a probe",
    firstMessage: "Hi!",
  });
  const chatId = created.activeChatId;
  const chat = await stores.chats.getById(chatId);
  const branchId = chat!.activeBranchId;
  return { chatApp: runtime.chatApp, diceRolls: stores.diceRolls, messages: stores.messages, chatId, branchId };
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

function rollInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req_svc",
    actorType: "persona",
    actorId: "persona_1",
    actorLabel: "Player",
    scriptId: "script_1",
    scriptLabel: "Fate Die",
    scriptRevision: 1,
    checkId: "fate_check",
    checkLabel: "Fate Roll",
    notation: "4dF",
    faceShape: "dF",
    resolution: "narrative",
    mode: "normal",
    attemptsJson: JSON.stringify([{ attemptId: "a1", faces: [1, 0, -1, 1], modifier: 0, subtotal: 1, total: 1 }]),
    finalJson: null,
    ...overrides,
  };
}

describe("DICE-B10 chat-application-service — diceCommit threading", () => {
  it("threads diceCommit into the atomic bind (message + bind in one transaction)", async () => {
    const { chatApp, diceRolls, chatId, branchId } = await setup();
    // A normal roll materializes the lane at revision 1.
    await diceRolls.createRoll({
      chatId: chatId as string, branchId, mode: "normal",
      ...rollInput({ requestId: "req_thread" }),
    });

    const message = await chatApp.appendUserMessage(chatId, {
      content: "roll please",
      mode: "reply",
      diceCommit: { mode: "normal", pendingRevision: 1 },
    });

    expect(message.role).toBe("user");
    // The roll is bound to the just-created message — proving the service bound
    // the lane atomically with the user-message insert.
    const bound = await diceRolls.getRollsForMessage(message.id);
    expect(bound.length).toBe(1);
    expect(bound[0]!.boundMessageId).toBe(message.id);
  });

  it("keeps the no-Dice path unchanged when diceCommit is absent (characterization)", async () => {
    const { chatApp, diceRolls, chatId, branchId } = await setup();
    const message = await chatApp.appendUserMessage(chatId, { content: "plain send", mode: "reply" });
    expect(message.role).toBe("user");
    expect(message.content).toBe("plain send");
    // No dice lane created or touched by the no-Dice path (revision stays 0).
    const pending = await diceRolls.listPending(chatId as string, branchId);
    expect(pending.normal.revision).toBe(0);
    expect(pending.normal.rolls.length).toBe(0);
  });

  it("propagates a stale revision as a thrown error and commits no message", async () => {
    const { chatApp, diceRolls, messages, chatId, branchId } = await setup();
    await diceRolls.createRoll({
      chatId: chatId as string, branchId, mode: "normal",
      ...rollInput({ requestId: "req_stale_svc" }),
    }); // revision now 1

    await expect(
      chatApp.appendUserMessage(chatId, {
        content: "should not persist",
        mode: "reply",
        diceCommit: { mode: "normal", pendingRevision: 0 }, // stale
      }),
    ).rejects.toBeInstanceOf(DiceBindError);

    // Nothing committed — the atomic guarantee surfaces at the service boundary too.
    // (createFromScratch seeded one greeting message; a failed send adds none.)
    const msgs = await messages.getMessages(branchId);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).not.toBe("user");
  });
});
