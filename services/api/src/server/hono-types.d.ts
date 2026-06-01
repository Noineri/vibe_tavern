/**
 * Extend Hono's ContextVariables to include the real remote IP
 * detected by the Bun server middleware in app-factory.ts.
 */
import type { Hono } from "hono";

declare module "hono" {
  interface ContextVariableMap {
    remoteIp: string;
  }
}
