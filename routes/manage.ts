import { Hono } from "hono";
import type {
  ChangeRepoRequest,
  InstallRequest,
  RemoveRequest,
  UpdateAllRequest,
  UpdateRequest,
} from "../types";
import {
  changeManagedPackageRepo,
  getManagedPackageDetail,
  installManagedPackage,
  listManagedPackages,
  listManagedPackagesWithUpdates,
  updateManagedPackage,
  updateAllManagedPackages,
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
  app.get("/plugins/overview", async (c) =>
    c.json({ ok: true, data: await listManagedPackagesWithUpdates("plugin") }),
  );
  app.get("/plugins/:name", async (c) => {
    const name = c.req.param("name");
    const result = await getManagedPackageDetail(name, "plugin");
    return c.json(result);
  });

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
  app.post("/update-all", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<UpdateAllRequest>;
    const result = await updateAllManagedPackages({
      target: body.target || "plugin",
      packageManager: body.packageManager,
    });
    return c.json(result);
  });

  app.post("/remove", async (c) => {
    const body = (await c.req.json()) as RemoveRequest;
    const result = await removeManagedPackage(body);
    return c.json(result);
  });
  app.post("/change-repo", async (c) => {
    const body = (await c.req.json()) as Partial<ChangeRepoRequest>;
    const result = await changeManagedPackageRepo(
      String(body.name || ""),
      (body.target || "plugin") as "plugin" | "service",
      String(body.repoUrl || ""),
    );
    return c.json(result);
  });

  return app;
}
