import * as crypto from "node:crypto";
import type { Context, Next } from "hono";
import type { AuthConfig } from "./types";
import { AUTH_PATH, WEEK_MS, readJsonFile, writeJsonFile } from "./utils";

export function ensureAuthConfig(): AuthConfig {
  const now = Date.now();
  const existing = readJsonFile<AuthConfig | null>(AUTH_PATH, null);

  if (!existing || !existing.token || !existing.expiresAt || existing.expiresAt <= now) {
    const generated: AuthConfig = {
      token: crypto.randomBytes(24).toString("hex"),
      createdAt: now,
      expiresAt: now + WEEK_MS,
    };
    writeJsonFile(AUTH_PATH, generated);
    return generated;
  }

  return existing;
}

export function verifyAuthHeader(c: Context): boolean {
  const auth = c.req.header("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return false;
  }

  const authConfig = ensureAuthConfig();
  return token === authConfig.token && Date.now() < authConfig.expiresAt;
}

export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  if (!verifyAuthHeader(c)) {
    return c.json({ ok: false, error: "UNAUTHORIZED" }, 401);
  }
  await next();
}

export function loginWithToken(inputToken: string): { ok: boolean; expiresAt?: number } {
  const authConfig = ensureAuthConfig();
  if (inputToken !== authConfig.token) {
    return { ok: false };
  }

  return { ok: true, expiresAt: authConfig.expiresAt };
}
