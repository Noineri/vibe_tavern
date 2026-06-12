export type RpcResponse = { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> };

export async function unwrapRpc<T>(response: RpcResponse): Promise<T> {
  if (!response.ok) {
    throw await unwrapError(response);
  }
  return response.json() as Promise<T>;
}

export async function unwrapError(response: RpcResponse): Promise<Error> {
  const errorBody = await response.json().catch(() => null) as { error?: string | { message?: string; code?: string } } | null;
  if (errorBody?.error && typeof errorBody.error === "object" && (errorBody.error as any).code === "VISION_NOT_SUPPORTED") {
    return new Error("VISION_NOT_SUPPORTED");
  }
  const error = errorBody?.error;
  const message = typeof error === "string" ? error : error?.message || `Request failed: ${response.status}`;
  return new Error(message);
}
