import { Hono } from "hono";
import { logger } from "mioki";
import {
  getMiokuConfig,
  updateMiokuConfig,
  getAvailablePlugins,
} from "../system";

export function createConfigRoutes() {
  const app = new Hono();

  app.get("/mioku", (c) => {
    const data = getMiokuConfig();
    return c.json({ ok: true, data });
  });

  app.put("/mioku", async (c) => {
    const body = await c.req.json();
    logger.info(`[webui-action] config.mioku.update`, {
      owners: body?.owners?.length,
      admins: body?.admins?.length,
      napcat: body?.napcat?.length,
      plugins: body?.plugins?.length,
    });
    const data = updateMiokuConfig(body);
    return c.json({ ok: true, data });
  });

  app.get("/plugins/available", (c) => {
    const data = getAvailablePlugins();
    return c.json({ ok: true, data });
  });

  return app;
}
