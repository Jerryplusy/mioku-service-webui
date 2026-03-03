import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "mioki";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import type { MiokuService } from "../../core/types";
import type {
  InstallRequest,
  RemoveRequest,
  UpdateRequest,
  WebUISettings,
} from "./types";
import { ensureAuthConfig, loginWithToken, requireAuth } from "./auth";
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
} from "./database";
import {
  getWebUISettings,
  getSystemOverview,
  installManagedPackage,
  listManagedPackages,
  updateChatConfig,
  updateManagedPackage,
  updateWebUISettings,
  checkUpdate,
  getChatConfig,
  removeManagedPackage,
} from "./system";
import { CHAT_CONFIG_DIR, CHAT_DATA_DIR, LOGS_DIR, WEBUI_DIST } from "./utils";
import aiService from "../ai";

export interface WebUIServiceAPI {
  getSettings(): WebUISettings;
}

class WebUIRuntime {
  private app = new Hono();
  private server: ReturnType<typeof serve> | null = null;

  private logAction(action: string, payload?: unknown): void {
    const text = payload ? ` | ${JSON.stringify(payload)}` : "";
    logger.info(`[webui-action] ${action}${text}`);
  }

  public initRoutes(): void {
    const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({
      app: this.app,
    });

    this.app.onError((err, c) => {
      logger.error(`webui-service API error: ${err.message}`);
      return c.json(
        {
          ok: false,
          error: err.message || "INTERNAL_SERVER_ERROR",
        },
        500,
      );
    });

    this.app.notFound((c) => {
      if (c.req.path.startsWith("/api/")) {
        return c.json({ ok: false, error: "API_NOT_FOUND" }, 404);
      }
      return c.text("Not Found", 404);
    });

    this.app.get("/api/health", (c) => c.json({ ok: true, service: "webui" }));

    this.app.post("/api/auth/login", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      this.logAction("auth.login.attempt");
      const result = loginWithToken(String(body?.token || ""));
      if (!result.ok) {
        this.logAction("auth.login.failed");
        return c.json({ ok: false, error: "TOKEN_INVALID" }, 401);
      }
      this.logAction("auth.login.success", { expiresAt: result.expiresAt });
      return c.json({ ok: true, expiresAt: result.expiresAt });
    });

    this.app.use("/api/*", async (c, next) => {
      if (c.req.path === "/api/health" || c.req.path === "/api/auth/login") {
        return next();
      }
      return requireAuth(c, next);
    });

    this.app.get("/api/settings", (c) => {
      const settings = getWebUISettings();
      return c.json({ ok: true, data: settings });
    });

    this.app.put("/api/settings", async (c) => {
      const body = await c.req.json();
      this.logAction("settings.update", body ?? {});
      const settings = updateWebUISettings(body ?? {});
      return c.json({ ok: true, data: settings });
    });

    this.app.get("/api/overview", (c) => {
      return getSystemOverview().then((data) => c.json({ ok: true, data }));
    });

    this.app.get("/api/plugins", (c) =>
      c.json({ ok: true, data: listManagedPackages("plugin") }),
    );
    this.app.get("/api/services", (c) =>
      c.json({ ok: true, data: listManagedPackages("service") }),
    );

    this.app.post("/api/manage/install", async (c) => {
      const body = (await c.req.json()) as InstallRequest;
      this.logAction("manage.install", {
        target: body.target,
        repoUrl: body.repoUrl,
        packageManager: body.packageManager,
      });
      const result = await installManagedPackage(body);
      return c.json(result);
    });

    this.app.post("/api/manage/check-update", async (c) => {
      const body = (await c.req.json()) as {
        name: string;
        target: "plugin" | "service";
      };
      this.logAction("manage.check-update", body);
      const result = await checkUpdate(body.name, body.target);
      return c.json(result);
    });

    this.app.post("/api/manage/update", async (c) => {
      const body = (await c.req.json()) as UpdateRequest;
      this.logAction("manage.update", body);
      const result = await updateManagedPackage(body);
      return c.json(result);
    });

