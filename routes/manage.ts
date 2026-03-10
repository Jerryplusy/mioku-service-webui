import { Hono } from "hono";
import type { InstallRequest, RemoveRequest, UpdateRequest } from "../types";
import {
  installManagedPackage,
  listManagedPackages,
  updateManagedPackage,
  checkUpdate,
  removeManagedPackage,
} from "../system";

export function createManageRoutes() {
  const app = new Hono();

  app.get("/plugins", (c) =>
    c.json({ ok: true, data: listManagedPackages("plugin") }),
  );
  app.get("/services", (c) =>
    c.json({ ok: true, data: listManagedPackages("service") }),
  );

  app.post("/install", async (c) => {
    const body = (await c.req.json()) as InstallRequest;
    const result = await installManagedPackage(body);
    return c.json(result);
  });

  app.post("/check-update", async (c) => {
    const body = (await c.req.json()) as {
      name: string;
      target: "plugin" | "service";
    };
    const result = await checkUpdate(body.name, body.target);
    return c.json(result);
  });

  app.post("/update", async (c) => {
    const body = (await c.req.json()) as UpdateRequest;
    const result = await updateManagedPackage(body);
    return c.json(result);
  });

  app.post("/remove", async (c) => {
    const body = (await c.req.json()) as RemoveRequest;
    const result = await removeManagedPackage(body);
    return c.json(result);
  });

  return app;
}
