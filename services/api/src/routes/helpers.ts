// Helper shared between route files

export async function readOptionalJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return {};
  }
  const text = await request.text();
  return text.trim() ? JSON.parse(text) : {};
}
