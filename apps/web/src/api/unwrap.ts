import type { ProviderErrorCategory } from "@vibe-tavern/api-contracts";

export type RpcResponse = { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> };

/** Shape of an error response body returned by the API. */
export interface RpcErrorBody {
  error?: string | { message?: string; code?: string; details?: { category?: ProviderErrorCategory } };
}

export async function unwrapRpc<T>(response: RpcResponse): Promise<T> {
  if (!response.ok) {
    throw await unwrapError(response);
  }
  return response.json() as Promise<T>;
}

export async function unwrapError(response: RpcResponse): Promise<Error> {
  const errorBody = await response.json().catch(() => null) as RpcErrorBody | null;
  const error = errorBody?.error;
  if (error && typeof error === "object" && error.code === "VISION_NOT_SUPPORTED") {
    return new Error("VISION_NOT_SUPPORTED");
  }
  const message = typeof error === "string" ? error : error?.message || `Request failed: ${response.status}`;
  return new Error(message);
}
