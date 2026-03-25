import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import { logger } from "mioki";

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "switch" | "select" | "multi-select" | "secret" | "json";
  description?: string;
  placeholder?: string;
  required?: boolean;
  multiple?: boolean;
  source?: string;
  options?: Array<{ value: string; label: string }>;
  defaultValue?: any;
}

export interface ConfigPageManifest {
  plugin: string;
  title: string;
  description?: string;
  markdown: string;
  fields: ConfigField[];
  hasCustomPage: boolean;
}

export function loadPluginConfigPage(pluginName: string): ConfigPageManifest | null {
  const pluginDir = path.join(process.cwd(), "plugins", pluginName);
  const configMdPath = path.join(pluginDir, "config.md");

  if (!fs.existsSync(configMdPath)) {
    return null;
  }

  try {
    const fileContent = fs.readFileSync(configMdPath, "utf-8");
    const parsed = matter(fileContent);

    const frontmatter = parsed.data as any;
    const fields = (frontmatter.fields || []) as ConfigField[];

    // Validate fields
    for (const field of fields) {
      if (!field.key || !field.label || !field.type) {
        logger.warn(`Invalid field in ${pluginName}/config.md: missing key, label, or type`);
        continue;
      }

      // Validate key format: <configName>.<jsonPath>
      if (!field.key.includes(".")) {
        logger.warn(`Invalid field key in ${pluginName}/config.md: ${field.key} (must be <configName>.<path>)`);
      }
    }

    return {
      plugin: pluginName,
      title: frontmatter.title || `${pluginName} Configuration`,
      description: frontmatter.description,
      markdown: parsed.content,
      fields,
      hasCustomPage: true,
    };
  } catch (error: any) {
    logger.error(`Failed to load config page for ${pluginName}: ${error.message}`);
    return null;
  }
}

export function parseConfigKey(key: string): { configName: string; path: string } | null {
  const parts = key.split(".");
  if (parts.length < 2) {
    return null;
  }

  return {
    configName: parts[0],
    path: parts.slice(1).join("."),
  };
}

export function getValueByPath(obj: any, path: string): any {
  const keys = path.split(".");
  let current = obj;

  for (const key of keys) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = current[key];
  }

  return current;
}

export function setValueByPath(obj: any, path: string, value: any): void {
  const keys = path.split(".");
  let current = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key];
  }

  current[keys[keys.length - 1]] = value;
}
