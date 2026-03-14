import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { connectedBots, systemInfo } from "mioki";
import type {
  InstallRequest,
  ManagedTarget,
  PackageManager,
  RemoveRequest,
  UpdateRequest,
  WebUISettings,
} from "./types";
import {
  CHAT_CONFIG_DIR,
  defaultWebUISettings,
  ensureDir,
  getInstallCommand,
  isValidRepoUrl,
  LOCAL_CONFIG_PATH,
  normalizePackageManager,
  PLUGINS_DIR,
  readJsonFile,
  ROOT_PACKAGE_PATH,
  runCommand,
  safeNameFromRepo,
  SERVICES_DIR,
  SETTINGS_PATH,
  writeJsonFile,
} from "./utils";

interface NapcatNodeConfig {
  name?: string;
  host?: string;
  port?: number;
  token?: string;
  protocol?: string;
}

interface MiokiRuntimeConfig {
  mioki?: {
    napcat?: NapcatNodeConfig[];
    [key: string]: any;
  };
  [key: string]: any;
}

const SYSTEM_PLUGIN_NAMES = new Set(["boot", "chat", "help"]);
const SYSTEM_SERVICE_NAMES = new Set(["ai", "config", "help", "screenshot"]);

function isSystemPluginName(name: string): boolean {
  return SYSTEM_PLUGIN_NAMES.has(String(name || "").trim().toLowerCase());
}

function isSystemServiceName(name: string): boolean {
  return SYSTEM_SERVICE_NAMES.has(String(name || "").trim().toLowerCase());
}

function getTargetRoot(target: ManagedTarget): string {
  return target === "plugin" ? PLUGINS_DIR : SERVICES_DIR;
}

function deepMerge<T extends Record<string, any>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target };
  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = result[key];
    if (
      sourceValue &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === "object" &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(targetValue, sourceValue);
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as any;
    }
  }
  return result;
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
  const settings = readJsonFile<WebUISettings>(
    SETTINGS_PATH,
    defaultWebUISettings,
  );
  const merged = {
    ...defaultWebUISettings,
    ...settings,
    packageManager: normalizePackageManager(settings.packageManager),
  };
  writeJsonFile(SETTINGS_PATH, merged);
  return merged;
}

