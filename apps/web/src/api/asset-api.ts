import { getGatewayBaseUrl, getMobileToken } from "./client.js";

export async function uploadAsset(file: File): Promise<{ assetId: string; url: string }> {
  const formData = new FormData();
  formData.append("file", file);
  const baseUrl = getGatewayBaseUrl();
  const token = getMobileToken();
  const response = await fetch(`${baseUrl}/api/assets/upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: formData,
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Asset upload failed (${response.status}): ${errorBody}`);
  }
  return response.json();
}
