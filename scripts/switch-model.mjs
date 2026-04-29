import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const db = new DatabaseSync(resolve(import.meta.dirname, "..", "data", "app.sqlite"));
db.prepare(`UPDATE provider_profiles SET default_model = ? WHERE id = ?`).run(
  "zai-org/glm-5.1",
  "provider_1777401913974_8czp8x",
);
const row = db.prepare(`SELECT default_model FROM provider_profiles WHERE id = ?`).get(
  "provider_1777401913974_8czp8x",
);
console.log("Updated model:", row.default_model);
db.close();