export function updateWebUISettings(
  input: Partial<WebUISettings>,
): WebUISettings {
  const current = getWebUISettings();
  const next: WebUISettings = {
    ...current,
    ...input,
    packageManager: normalizePackageManager(
      input.packageManager ?? current.packageManager,
    ),
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

function assertSafePackageName(name: string): string {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    throw new Error("名称不能为空");
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    throw new Error("名称格式非法");
  }
  return trimmed;
}

function resolveManagedDir(target: ManagedTarget, name: string): string {
  const safeName = assertSafePackageName(name);
  const root = path.resolve(getTargetRoot(target));
  const dir = path.resolve(root, safeName);
  if (!dir.startsWith(`${root}${path.sep}`)) {
    throw new Error("非法路径");
  }
  if (!fs.existsSync(dir)) {
    throw new Error("目录不存在");
  }
  return dir;
}

function getRepositoryFromPackage(pkg: any): string {
  const repository = pkg?.repository;
  if (!repository) return "";
  if (typeof repository === "string") return repository;
  if (typeof repository?.url === "string") return repository.url;
  return "";
}

async function getGitOriginUrl(dir: string): Promise<string> {
  const res = await runCommand("git", ["remote", "get-url", "origin"], dir);
  if (res.code !== 0) return "";
  return res.stdout.trim();
}

function readReadmeFile(dir: string): { fileName: string; content: string } | null {
  const candidates = [
    "README.md",
    "README.MD",
    "readme.md",
    "README.txt",
    "README",
    "readme",
  ];

  for (const fileName of candidates) {
    const filePath = path.join(dir, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return { fileName, content };
    } catch {
      return null;
    }
  }
  return null;
}

interface ManagedPackageUpdateInfo {
  state: "up-to-date" | "has-updates" | "unknown" | "no-git";
  hasUpdates: boolean;
  behind: number;
  changelog: string[];
  error?: string;
}

async function getManagedPackageUpdateInfo(
  dir: string,
): Promise<ManagedPackageUpdateInfo> {
  if (!fs.existsSync(path.join(dir, ".git"))) {
    return {
      state: "no-git",
      hasUpdates: false,
      behind: 0,
      changelog: [],
      error: "NOT_GIT_REPO",
    };
  }

  const fetchRes = await runCommand("git", ["fetch", "--all"], dir);
  if (fetchRes.code !== 0) {
    return {
      state: "unknown",
      hasUpdates: false,
      behind: 0,
      changelog: [],
      error: `git fetch 失败: ${fetchRes.stderr || fetchRes.stdout}`.trim(),
    };
  }

  const compare = await runCommand(
    "git",
    ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
    dir,
  );
  if (compare.code !== 0) {
    return {
      state: "unknown",
      hasUpdates: false,
      behind: 0,
      changelog: [],
      error: `无法比较更新: ${compare.stderr || compare.stdout}`.trim(),
    };
  }

  const parts = compare.stdout
    .trim()
    .split(/\s+/)
    .map((item) => Number(item));
  const behind = Number.isFinite(parts[1]) ? parts[1] : 0;

  const changelog = await runCommand(
    "git",
    ["log", "--oneline", "HEAD..@{u}", "-n", "30"],
    dir,
  );

  return {
    state: behind > 0 ? "has-updates" : "up-to-date",
    hasUpdates: behind > 0,
    behind,
    changelog: changelog.stdout.trim().split("\n").filter(Boolean),
  };
}

export function listManagedPackages(
  target: ManagedTarget,
): Array<Record<string, any>> {
  const root = getTargetRoot(target);
  ensureDir(root);
  const names = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  return names.map((name) => {
    const fullPath = path.join(root, name);
    const pkg = readPackageJson(fullPath);
    return {
      name,
      path: fullPath,
      version: pkg?.version ?? "0.0.0",
      description: pkg?.description ?? "",
      hasGit: fs.existsSync(path.join(fullPath, ".git")),
      isSystemPlugin: target === "plugin" ? isSystemPluginName(name) : false,
      isSystemService: target === "service" ? isSystemServiceName(name) : false,
      repository: getRepositoryFromPackage(pkg),
      requiredServices: pkg?.mioku?.services ?? [],
    };
  });
}

export async function installManagedPackage(
  input: InstallRequest,
): Promise<Record<string, any>> {
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

  const clone = await runCommand(
    "git",
    ["clone", input.repoUrl, destination],
    process.cwd(),
  );
  if (clone.code !== 0) {
    throw new Error(`git clone 失败: ${clone.stderr || clone.stdout}`);
  }

  const packageJson = readPackageJson(destination);
  const missingServices = checkDependentServices(packageJson);

  const packageManager = packageManagerFromSettings(input.packageManager);
  const installCmd = getInstallCommand(packageManager);
  const install = await runCommand(
    installCmd.cmd,
    installCmd.args,
    destination,
  );

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

export async function checkUpdate(
  name: string,
  target: ManagedTarget,
): Promise<Record<string, any>> {
  const dir = resolveManagedDir(target, name);
  const result = await getManagedPackageUpdateInfo(dir);
  return {
    ok: true,
    state: result.state,
    hasUpdates: result.hasUpdates,
    behind: result.behind,
    changelog: result.changelog,
    hasGit: result.state !== "no-git",
    error: result.error,
  };
}

function packageJsonChanged(before: string, after: string): boolean {
  return before !== after;
}

export async function updateManagedPackage(
  input: UpdateRequest,
): Promise<Record<string, any>> {
  const dir = resolveManagedDir(input.target, input.name);

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

export async function removeManagedPackage(
  input: RemoveRequest,
): Promise<Record<string, any>> {
  if (input.target === "plugin" && isSystemPluginName(input.name)) {
    throw new Error("系统插件不可卸载");
  }
  if (input.target === "service" && isSystemServiceName(input.name)) {
    throw new Error("系统服务不可卸载");
  }

  const dir = resolveManagedDir(input.target, input.name);

  fs.rmSync(dir, { recursive: true, force: true });

  if (input.target === "plugin") {
    const rootPkg = readRootPackageJson();
    const plugins = ensureMiokiPlugins(rootPkg).filter(
      (name: string) => name !== input.name,
    );
    rootPkg.mioki.plugins = plugins;
    writeRootPackageJson(rootPkg);
    updateLocalConfigPlugins(plugins);
  }

  return {
    ok: true,
    restartRequired: true,
  };
}

export async function listManagedPackagesWithUpdates(
  target: ManagedTarget,
): Promise<Array<Record<string, any>>> {
  const packages = listManagedPackages(target);
  const results = await Promise.all(
    packages.map(async (item) => {
      try {
        const updateInfo = await getManagedPackageUpdateInfo(item.path);
        return {
          ...item,
          updateState: updateInfo.state,
          hasUpdates: updateInfo.hasUpdates,
          behind: updateInfo.behind,
          updateError: updateInfo.error || "",
        };
      } catch (error: any) {
        return {
          ...item,
          updateState: "unknown",
          hasUpdates: false,
          behind: 0,
          updateError: error?.message || "UPDATE_CHECK_FAILED",
        };
      }
    }),
  );
  return results;
}

export async function getManagedPackageDetail(
  name: string,
  target: ManagedTarget,
): Promise<Record<string, any>> {
  const dir = resolveManagedDir(target, name);
  const pkg = readPackageJson(dir) || {};
  const readme = readReadmeFile(dir);
  const originUrl = await getGitOriginUrl(dir);
  const repositoryFromPkg = getRepositoryFromPackage(pkg);
  const updateInfo = await getManagedPackageUpdateInfo(dir);
  const requiredServices = Array.isArray(pkg?.mioku?.services)
    ? pkg.mioku.services
    : [];
  const missingServices = checkDependentServices(pkg);

  return {
    ok: true,
    data: {
      name,
      target,
      path: dir,
      version: pkg?.version || "0.0.0",
      description: pkg?.description || "",
      hasGit: fs.existsSync(path.join(dir, ".git")),
      isSystemPlugin: target === "plugin" ? isSystemPluginName(name) : false,
      isSystemService:
        target === "service" ? isSystemServiceName(name) : false,
      repository: repositoryFromPkg,
      originUrl,
      homepage: pkg?.homepage || "",
      requiredServices,
      missingServices,
      help: pkg?.mioku?.help || null,
      readme: readme?.content || "",
      readmeFile: readme?.fileName || "",
      updateState: updateInfo.state,
      hasUpdates: updateInfo.hasUpdates,
      behind: updateInfo.behind,
      changelog: updateInfo.changelog,
      updateError: updateInfo.error || "",
    },
  };
}

export async function changeManagedPackageRepo(
  name: string,
  target: ManagedTarget,
  repoUrl: string,
): Promise<Record<string, any>> {
  if (!isValidRepoUrl(repoUrl)) {
    throw new Error("仓库地址无效");
  }

  const dir = resolveManagedDir(target, name);
  const nextUrl = repoUrl.trim();
  const oldUrl = await getGitOriginUrl(dir);

  const setRemote = await runCommand(
    "git",
    ["remote", "set-url", "origin", nextUrl],
    dir,
  );
  if (setRemote.code !== 0) {
    throw new Error(`更新仓库地址失败: ${setRemote.stderr || setRemote.stdout}`);
  }

  const packagePath = path.join(dir, "package.json");
  if (fs.existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
      if (typeof pkg.repository === "string") {
        pkg.repository = nextUrl;
      } else if (pkg.repository && typeof pkg.repository === "object") {
        pkg.repository = { ...pkg.repository, url: nextUrl };
      } else {
        pkg.repository = nextUrl;
      }
      fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2), "utf-8");
    } catch {
      // ignore package.json update failure, git remote is the source of truth
    }
  }

  return {
    ok: true,
    oldUrl,
    newUrl: nextUrl,
  };
}

