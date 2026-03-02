export type ManagedTarget = "plugin" | "service";

export type PackageManager = "npm" | "pnpm" | "bun";

export interface WebUISettings {
  port: number;
  host: string;
  packageManager: PackageManager;
  autoOpen: boolean;
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
