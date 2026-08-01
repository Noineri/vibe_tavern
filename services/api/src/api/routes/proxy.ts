import { Hono } from "hono";
import type { ProxyRuntimeApi } from "../contract/runtime-api.js";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";

export function createProxyRoutes(runtime: ProxyRuntimeApi) {
  return new Hono()
    .get("/api/proxies", async (c) => {
      return c.json(await runtime.listProxies());
    })
    .post("/api/proxies", zValidator("json", schemas.saveProxySchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.saveProxy(body), 201);
    })
    .get("/api/proxies/default", async (c) => {
      return c.json(await runtime.getDefaultProxy());
    })
    .put("/api/proxies/default", zValidator("json", schemas.setDefaultProxySchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.setDefaultProxy(body));
    })
    .patch("/api/proxies/reorder", zValidator("json", schemas.reorderProxiesSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.reorderProxies(body.updates));
    })
    .get("/api/proxies/:proxyId", async (c) => {
      return c.json(await runtime.getProxy(c.req.param("proxyId")));
    })
    .patch("/api/proxies/:proxyId", zValidator("json", schemas.updateProxySchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.updateProxy(c.req.param("proxyId"), body));
    })
    .delete("/api/proxies/:proxyId", async (c) => {
      await runtime.deleteProxy(c.req.param("proxyId"));
      return c.json({ ok: true });
    })
  ;
}