export async function updateAllManagedPackages(input: {
  target: ManagedTarget;
  packageManager?: PackageManager;
}): Promise<Record<string, any>> {
  const packages = listManagedPackages(input.target);
  const results: Array<Record<string, any>> = [];

  for (const item of packages) {
    const updateInfo = await getManagedPackageUpdateInfo(item.path);
    if (updateInfo.state === "no-git") {
      results.push({
        name: item.name,
        ok: false,
        skipped: true,
        reason: "NOT_GIT_REPO",
      });
      continue;
    }
    if (!updateInfo.hasUpdates) {
      results.push({
        name: item.name,
        ok: true,
        skipped: true,
        reason: updateInfo.state === "unknown" ? "CHECK_FAILED" : "UP_TO_DATE",
        error: updateInfo.error || "",
      });
      continue;
    }

    try {
      const updated = await updateManagedPackage({
        name: item.name,
        target: input.target,
        packageManager: input.packageManager,
      });
      results.push({
        name: item.name,
        ok: true,
        skipped: false,
        ...updated,
      });
    } catch (error: any) {
      results.push({
        name: item.name,
        ok: false,
        skipped: false,
        error: error?.message || "UPDATE_FAILED",
      });
    }
  }

  const updatedCount = results.filter((item) => item.ok && !item.skipped).length;
  const failedCount = results.filter((item) => !item.ok && !item.skipped).length;
  const skippedCount = results.filter((item) => item.skipped).length;

  return {
    ok: failedCount === 0,
    restartRequired: updatedCount > 0,
    updatedCount,
    failedCount,
    skippedCount,
    results,
  };
}

