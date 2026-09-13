import type { ProviderErrorCategory } from "@vibe-tavern/api-contracts";

export type RpcResponse = { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> };

/** Shape of an error response body returned by the API. */
export interface RpcErrorBody {
  error?: string | { message?: string; code?: string; details?: { category?: ProviderErrorCategory } };
}

/** Success body of a Hono RPC response: error-status variants are dropped. */
type RpcBody<R> = R extends { ok: false } ? never : R extends { json(): Promise<infer T> } ? T : never;

/** Success body of an RPC endpoint method, e.g. `RpcData<typeof client.api.scripts.all.$get>`. */
export type RpcData<F extends (...args: never[]) => Promise<RpcResponse>> = RpcBody<Awaited<ReturnType<F>>>;

export async function unwrapRpc<R extends RpcResponse>(response: R): Promise<RpcBody<R>> {
  if (!response.ok) {
    throw await unwrapError(response);
  }
  return response.json() as Promise<RpcBody<R>>;
}

/** Sentinel for a 422 vision_not_supported body (top-level `type` — the
 *  chat message routes' typed-error envelope). use-chat-controller branches
 *  on this instead of showing a raw "Request failed: 422". */
const TYPED_ERROR_SENTINELS: Record<string, string> = {
  vision_not_supported: "VISION_NOT_SUPPORTED",
  voice_transcribe_unavailable: "VOICE_TRANSCRIBE_UNAVAILABLE",
};

export async function unwrapError(response: RpcResponse): Promise<Error> {
  const errorBody = await response.json().catch(() => null) as RpcErrorBody | null;
  const error = errorBody?.error;
  if (error && typeof error === "object" && error.code === "VISION_NOT_SUPPORTED") {
    return new Error("VISION_NOT_SUPPORTED");
  }
  // Typed 422 bodies from the chat message routes carry the discriminator in
  // a top-level `type` field ({ type, message, attachments }).
  const typed = (errorBody as { type?: unknown } | null)?.type;
  if (typeof typed === "string" && typed in TYPED_ERROR_SENTINELS) {
    return new Error(TYPED_ERROR_SENTINELS[typed]);
  }
  const message = typeof error === "string" ? error : error?.message || `Request failed: ${response.status}`;
  return new Error(message);
}
