// 管理类型
export type ManagedTarget = "plugin" | "service";

// 包管理器
export type PackageManager = "npm" | "pnpm" | "bun";

export interface WebUISettings {
  port: number;
  host: string;
  packageManager: PackageManager;
}

export interface AuthConfig {
  token: string;
  createdAt: number;
  expiresAt: number;
}

export interface InstallRequest {
  repoUrl: string;
  target: ManagedTarget;
  packageManager?: PackageManager;
}

export interface UpdateRequest {
  name: string;
  target: ManagedTarget;
  packageManager?: PackageManager;
}

export interface RemoveRequest {
  name: string;
  target: ManagedTarget;
}

export interface ChangeRepoRequest {
  name: string;
  target: ManagedTarget;
  repoUrl: string;
}

export interface UpdateAllRequest {
  target: ManagedTarget;
  packageManager?: PackageManager;
}