    this.app.post("/api/manage/remove", async (c) => {
      const body = (await c.req.json()) as RemoveRequest;
      this.logAction("manage.remove", body);
      const result = await removeManagedPackage(body);
      return c.json(result);
    });

    this.app.get("/api/ai/base", (c) =>
      c.json({ ok: true, data: getChatConfig("base.json") }),
    );
    this.app.put("/api/ai/base", async (c) => {
      const body = await c.req.json();
      this.logAction("ai.base.update");
      return c.json({ ok: true, data: updateChatConfig("base.json", body) });
    });

    this.app.get("/api/ai/personalization", (c) =>
      c.json({ ok: true, data: getChatConfig("personalization.json") }),
    );
    this.app.put("/api/ai/personalization", async (c) => {
      const body = await c.req.json();
      this.logAction("ai.personalization.update");
      return c.json({
        ok: true,
        data: updateChatConfig("personalization.json", body),
      });
    });

    this.app.get("/api/ai/settings", (c) =>
      c.json({ ok: true, data: getChatConfig("settings.json") }),
    );
    this.app.put("/api/ai/settings", async (c) => {
      const body = await c.req.json();
      this.logAction("ai.settings.update");
      return c.json({
        ok: true,
        data: updateChatConfig("settings.json", body),
      });
    });

    this.app.get("/api/ai/instances", (c) => {
      const names = aiService?.api?.list?.() ?? [];
      return c.json({ ok: true, data: names });
    });

