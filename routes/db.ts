import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  deleteMessagesByRange,
  exportData,
  getPluginConfigs,
  getStats,
  importDataFromJson,
  listMemeTree,
  listTables,
  queryMessages,
  savePluginConfig,
  updateMessage,
} from "../database";
import { CHAT_DATA_DIR } from "../utils";

export function createDBRoutes() {
  const app = new Hono();

  app.get("/tables", (c) =>
    c.json({ ok: true, data: listTables() }),
  );

  app.get("/messages", (c) => {
    const q = c.req.query();
    const data = queryMessages({
      table: q.table,
      keyword: q.keyword,
      userId: q.userId,
      sessionId: q.sessionId,
      startTime: q.startTime ? Number(q.startTime) : undefined,
      endTime: q.endTime ? Number(q.endTime) : undefined,
      page: q.page ? Number(q.page) : 1,
      pageSize: q.pageSize ? Number(q.pageSize) : 20,
    });
    return c.json({ ok: true, data });
  });

  app.get("/stats", (c) =>
    c.json({ ok: true, data: getStats() }),
  );

  app.put("/message", async (c) => {
    const body = await c.req.json();
    return c.json({ ok: true, data: updateMessage(body) });
  });

  app.post("/cleanup", async (c) => {
    const body = await c.req.json();
    return c.json({ ok: true, data: deleteMessagesByRange(body) });
  });

  app.get("/export", (c) => {
    const format = (c.req.query("format") === "csv" ? "csv" : "json") as
      | "json"
      | "csv";
    const result = exportData(format);
    return c.json({ ok: true, data: result });
  });

  app.post("/import", async (c) => {
    const form = await c.req.formData();
    const file = form.get("file") as File | null;
    if (!file) {
      return c.json({ ok: false, error: "FILE_REQUIRED" }, 400);
    }
    const result = importDataFromJson(file as any);
    return c.json({ ok: true, data: result });
  });

  return app;
}

export function createPluginConfigRoutes() {
  const app = new Hono();

  app.get("/:name", (c) => {
    const name = c.req.param("name");
    return c.json({ ok: true, data: getPluginConfigs(name) });
  });

  app.put("/:name/:config", async (c) => {
    const pluginName = c.req.param("name");
    const configName = c.req.param("config");
    const body = await c.req.json();
    savePluginConfig(pluginName, configName, body);
    return c.json({ ok: true });
  });

  return app;
}

export function createMemeRoutes() {
  const app = new Hono();

  app.get("/tree", (c) =>
    c.json({ ok: true, data: listMemeTree() }),
  );

  app.post("/upload", async (c) => {
    const form = await c.req.formData();
    const character = String(form.get("character") || "unknown");
    const emotion = String(form.get("emotion") || "default");
    const file = form.get("file") as File | null;
    if (!file) {
      return c.json({ ok: false, error: "FILE_REQUIRED" }, 400);
    }

    const dir = path.join(CHAT_DATA_DIR, "meme", character, emotion);
    fs.mkdirSync(dir, { recursive: true });

    const fileName = file.name || `upload-${Date.now()}.png`;
    const filePath = path.join(dir, fileName);
    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    return c.json({ ok: true, path: path.relative(process.cwd(), filePath) });
  });

  app.delete("/", async (c) => {
    const body = await c.req.json();
    const filePath = path.join(process.cwd(), String(body.path || ""));
    if (!fs.existsSync(filePath)) {
      return c.json({ ok: false, error: "NOT_FOUND" }, 404);
    }
    fs.unlinkSync(filePath);
    return c.json({ ok: true });
  });

  return app;
}
