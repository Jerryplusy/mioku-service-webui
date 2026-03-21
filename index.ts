import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "mioki";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import type { MiokuService } from "../../core/types";
import type { WebUISettings } from "./types";
import { ensureAuthConfig, loginWithToken, requireAuth } from "./auth";
import { getWebUISettings, getSystemOverview, getSaying } from "./system";
import { CHAT_CONFIG_DIR, CHAT_DATA_DIR, LOGS_DIR, WEBUI_DIST } from "./utils";
import {
  createConfigRoutes,
  createWebUISettingsRoutes,
  createAIRoutes,
  createDBRoutes,
  createPluginConfigRoutes,
  createMemeRoutes,
  createManageRoutes,
} from "./routes";

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

    this.app.get("/api/overview", async (c) => {
      const data = await getSystemOverview();
      return c.json({ ok: true, data });
    });

    this.app.get("/api/saying", async (c) => {
      this.logAction("saying.fetch");
      const data = await getSaying();
      return c.json({ ok: true, data });
    });

    this.app.route("/api/config", createConfigRoutes());
    this.app.route("/api/settings", createWebUISettingsRoutes());
    this.app.route("/api/ai", createAIRoutes());
    this.app.route("/api/manage", createManageRoutes());
    this.app.route("/api/db", createDBRoutes());
    this.app.route("/api/plugin-config", createPluginConfigRoutes());
    this.app.route("/api/meme", createMemeRoutes());

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
    this.app.use("/miku-logo.png", serveStatic({ root: WEBUI_DIST }));
    this.app.use("/about-hero.jpg", serveStatic({ root: WEBUI_DIST }));
    this.app.use("/about-hero-dark.jpg", serveStatic({ root: WEBUI_DIST }));
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
  version: "1.6.0",
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
