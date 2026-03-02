import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import type { InstallRequest, ManagedTarget, PackageManager, RemoveRequest, UpdateRequest, WebUISettings } from "./types";
import {
  CHAT_CONFIG_DIR,
  LOCAL_CONFIG_PATH,
  PLUGINS_DIR,
  ROOT_PACKAGE_PATH,
  SERVICES_DIR,
  SETTINGS_PATH,
  defaultWebUISettings,
  ensureDir,
  getInstallCommand,
  isValidRepoUrl,
  normalizePackageManager,
  readJsonFile,
  runCommand,
  safeNameFromRepo,
  writeJsonFile,
} from "./utils";

function getTargetRoot(target: ManagedTarget): string {
  return target === "plugin" ? PLUGINS_DIR : SERVICES_DIR;
}

function readPackageJson(dir: string): any {
  const packagePath = path.join(dir, "package.json");
  if (!fs.existsSync(packagePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(packagePath, "utf-8"));
  } catch {
    return null;
  }
}

function readRootPackageJson(): any {
  return JSON.parse(fs.readFileSync(ROOT_PACKAGE_PATH, "utf-8"));
}

function writeRootPackageJson(data: any): void {
  fs.writeFileSync(ROOT_PACKAGE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function ensureMiokiPlugins(pkg: any): string[] {
  if (!pkg.mioki) pkg.mioki = {};
  if (!Array.isArray(pkg.mioki.plugins)) pkg.mioki.plugins = [];
  return pkg.mioki.plugins;
}

function updateLocalConfigPlugins(pluginNames: string[]): void {
  const local = readJsonFile<any>(LOCAL_CONFIG_PATH, { mioki: {} });
  if (!local.mioki) local.mioki = {};
  local.mioki.plugins = pluginNames;
  writeJsonFile(LOCAL_CONFIG_PATH, local);
}

function packageManagerFromSettings(input?: PackageManager): PackageManager {
  if (input) {
    return normalizePackageManager(input);
  }
  const settings = getWebUISettings();
  return normalizePackageManager(settings.packageManager);
}

export function getWebUISettings(): WebUISettings {
  ensureDir(path.dirname(SETTINGS_PATH));
  const settings = readJsonFile<WebUISettings>(SETTINGS_PATH, defaultWebUISettings);
  const merged = {
    ...defaultWebUISettings,
    ...settings,
    packageManager: normalizePackageManager(settings.packageManager),
  };
  writeJsonFile(SETTINGS_PATH, merged);
  return merged;
}

export function updateWebUISettings(input: Partial<WebUISettings>): WebUISettings {
  const current = getWebUISettings();
  const next: WebUISettings = {
    ...current,
    ...input,
    packageManager: normalizePackageManager(input.packageManager ?? current.packageManager),
  };
  writeJsonFile(SETTINGS_PATH, next);
  return next;
}

function checkDependentServices(packageJson: any): string[] {
  const services = packageJson?.mioku?.services;
  if (!Array.isArray(services)) {
    return [];
  }
  return services.filter((serviceName: string) => {
    const servicePath = path.join(SERVICES_DIR, serviceName);
    return !fs.existsSync(servicePath);
  });
}

export function listManagedPackages(target: ManagedTarget): Array<Record<string, any>> {
  const root = getTargetRoot(target);
  ensureDir(root);
  const names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

  return names.map((name) => {
    const fullPath = path.join(root, name);
    const pkg = readPackageJson(fullPath);
    return {
      name,
      path: fullPath,
      version: pkg?.version ?? "0.0.0",
      description: pkg?.description ?? "",
      hasGit: fs.existsSync(path.join(fullPath, ".git")),
      requiredServices: pkg?.mioku?.services ?? [],
    };
  });
}

export async function installManagedPackage(input: InstallRequest): Promise<Record<string, any>> {
  if (!isValidRepoUrl(input.repoUrl)) {
    throw new Error("仓库地址无效");
  }

  const targetRoot = getTargetRoot(input.target);
  ensureDir(targetRoot);

  const packageName = safeNameFromRepo(input.repoUrl);
  const destination = path.join(targetRoot, packageName);

  if (fs.existsSync(destination)) {
    throw new Error(`${packageName} 已存在`);
  }

  const clone = await runCommand("git", ["clone", input.repoUrl, destination], process.cwd());
  if (clone.code !== 0) {
    throw new Error(`git clone 失败: ${clone.stderr || clone.stdout}`);
  }

  const packageJson = readPackageJson(destination);
  const missingServices = checkDependentServices(packageJson);

  const packageManager = packageManagerFromSettings(input.packageManager);
  const installCmd = getInstallCommand(packageManager);
  const install = await runCommand(installCmd.cmd, installCmd.args, destination);

  if (install.code !== 0) {
    throw new Error(`依赖安装失败: ${install.stderr || install.stdout}`);
  }

  if (input.target === "plugin") {
    const rootPkg = readRootPackageJson();
    const plugins = ensureMiokiPlugins(rootPkg);
    if (!plugins.includes(packageName)) {
      plugins.push(packageName);
    }
    writeRootPackageJson(rootPkg);
    updateLocalConfigPlugins(plugins);
  }

  return {
    ok: true,
    name: packageName,
    missingServices,
    packageManager,
    restartRequired: true,
    installOutput: install.stdout || install.stderr,
  };
}

export async function checkUpdate(name: string, target: ManagedTarget): Promise<Record<string, any>> {
  const dir = path.join(getTargetRoot(target), name);
  if (!fs.existsSync(dir)) {
    throw new Error("目录不存在");
  }

  const fetchRes = await runCommand("git", ["fetch", "--all"], dir);
  if (fetchRes.code !== 0) {
    throw new Error(`git fetch 失败: ${fetchRes.stderr || fetchRes.stdout}`);
  }

  const compare = await runCommand("git", ["rev-list", "--left-right", "--count", "HEAD...@{u}"], dir);
  const parts = compare.stdout.trim().split(/\s+/).map((item) => Number(item));
  const behind = Number.isFinite(parts[1]) ? parts[1] : 0;

  const changelog = await runCommand("git", ["log", "--oneline", "HEAD..@{u}", "-n", "30"], dir);

  return {
    ok: true,
    hasUpdates: behind > 0,
    behind,
    changelog: changelog.stdout.trim().split("\n").filter(Boolean),
  };
}

function packageJsonChanged(before: string, after: string): boolean {
  return before !== after;
}

export async function updateManagedPackage(input: UpdateRequest): Promise<Record<string, any>> {
  const dir = path.join(getTargetRoot(input.target), input.name);
  if (!fs.existsSync(dir)) {
    throw new Error("目录不存在");
  }

  const before = await runCommand("git", ["show", "HEAD:package.json"], dir);

  const pull = await runCommand("git", ["pull"], dir);
  if (pull.code !== 0) {
    throw new Error(`git pull 失败: ${pull.stderr || pull.stdout}`);
  }

  const after = await runCommand("git", ["show", "HEAD:package.json"], dir);
  const changed = packageJsonChanged(before.stdout, after.stdout);

  let reinstallOutput = "";
  if (changed) {
    const packageManager = packageManagerFromSettings(input.packageManager);
    const installCmd = getInstallCommand(packageManager);
    const install = await runCommand(installCmd.cmd, installCmd.args, dir);
    if (install.code !== 0) {
      throw new Error(`依赖安装失败: ${install.stderr || install.stdout}`);
    }
    reinstallOutput = install.stdout || install.stderr;
  }

  return {
    ok: true,
    restartRequired: true,
    packageJsonChanged: changed,
    reinstallOutput,
  };
}

export async function removeManagedPackage(input: RemoveRequest): Promise<Record<string, any>> {
  const dir = path.join(getTargetRoot(input.target), input.name);
  if (!fs.existsSync(dir)) {
    throw new Error("目录不存在");
  }

  fs.rmSync(dir, { recursive: true, force: true });

  if (input.target === "plugin") {
    const rootPkg = readRootPackageJson();
    const plugins = ensureMiokiPlugins(rootPkg).filter((name: string) => name !== input.name);
    rootPkg.mioki.plugins = plugins;
    writeRootPackageJson(rootPkg);
    updateLocalConfigPlugins(plugins);
  }

  return {
    ok: true,
    restartRequired: true,
  };
}

export function getSystemOverview(): Record<string, any> {
  const upSeconds = process.uptime();
  const memoryUsage = process.memoryUsage();

  return {
    version: readRootPackageJson().version,
    nodeVersion: process.version,
    uptimeSeconds: upSeconds,
    memory: {
      rss: memoryUsage.rss,
      heapUsed: memoryUsage.heapUsed,
      heapTotal: memoryUsage.heapTotal,
    },
    cpu: {
      cores: os.cpus().length,
      loadavg: os.loadavg(),
    },
    bot: {
      status: "running",
      onlineAccounts: 1,
      groups: 0,
      friends: 0,
    },
    plugins: listManagedPackages("plugin"),
    services: listManagedPackages("service"),
  };
}

export function getChatConfig(fileName: string): any {
  const filePath = path.join(CHAT_CONFIG_DIR, fileName);
  return readJsonFile(filePath, {});
}

export function updateChatConfig(fileName: string, data: any): any {
  const filePath = path.join(CHAT_CONFIG_DIR, fileName);
  writeJsonFile(filePath, data);
  return data;
}
