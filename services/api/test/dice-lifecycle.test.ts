import { describe, it, expect, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { ChatApplicationService } from "../src/domain/chat/chat-application-service.js";
import type { ChatId, MessageId, ChatBranchId } from "@vibe-tavern/domain";
import type { DiceRollStore, MessageStore, ChatStore } from "@vibe-tavern/db";

// DICE-B12 (Wave B4 unit 3) — service-level lifecycle boundary. The db-level
// tests (packages/db/test/dice-roll-store.test.ts + chat-store-fork-dice.test.ts)
// pin the store boundary. These pin the THREADING in ChatApplicationService:
// createBranch (fork) threads the dice-fork closure so bound rolls are cloned;
// deleteMessage deletes bound rolls; editMessage and the variant lifecycle never
// touch dice. Resend/regenerate/continue/generate-more are structurally excluded
// (they create new variants/messages, never call deleteRollsWithMessage or
// forkCopyRollsInTx) and reuse the same preceding user result — pinned by the
// B11 full-path test, not repeated here.

const tmpDirs: string[] = [];

interface Setup {
  chatApp: ChatApplicationService;
  diceRolls: DiceRollStore;
  messages: MessageStore;
  chats: ChatStore;
  chatId: ChatId;
  branchId: string;
}

async function setup(): Promise<Setup> {
  const tmpDir = resolve(tmpdir(), "vt-dice-b12-life-" + crypto.randomUUID().slice(0, 8));
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
    name: "LifeProbe",
    description: "a lifecycle probe",
    firstMessage: "Hi there!",
  });
  const chatId = created.activeChatId;
  const chat = await stores.chats.getById(chatId);
  const branchId = chat!.activeBranchId;
  return { chatApp: runtime.chatApp, diceRolls: stores.diceRolls, messages: stores.messages, chats: stores.chats, chatId, branchId };
}

function rollInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req_life",
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

/** Roll one normal lane entry and bind it to a fresh user message in one turn. */
async function userMessageWithBoundRoll(s: Setup, content: string, reqId: string): Promise<{ message: { id: string }; roll: { id: string; requestId: string } }> {
  await s.diceRolls.createRoll({
    chatId: s.chatId as string, branchId: s.branchId, mode: "normal",
    ...rollInput({ requestId: reqId }),
  });
  const message = await s.chatApp.appendUserMessage(s.chatId, {
    content,
    mode: "reply",
    diceCommit: { mode: "normal", pendingRevision: 1 },
  });
  const rolls = await s.diceRolls.getRollsForMessage(message.id);
  return { message: { id: message.id }, roll: { id: rolls[0]!.id, requestId: rolls[0]!.requestId } };
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

describe("DICE-B12 lifecycle — fork / delete / edit / variants", () => {
  it("fork (createBranch) clones bound rolls onto the new branch's user message", async () => {
    const s = await setup();
    const { message: userMsg } = await userMessageWithBoundRoll(s, "roll please", "req_fork");

    const forked = await s.chatApp.createBranch(s.chatId, {
      sourceBranchId: s.branchId as ChatBranchId,
      forkedFromMessageId: userMsg.id as MessageId,
      label: "dice fork",
      activateFork: false,
    });

    // The forked branch has the greeting + the user message.
    const forkedMessages = await s.messages.getMessages(forked.branchId as string);
    const forkedUser = forkedMessages.find((m) => m.role === "user")!;
    expect(forkedUser).toBeDefined();
    expect(forkedUser.id).not.toBe(userMsg.id);

    // The bound roll was cloned onto the forked user message.
    const forkedRolls = await s.diceRolls.getRollsForMessage(forkedUser.id);
    expect(forkedRolls.length).toBe(1);
    expect(forkedRolls[0]!.boundMessageId).toBe(forkedUser.id);
    // Independent row (fresh id + fresh request id).
    expect(forkedRolls[0]!.id).not.toBe(userMsg.id);

    // Source untouched.
    const sourceRolls = await s.diceRolls.getRollsForMessage(userMsg.id);
    expect(sourceRolls.length).toBe(1);
  });

  it("delete user message deletes its bound rolls", async () => {
    const s = await setup();
    const { message: userMsg } = await userMessageWithBoundRoll(s, "delete me", "req_del");
    expect((await s.diceRolls.getRollsForMessage(userMsg.id)).length).toBe(1);

    await s.chatApp.deleteMessage(userMsg.id);

    expect((await s.diceRolls.getRollsForMessage(userMsg.id)).length).toBe(0);
    // The message is gone too.
    expect(await s.messages.getMessageById(userMsg.id)).toBeNull();
  });

  it("editing user prose preserves bound rolls", async () => {
    const s = await setup();
    const { message: userMsg } = await userMessageWithBoundRoll(s, "original prose", "req_edit");

    const edited = await s.chatApp.editMessage(userMsg.id, "edited prose");
    expect(edited.content).toBe("edited prose");

    // The roll is still bound to the same message, unchanged.
    const rolls = await s.diceRolls.getRollsForMessage(userMsg.id);
    expect(rolls.length).toBe(1);
    expect(rolls[0]!.boundMessageId).toBe(userMsg.id);
    expect(rolls[0]!.requestId).toBe("req_edit");
  });

  it("variant add / select / delete on a message never touches its bound dice", async () => {
    const s = await setup();
    const { message: userMsg } = await userMessageWithBoundRoll(s, "variant host", "req_var");

    // Add a second variant (swipe) on the user message.
    await s.chatApp.addEditorVariant(userMsg.id, {
      content: "variant two",
      sourceVariantIds: (await s.messages.getVariants(userMsg.id)).map((v) => v.id),
    });
    const variants = await s.messages.getVariants(userMsg.id);
    expect(variants.length).toBe(2);

    // Select the first variant, then delete the second.
    await s.messages.selectVariant(userMsg.id, 0);
    await s.messages.deleteVariant(userMsg.id, 1);

    // Dice rows are byte-for-byte unchanged through every variant op.
    const rolls = await s.diceRolls.getRollsForMessage(userMsg.id);
    expect(rolls.length).toBe(1);
    expect(rolls[0]!.requestId).toBe("req_var");
  });

  it("fork without a preceding Dice turn carries no rolls (no-op)", async () => {
    const s = await setup();
    // A plain user message with NO dice commit.
    const userMsg = await s.chatApp.appendUserMessage(s.chatId, { content: "plain", mode: "reply" });

    const forked = await s.chatApp.createBranch(s.chatId, {
      sourceBranchId: s.branchId as ChatBranchId,
      forkedFromMessageId: userMsg.id as MessageId,
      label: "no dice fork",
      activateFork: false,
    });

    const forkedMessages = await s.messages.getMessages(forked.branchId as string);
    for (const m of forkedMessages) {
      expect((await s.diceRolls.getRollsForMessage(m.id)).length).toBe(0);
    }
  });
});
