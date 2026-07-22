/**
 * Dice API client (DICE_SYSTEM_FRONTEND_PLAN, Wave F1 / DICE-F1_rpc_client).
 *
 * Thin Hono-RPC client for the seven chat-scoped Dice endpoints under
 * `/api/chats/:chatId/dice`, mirroring the `script-api.ts` pattern. The client
 * is server-authoritative: it NEVER submits or fabricates dice faces or totals
 * — the roll request body carries only ids, actor, mode, and a DB-unique
 * `requestId` idempotency key; the server rolls.
 */
import { client } from "./client.js";
import type { RpcResponse } from "./unwrap.js";
import type {
  DiceDefinitionsResponse,
  DicePendingState,
  DiceRollRequest,
  DiceRollSnapshot,
} from "./types.js";

/**
 * Structured Dice API error. The shared `unwrapError` collapses the backend's
 * `{ error: { kind, message, details } }` body into a plain `Error`, discarding
 * `details.code` — which the dice-store needs to distinguish `409
 * stale_revision` / `409 attempt` from other failures (Wave F2). This preserves
 * the HTTP status and the structured code without touching the shared helper.
 */
export class DiceApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "DiceApiError";
    this.status = status;
    this.code = code;
  }
}

async function unwrapDice<T>(response: RpcResponse): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;
  const body = (await response.json().catch(() => null)) as
    | { error?: { message?: string; details?: { code?: string } } }
    | null;
  const err = body?.error;
  throw new DiceApiError(response.status, err?.message ?? `Request failed: ${response.status}`, err?.details?.code);
}

/** GET /definitions — enabled Dice scripts + their resolvable check descriptors. */
export async function getDiceDefinitions(chatId: string): Promise<DiceDefinitionsResponse> {
  const response = await client.api.chats[":chatId"].dice.definitions.$get({ param: { chatId } });
  return unwrapDice<DiceDefinitionsResponse>(response);
}

/** GET /pending — both lanes' state for one branch. */
export async function getDicePending(chatId: string, branchId: string): Promise<DicePendingState> {
  const response = await client.api.chats[":chatId"].dice.pending.$get({ param: { chatId }, query: { branchId } });
  return unwrapDice<DicePendingState>(response);
}

/** POST /roll — execute a server-authoritative roll (idempotent on `requestId`). */
export async function rollDice(chatId: string, body: DiceRollRequest): Promise<DiceRollSnapshot> {
  const response = await client.api.chats[":chatId"].dice.roll.$post({ param: { chatId }, json: body });
  return unwrapDice<DiceRollSnapshot>(response);
}

/** DELETE /rolls/:rollId — remove one Normal pending result. */
export async function removeDiceRoll(chatId: string, rollId: string): Promise<void> {
  const response = await client.api.chats[":chatId"].dice.rolls[":rollId"].$delete({ param: { chatId, rollId } });
  await unwrapDice<unknown>(response);
}

/** DELETE /pending — clear the Normal lane. */
export async function clearDiceLane(chatId: string, branchId: string): Promise<void> {
  const response = await client.api.chats[":chatId"].dice.pending.$delete({ param: { chatId }, query: { branchId } });
  await unwrapDice<unknown>(response);
}

/** PATCH /rolls/:rollId — Immersive include/exclude-from-binding (undo via `true`). */
export async function setDiceRollIncluded(chatId: string, rollId: string, included: boolean): Promise<void> {
  const response = await client.api.chats[":chatId"].dice.rolls[":rollId"].$patch({ param: { chatId, rollId }, json: { included } });
  await unwrapDice<unknown>(response);
}

/** POST /rolls/:rollId/choose — finalize a `choose`-policy attempt. */
export async function chooseDiceAttempt(chatId: string, rollId: string, attemptId: string): Promise<void> {
  const response = await client.api.chats[":chatId"].dice.rolls[":rollId"].choose.$post({ param: { chatId, rollId }, json: { attemptId } });
  await unwrapDice<unknown>(response);
}
