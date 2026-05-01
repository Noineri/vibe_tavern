import type { Config } from "drizzle-kit";

export default {
  schema: "./src/drizzle-schema.ts",
  out: "./drizzle-generated",
  dialect: "sqlite",
} satisfies Config;
