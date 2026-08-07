import { Database } from "bun:sqlite";
import { resolveQuotaAdapter } from "./services/api/src/domain/quota/quota-registry.js";
import { isPollableCapability } from "./services/api/src/domain/quota/quota-capability-types.js";

const db = new Database("./data/vibe-tavern.db", { readonly: true });
const rows = db.query("SELECT id, name, provider_preset, endpoint, api_key FROM provider_profiles").all() as Array<{
  id: string; name: string; provider_preset: string; endpoint: string; api_key: string | null;
}>;

for (const row of rows) {
  if (!row.api_key) continue;
  const capability = resolveQuotaAdapter(row.provider_preset, row.endpoint);
  console.log("\n========", row.name, "|", row.provider_preset, "|", row.endpoint);
  if (!isPollableCapability(capability)) { console.log("  not pollable:", capability.reason); continue; }
  let specs;
  try { specs = capability.buildRequests(row.endpoint, row.api_key); }
  catch (error) { console.log("  buildRequests THREW:", error); continue; }
  const results: Array<{ spec: typeof specs[number]; json: unknown }> = [];
  for (const spec of specs) {
    console.log("  ->", spec.method, spec.url);
    try {
      const response = await fetch(spec.url, {
        method: spec.method, headers: spec.headers,
        ...(spec.body === undefined ? {} : { body: spec.body }),
      });
      const text = await response.text();
      console.log("    status:", response.status);
      console.log("    body:", text.slice(0, 2000));
      try { results.push({ spec, json: JSON.parse(text) }); } catch { console.log("    (not JSON)"); }
    } catch (error) { console.log("    fetch THREW:", error); }
  }
  if (results.length === specs.length) {
    try { console.log("  normalize OK:", JSON.stringify(capability.normalize(results))); }
    catch (error) {
      console.log("  normalize THREW:", error instanceof Error ? error.message : error);
      if (error && typeof error === "object" && "issues" in error) console.log("  issues:", JSON.stringify((error as { issues: unknown }).issues));
    }
  }
}