function readPackageVersion(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return "unknown";
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed?.version || "unknown";
  } catch {
    return "unknown";
  }
}

async function getSystemInformationSnapshot(): Promise<{
  diskUsagePercent: number;
  diskTotal: number;
  diskUsed: number;
  netRxPerSec: number;
  netTxPerSec: number;
}> {
  try {
    const [fsSize, netStats] = await Promise.all([
      systemInfo.fsSize().catch(() => [] as any[]),
      systemInfo.networkStats().catch(() => [] as any[]),
    ]);

    const disk = Array.isArray(fsSize) && fsSize.length > 0 ? fsSize[0] : null;
    const diskTotal = Number(disk?.size || 0);
    const diskUsed = Number(disk?.used || 0);
    const diskUsagePercent =
      diskTotal > 0
        ? Number(((diskUsed / diskTotal) * 100).toFixed(1))
        : Number(disk?.use || 0);

    const networkList = Array.isArray(netStats) ? netStats : [];
    const netRxPerSec = networkList.reduce(
      (acc, item) => acc + Number(item?.rx_sec || 0),
      0,
    );
    const netTxPerSec = networkList.reduce(
      (acc, item) => acc + Number(item?.tx_sec || 0),
      0,
    );

    return {
      diskUsagePercent: Number.isFinite(diskUsagePercent)
        ? diskUsagePercent
        : 0,
      diskTotal,
      diskUsed,
      netRxPerSec: Number.isFinite(netRxPerSec) ? netRxPerSec : 0,
      netTxPerSec: Number.isFinite(netTxPerSec) ? netTxPerSec : 0,
    };
  } catch {
    return {
      diskUsagePercent: 0,
      diskTotal: 0,
      diskUsed: 0,
      netRxPerSec: 0,
      netTxPerSec: 0,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sampleCpuTimes() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.irq +
      cpu.times.idle;
  }

  return { idle, total };
}

async function getCpuUsagePercent(): Promise<number> {
  const start = sampleCpuTimes();
  await sleep(180);
  const end = sampleCpuTimes();
  const idleDelta = end.idle - start.idle;
  const totalDelta = end.total - start.total;
  if (totalDelta <= 0) return 0;
  return Number((((totalDelta - idleDelta) / totalDelta) * 100).toFixed(1));
}

function toHttpBaseUrl(bot: any): string {
  const protocol = String(bot.options?.protocol || "ws");
  const httpProtocol = protocol === "wss" ? "https" : "http";
  const host = bot.options?.host || "127.0.0.1";
  const port = bot.options?.port || 3001;
  return `${httpProtocol}://${host}:${port}`;
}

async function fetchYiyan(): Promise<{ text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch("https://uapis.cn/api/v1/saying", {
      method: "GET",
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP_${res.status}`);
    }
    const data = (await res.json()) as { text?: string };
    return { text: data?.text || "愿每一次启动都带来新的灵感。" };
  } catch {
    return { text: "愿每一次启动都带来新的灵感。" };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeVersionSpec(input: string): string {
  if (!input || input === "unknown") return "unknown";
  const cleaned = input.trim().replace(/^[~^<>=\s]+/, "");
  const matched = cleaned.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return matched?.[0] || cleaned;
}

async function getBotDetails(bot: any): Promise<Record<string, any>> {
  const base = {
    botId: bot?.bot_id || bot?.uin || 0,
    qq: bot?.uin || bot?.user_id || 0,
    nickname: bot?.nickname || bot?.name || "Unknown Bot",
    avatar: `https://q1.qlogo.cn/g?b=qq&nk=${bot?.uin || bot?.user_id || 0}&s=160`,
    online: true,
    napcatVersion: bot?.app_version || "unknown",
    napcatApiBase: toHttpBaseUrl(bot),
    groupCount: 0,
    friendCount: 0,
    onlineDurationMs: 0,
    statusText: "online",
  };

  try {
    const [status, versionInfo, groups, friends] = await Promise.all([
      bot.api("get_status").catch(() => null),
      bot.api("get_version_info").catch(() => null),
      bot.getGroupList().catch(() => []),
      bot.getFriendList().catch(() => []),
    ]);

    const stat = status?.stat || null;
    const startTs = Number(stat?.start_time || 0);
    const onlineDurationMs =
      startTs > 0 ? Math.max(0, Date.now() - startTs) : 0;
    const onlineFromStatus =
      typeof status?.online === "boolean" ? status.online : true;

    return {
      ...base,
      online: onlineFromStatus,
      napcatVersion: versionInfo?.app_version || base.napcatVersion,
      groupCount: Array.isArray(groups) ? groups.length : 0,
      friendCount: Array.isArray(friends) ? friends.length : 0,
      onlineDurationMs,
      statusText: onlineFromStatus ? "online" : "offline",
    };
  } catch (error: any) {
    return {
      ...base,
      online: false,
      statusText: "error",
      error: error?.message || "NAPCAT_API_ERROR",
    };
  }
}

export async function getSystemOverview(): Promise<Record<string, any>> {
  const rootPkg = readRootPackageJson();
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || "unknown";
  const cpuSpeedMHz = cpus[0]?.speed || 0;
  const cpuCores = cpus.length;
  const cpuUsagePercent = await getCpuUsagePercent();

  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = Math.max(0, totalMemory - freeMemory);
  const memoryUsagePercent =
    totalMemory > 0 ? Number(((usedMemory / totalMemory) * 100).toFixed(1)) : 0;

  const processMemory = process.memoryUsage();
  const processMemoryPercent =
    totalMemory > 0
      ? Number(((processMemory.rss / totalMemory) * 100).toFixed(1))
      : 0;
  const siSnapshot = await getSystemInformationSnapshot();

  const botInstances = Array.from(connectedBots.values());
  const bots = await Promise.all(botInstances.map((bot) => getBotDetails(bot)));
  const selectedBot = bots[0] || null;

  const webuiPkgPath = fs.existsSync(
    path.join(process.cwd(), "mioku-webui", "package.json"),
  )
    ? path.join(process.cwd(), "mioku-webui", "package.json")
    : path.join(process.cwd(), "webui", "package.json");

  return {
    uptimeSeconds: process.uptime(),
    bots,
    selectedBot,
    system: {
      cpuModel,
      cpuSpeedMHz,
      cpuCores,
      cpuUsagePercent,
      memoryTotal: totalMemory,
      memoryUsed: usedMemory,
      memoryFree: freeMemory,
      memoryUsagePercent,
      processMemoryRss: processMemory.rss,
      processMemoryHeapUsed: processMemory.heapUsed,
      processMemoryPercent,
      diskUsagePercent: siSnapshot.diskUsagePercent,
      diskTotal: siSnapshot.diskTotal,
      diskUsed: siSnapshot.diskUsed,
      networkRxPerSec: siSnapshot.netRxPerSec,
      networkTxPerSec: siSnapshot.netTxPerSec,
      osType: os.type(),
      osPlatform: os.platform(),
      osRelease: os.release(),
      osVersion: typeof os.version === "function" ? os.version() : "unknown",
      nodeVersion: process.version,
    },
    versions: {
      mioki: normalizeVersionSpec(
        rootPkg?.dependencies?.mioki ||
          rootPkg?.devDependencies?.mioki ||
          "unknown",
      ),
      mioku: rootPkg?.version || "unknown",
      webui: readPackageVersion(webuiPkgPath),
      webuiService: readPackageVersion(
        path.join(process.cwd(), "src", "services", "webui", "package.json"),
      ),
    },
    plugins: listManagedPackages("plugin"),
    services: listManagedPackages("service"),
  };
}

export async function getSaying(): Promise<{ text: string }> {
  return fetchYiyan();
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

export interface MiokuConfig {
  owners: number[];
  admins: number[];
  napcat: Array<{
    name: string;
    protocol: string;
    port: number;
    host: string;
    token: string;
  }>;
  plugins: string[];
}

export function getMiokuConfig(): MiokuConfig {
  const localConfig = readJsonFile<any>(LOCAL_CONFIG_PATH, { mioki: {} });
  const rootPkg = readRootPackageJson();

  const miokiConfig = localConfig?.mioki || rootPkg?.mioki || {};

  return {
    owners: Array.isArray(miokiConfig.owners) ? miokiConfig.owners : [],
    admins: Array.isArray(miokiConfig.admins) ? miokiConfig.admins : [],
    napcat: Array.isArray(miokiConfig.napcat) ? miokiConfig.napcat : [],
    plugins: Array.isArray(miokiConfig.plugins) ? miokiConfig.plugins : [],
  };
}

export function updateMiokuConfig(config: Partial<MiokuConfig>): MiokuConfig {
  const current = getMiokuConfig();
  const updated: MiokuConfig = {
    owners: Array.isArray(config.owners) ? config.owners : current.owners,
    admins: Array.isArray(config.admins) ? config.admins : current.admins,
    napcat: Array.isArray(config.napcat) ? config.napcat : current.napcat,
    plugins: Array.isArray(config.plugins) ? config.plugins : current.plugins,
  };

  const localConfig = readJsonFile<any>(LOCAL_CONFIG_PATH, { mioki: {} });
  localConfig.mioki = {
    ...localConfig.mioki,
    ...updated,
  };
  writeJsonFile(LOCAL_CONFIG_PATH, localConfig);

  const rootPkg = readRootPackageJson();
  if (rootPkg.mioki) {
    rootPkg.mioki.owners = updated.owners;
    rootPkg.mioki.admins = updated.admins;
    rootPkg.mioki.napcat = updated.napcat;
    rootPkg.mioki.plugins = updated.plugins;
    writeRootPackageJson(rootPkg);
  }

  return updated;
}

export function getAvailablePlugins(): string[] {
  ensureDir(PLUGINS_DIR);
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."),
    )
    .map((e) => e.name);
}
