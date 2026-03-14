import { Hono } from "hono";
import {
  checkWebUIReleaseUpdate,
  getWebUISettings,
  updateWebUIDistFromRelease,
  updateWebUISettings,
} from "../system";

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

  app.get("/update/check", async (c) => {
    const force = c.req.query("force") === "1";
    const data = await checkWebUIReleaseUpdate(force);
    return c.json({ ok: true, data });
  });

  app.post("/update/apply", async (c) => {
    const data = await updateWebUIDistFromRelease();
    return c.json({ ok: true, data });
  });

  return app;
}
