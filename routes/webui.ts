import { Hono } from "hono";
import { getWebUISettings, updateWebUISettings } from "../system";

export function createWebUISettingsRoutes() {
  const app = new Hono();

  app.get("/", (c) => {
    const data = getWebUISettings();
    return c.json({ ok: true, data });
  });

  app.put("/", async (c) => {
    const body = await c.req.json();
    const data = updateWebUISettings(body ?? {});
    return c.json({ ok: true, data });
  });

  return app;
}
