import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { PackageManager, WebUISettings } from "./types";

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const SETTINGS_PATH = path.join(process.cwd(), "config", "webui", "settings.json");
export const AUTH_PATH = path.join(process.cwd(), "config", "webui", "auth.json");
export const ROOT_PACKAGE_PATH = path.join(process.cwd(), "package.json");
export const LOCAL_CONFIG_PATH = path.join(process.cwd(), "config", "mioku.json");

export const WEBUI_DIST = path.join(process.cwd(), "src", "services", "webui", "dist");
export const PLUGINS_DIR = path.join(process.cwd(), "plugins");
export const SERVICES_DIR = path.join(process.cwd(), "src", "services");
export const CHAT_CONFIG_DIR = path.join(process.cwd(), "config", "chat");
export const CHAT_DATA_DIR = path.join(process.cwd(), "data", "chat");
export const LOGS_DIR = path.join(process.cwd(), "logs");

export const defaultWebUISettings: WebUISettings = {
  port: 3339,
  host: "0.0.0.0",
  packageManager: "bun",
  autoOpen: false,
};

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function safeNameFromRepo(repoUrl: string): string {
  const last = repoUrl.split("/").pop() || "package";
  return last.replace(/\.git$/, "").replace(/[^a-zA-Z0-9._-]/g, "-");
}

export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    child.on("error", (error) => {
      resolve({ stdout, stderr: `${stderr}\n${error.message}`.trim(), code: 1 });
    });
  });
}

export function getInstallCommand(packageManager: PackageManager): { cmd: string; args: string[] } {
  if (packageManager === "npm") {
    return { cmd: "npm", args: ["install"] };
  }
  if (packageManager === "pnpm") {
    return { cmd: "pnpm", args: ["install"] };
  }
  return { cmd: "bun", args: ["install"] };
}

export function normalizePackageManager(input?: string): PackageManager {
  if (input === "npm" || input === "pnpm" || input === "bun") {
    return input;
  }
  return "bun";
}

export function isValidRepoUrl(url: string): boolean {
  const gitLike = /^(https?:\/\/|git@|ssh:\/\/).+/;
  return gitLike.test(url.trim());
}
