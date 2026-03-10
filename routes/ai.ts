import { Hono } from "hono";
import { logger } from "mioki";
import { getChatConfig, updateChatConfig } from "../system";
import aiService from "../../ai";

export function createAIRoutes() {
  const app = new Hono();

  app.get("/base", (c) =>
    c.json({ ok: true, data: getChatConfig("base.json") }),
  );
  app.put("/base", async (c) => {
    const body = await c.req.json();
    logger.info(`[webui-action] ai.base.update`);
    return c.json({ ok: true, data: updateChatConfig("base.json", body) });
  });

  app.get("/personalization", (c) =>
    c.json({ ok: true, data: getChatConfig("personalization.json") }),
  );
  app.put("/personalization", async (c) => {
    const body = await c.req.json();
    logger.info(`[webui-action] ai.personalization.update`);
    return c.json({
      ok: true,
      data: updateChatConfig("personalization.json", body),
    });
  });

  app.get("/settings", (c) =>
    c.json({ ok: true, data: getChatConfig("settings.json") }),
  );
  app.put("/settings", async (c) => {
    const body = await c.req.json();
    logger.info(`[webui-action] ai.settings.update`);
    return c.json({
      ok: true,
      data: updateChatConfig("settings.json", body),
    });
  });

  app.get("/instances", (c) => {
    const names = aiService?.api?.list?.() ?? [];
    return c.json({ ok: true, data: names });
  });

  app.post("/instances", async (c) => {
    const body = await c.req.json();
    logger.info(`[webui-action] ai.instance.create`, {
      name: body?.name,
      apiUrl: body?.apiUrl,
      modelType: body?.modelType,
    });
    if (!aiService?.api?.create) {
      return c.json({ ok: false, error: "AI_SERVICE_UNAVAILABLE" }, 503);
    }

    await aiService.api.create({
      name: body.name,
      apiUrl: body.apiUrl,
      apiKey: body.apiKey,
      modelType: body.modelType || "text",
    });
    return c.json({ ok: true, data: aiService.api.list() });
  });

  app.delete("/instances/:name", (c) => {
    const name = c.req.param("name");
    logger.info(`[webui-action] ai.instance.remove`, { name });
    const ok = aiService?.api?.remove?.(name);
    return c.json({ ok: Boolean(ok) });
  });

  app.post("/default/:name", (c) => {
    const name = c.req.param("name");
    logger.info(`[webui-action] ai.instance.set-default`, { name });
    const ok = aiService?.api?.setDefault?.(name);
    return c.json({ ok: Boolean(ok) });
  });

  app.get("/skills", (c) => {
    const skills = aiService?.api?.getAllSkills?.();
    const tools = aiService?.api?.getAllTools?.();
    return c.json({
      ok: true,
      data: {
        skills: skills ? Array.from(skills.keys()) : [],
        tools: tools ? Array.from(tools.keys()) : [],
      },
    });
  });

  return app;
}