    this.app.post("/api/ai/instances", async (c) => {
      const body = await c.req.json();
      this.logAction("ai.instance.create", {
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

    this.app.delete("/api/ai/instances/:name", (c) => {
      const name = c.req.param("name");
      this.logAction("ai.instance.remove", { name });
      const ok = aiService?.api?.remove?.(name);
      return c.json({ ok: Boolean(ok) });
    });

    this.app.post("/api/ai/default/:name", (c) => {
      const name = c.req.param("name");
      this.logAction("ai.instance.set-default", { name });
      const ok = aiService?.api?.setDefault?.(name);
      return c.json({ ok: Boolean(ok) });
    });

    this.app.get("/api/ai/skills", (c) => {
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

    this.app.get("/api/meme/tree", (c) =>
      c.json({ ok: true, data: listMemeTree() }),
    );

    this.app.post("/api/meme/upload", async (c) => {
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
      this.logAction("meme.upload", { character, emotion, fileName });

      return c.json({ ok: true, path: path.relative(process.cwd(), filePath) });
    });

    this.app.delete("/api/meme", async (c) => {
      const body = await c.req.json();
      const filePath = path.join(process.cwd(), String(body.path || ""));
      if (!fs.existsSync(filePath)) {
        return c.json({ ok: false, error: "NOT_FOUND" }, 404);
      }
      fs.unlinkSync(filePath);
      this.logAction("meme.delete", { path: body.path });
      return c.json({ ok: true });
    });

    this.app.get("/api/plugin-config/:name", (c) => {
      const name = c.req.param("name");
      return c.json({ ok: true, data: getPluginConfigs(name) });
    });

    this.app.put("/api/plugin-config/:name/:config", async (c) => {
      const pluginName = c.req.param("name");
      const configName = c.req.param("config");
      const body = await c.req.json();
      savePluginConfig(pluginName, configName, body);
      this.logAction("plugin-config.update", { pluginName, configName });
      return c.json({ ok: true });
    });

    this.app.get("/api/db/tables", (c) =>
      c.json({ ok: true, data: listTables() }),
    );

    this.app.get("/api/db/messages", (c) => {
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

    this.app.get("/api/db/stats", (c) =>
      c.json({ ok: true, data: getStats() }),
    );

    this.app.put("/api/db/message", async (c) => {
      const body = await c.req.json();
      this.logAction("db.message.update", {
        table: body?.table,
        idField: body?.idField,
        id: body?.id,
      });
      return c.json({ ok: true, data: updateMessage(body) });
    });

    this.app.post("/api/db/cleanup", async (c) => {
      const body = await c.req.json();
      this.logAction("db.cleanup", body);
      return c.json({ ok: true, data: deleteMessagesByRange(body) });
    });

    this.app.get("/api/db/export", (c) => {
      const format = (c.req.query("format") === "csv" ? "csv" : "json") as
        | "json"
        | "csv";
      this.logAction("db.export", { format });
      const result = exportData(format);
      return c.json({ ok: true, data: result });
    });

    this.app.post("/api/db/import", async (c) => {
      const form = await c.req.formData();
      const file = form.get("file") as File | null;
      if (!file) {
        return c.json({ ok: false, error: "FILE_REQUIRED" }, 400);
      }

      const backupDir = path.join(CHAT_DATA_DIR, "backup");
      fs.mkdirSync(backupDir, { recursive: true });
      const fullPath = path.join(backupDir, `${Date.now()}-${file.name}`);
      fs.writeFileSync(fullPath, Buffer.from(await file.arrayBuffer()));
      this.logAction("db.import", { fileName: file.name });

      const result = importDataFromJson(fullPath);
      return c.json({ ok: true, data: result });
    });

    this.app.get(
      "/api/ws/logs",
      upgradeWebSocket((c) => {
        let timer: NodeJS.Timeout | null = null;
        let lastPayload = "";

        return {
          onOpen: (event, ws) => {
            const latest = this.readLatestLogs(50);
            lastPayload = JSON.stringify(latest);
            ws.send(JSON.stringify({ type: "init", data: latest }));

            timer = setInterval(() => {
              const next = this.readLatestLogs(50);
              const payload = JSON.stringify(next);
              if (payload !== lastPayload) {
                lastPayload = payload;
                ws.send(JSON.stringify({ type: "update", data: next }));
              }
            }, 2000);
          },
          onMessage: (_event, ws) => {
            ws.send(JSON.stringify({ type: "heartbeat", at: Date.now() }));
          },
          onClose: () => {
            if (timer) {
              clearInterval(timer);
              timer = null;
            }
          },
        };
      }),
    );

    this.app.get(
      "/meme/*",
      serveStatic({
        root: process.cwd(),
        rewriteRequestPath: (p) => p.replace(/^\/meme\//, "data/chat/meme/"),
      }),
    );

    this.app.use("/assets/*", serveStatic({ root: WEBUI_DIST }));
    this.app.use("/favicon.ico", serveStatic({ root: WEBUI_DIST }));
    this.app.get("*", async (c) => {
      const indexPath = path.join(WEBUI_DIST, "index.html");
      if (!fs.existsSync(indexPath)) {
        return c.text(
          "WebUI frontend not built yet. Please run: npm run webui:build",
          503,
        );
      }
      const content = await fs.promises.readFile(indexPath, "utf-8");
      return c.html(content);
    });

    const settings = getWebUISettings();
    const server = serve({
      fetch: this.app.fetch,
      port: settings.port,
      hostname: settings.host,
    });
    this.server = server;
    injectWebSocket(server);
    logger.info(
      `webui-service 已启动: http://${settings.host}:${settings.port}`,
    );
  }

  public readLatestLogs(count: number): string[] {
    if (!fs.existsSync(LOGS_DIR)) {
      return [];
    }

    const files = fs
      .readdirSync(LOGS_DIR)
      .map((name) => ({
        name,
        fullPath: path.join(LOGS_DIR, name),
        mtimeMs: fs.statSync(path.join(LOGS_DIR, name)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const file = files[0];
    if (!file) {
      return [];
    }

    const lines = fs
      .readFileSync(file.fullPath, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean);
    return lines.slice(-count);
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

const runtime = new WebUIRuntime();

const webUIService: MiokuService = {
  name: "webui",
  version: "1.0.1",
  description: "Mioku WebUI 管理服务",
  api: {
    getSettings: () => getWebUISettings(),
  } as WebUIServiceAPI,

  async init() {
    ensureAuthConfig();
    fs.mkdirSync(CHAT_CONFIG_DIR, { recursive: true });
    fs.mkdirSync(CHAT_DATA_DIR, { recursive: true });
    runtime.initRoutes();
  },

  async dispose() {
    runtime.stop();
  },
};

export default webUIService;
