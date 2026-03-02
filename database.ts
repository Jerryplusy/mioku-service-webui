import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { CHAT_DATA_DIR, readJsonFile, writeJsonFile } from "./utils";

const DB_PATH = path.join(CHAT_DATA_DIR, "chat.db");
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function openDb(): any {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error("数据库不存在");
  }
  return new Database(DB_PATH, { readonly: false });
}

function getTableColumns(db: any, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function ensureSafeIdentifier(value: string, label: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`${label} 非法`);
  }
  return value;
}

function resolveTimeColumn(columns: string[]): string | null {
  if (columns.includes("created_at")) return "created_at";
  if (columns.includes("timestamp")) return "timestamp";
  if (columns.includes("updated_at")) return "updated_at";
  return null;
}

export function listTables(): string[] {
  const db = openDb();
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  } finally {
    db.close();
  }
}

export function queryMessages(input: {
  table?: string;
  keyword?: string;
  userId?: string;
  sessionId?: string;
  startTime?: number;
  endTime?: number;
  page?: number;
  pageSize?: number;
}): Record<string, any> {
  const db = openDb();
  try {
    const table = ensureSafeIdentifier(input.table || "messages", "表名");
    const columns = getTableColumns(db, table);
    const timeColumn = resolveTimeColumn(columns);

    const page = Math.max(1, Number(input.page || 1));
    const pageSize = Math.min(200, Math.max(1, Number(input.pageSize || 20)));
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [];
    const params: Record<string, any> = {};

    if (input.keyword && columns.includes("content")) {
      conditions.push("content LIKE @keyword");
      params.keyword = `%${input.keyword}%`;
    }
    if (input.userId && columns.includes("user_id")) {
      conditions.push("user_id = @userId");
      params.userId = input.userId;
    }
    if (input.sessionId && columns.includes("session_id")) {
      conditions.push("session_id = @sessionId");
      params.sessionId = input.sessionId;
    }
    if (input.startTime && timeColumn) {
      conditions.push(`${timeColumn} >= @startTime`);
      params.startTime = input.startTime;
    }
    if (input.endTime && timeColumn) {
      conditions.push(`${timeColumn} <= @endTime`);
      params.endTime = input.endTime;
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const countStmt = db.prepare(`SELECT COUNT(*) as count FROM ${table} ${whereSql}`);
    const total = Number((countStmt.get(params) as any)?.count || 0);

    const orderField = timeColumn || columns[0] || "rowid";
    const rowsStmt = db.prepare(`SELECT * FROM ${table} ${whereSql} ORDER BY ${orderField} DESC LIMIT @limit OFFSET @offset`);
    const rows = rowsStmt.all({ ...params, limit: pageSize, offset });

    return { total, page, pageSize, rows, table, columns };
  } finally {
    db.close();
  }
}

export function updateMessage(input: { table?: string; idField?: string; id: string | number; content: string }): Record<string, any> {
  const db = openDb();
  try {
    const table = ensureSafeIdentifier(input.table || "messages", "表名");
    const idField = ensureSafeIdentifier(input.idField || "id", "主键字段");
    const stmt = db.prepare(`UPDATE ${table} SET content = ? WHERE ${idField} = ?`);
    const result = stmt.run(input.content, input.id);
    return { changed: result.changes };
  } finally {
    db.close();
  }
}

export function deleteMessagesByRange(input: { table?: string; startTime: number; endTime: number }): Record<string, any> {
  const db = openDb();
  try {
    const table = ensureSafeIdentifier(input.table || "messages", "表名");
    const columns = getTableColumns(db, table);
    const timeColumn = resolveTimeColumn(columns);
    if (!timeColumn) {
      throw new Error(`${table} 不包含时间字段(created_at/timestamp/updated_at)`);
    }
    const stmt = db.prepare(`DELETE FROM ${table} WHERE ${timeColumn} >= ? AND ${timeColumn} <= ?`);
    const result = stmt.run(input.startTime, input.endTime);
    return { deleted: result.changes };
  } finally {
    db.close();
  }
}

export function getStats(): Record<string, any> {
  const db = openDb();
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );

    const hasMessages = tables.includes("messages");
    const hasImages = tables.includes("images");
    const messageColumns = hasMessages ? getTableColumns(db, "messages") : [];
    const messageTimeColumn = resolveTimeColumn(messageColumns);

    const messageTotal = hasMessages ? Number((db.prepare("SELECT COUNT(*) as count FROM messages").get() as any)?.count || 0) : 0;
    const activeUsers = hasMessages
      ? Number((db.prepare("SELECT COUNT(DISTINCT user_id) as count FROM messages").get() as any)?.count || 0)
      : 0;

    const aiCalls = hasMessages
      ? Number((db.prepare("SELECT COUNT(*) as count FROM messages WHERE role='assistant'").get() as any)?.count || 0)
      : 0;

    const timeline = hasMessages && messageTimeColumn
      ? db
          .prepare(
            `SELECT strftime('%Y-%m-%d', datetime(${messageTimeColumn} / 1000, 'unixepoch')) as day, COUNT(*) as count FROM messages GROUP BY day ORDER BY day DESC LIMIT 30`,
          )
          .all()
      : [];

    const topTopics = hasMessages
      ? db
          .prepare(
            "SELECT substr(content, 1, 20) as topic, COUNT(*) as count FROM messages WHERE content IS NOT NULL AND content != '' GROUP BY topic ORDER BY count DESC LIMIT 10",
          )
          .all()
      : [];

    const imageStats = hasImages
      ? db
          .prepare(
            "SELECT COALESCE(NULLIF(TRIM(character), ''), 'unknown') || '/' || COALESCE(NULLIF(TRIM(emotion), ''), 'default') as name, COUNT(*) as count FROM images GROUP BY COALESCE(NULLIF(TRIM(character), ''), 'unknown'), COALESCE(NULLIF(TRIM(emotion), ''), 'default') ORDER BY count DESC LIMIT 20",
          )
          .all()
      : [];

    return {
      messageTotal,
      activeUsers,
      aiCalls,
      timeline,
      topTopics,
      imageStats,
    };
  } finally {
    db.close();
  }
}

export function exportData(format: "json" | "csv"): { filePath: string } {
  const db = openDb();
  try {
    const tables = listTables();
    const dump: Record<string, any[]> = {};

    for (const table of tables) {
      dump[table] = db.prepare(`SELECT * FROM ${table}`).all();
    }

    const backupDir = path.join(CHAT_DATA_DIR, "backup");
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const ts = Date.now();
    if (format === "json") {
      const filePath = path.join(backupDir, `chat-backup-${ts}.json`);
      fs.writeFileSync(filePath, JSON.stringify(dump, null, 2), "utf-8");
      return { filePath };
    }

    const rows = dump.messages ?? [];
    const headers = rows.length ? Object.keys(rows[0]) : [];
    const csvLines = [headers.join(",")].concat(
      rows.map((row) =>
        headers
          .map((key) => {
            const raw = row[key] == null ? "" : String(row[key]);
            return `"${raw.replace(/"/g, '""')}"`;
          })
          .join(","),
      ),
    );

    const filePath = path.join(backupDir, `chat-backup-${ts}.csv`);
    fs.writeFileSync(filePath, csvLines.join("\n"), "utf-8");
    return { filePath };
  } finally {
    db.close();
  }
}

export function importDataFromJson(filePath: string): { importedTables: string[] } {
  const payload = readJsonFile<Record<string, any[]>>(filePath, {});
  const db = openDb();

  try {
    const importedTables: string[] = [];

    db.exec("BEGIN");
    for (const [table, rows] of Object.entries(payload)) {
      ensureSafeIdentifier(table, "表名");
      if (!Array.isArray(rows) || rows.length === 0) {
        continue;
      }
      const columns = Object.keys(rows[0]);
      const placeholders = columns.map(() => "?").join(",");
      const insert = db.prepare(
        `INSERT INTO ${table} (${columns.join(",")}) VALUES (${placeholders})`,
      );

      for (const row of rows) {
        insert.run(columns.map((column) => (row as any)[column]));
      }
      importedTables.push(table);
    }
    db.exec("COMMIT");

    return { importedTables };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function listMemeTree(): Record<string, Record<string, string[]>> {
  const root = path.join(CHAT_DATA_DIR, "meme");
  const tree: Record<string, Record<string, string[]>> = {};

  if (!fs.existsSync(root)) {
    return tree;
  }

  const characters = fs.readdirSync(root);
  for (const character of characters) {
    const charDir = path.join(root, character);
    if (!fs.statSync(charDir).isDirectory()) {
      continue;
    }

    tree[character] = {};
    const emotions = fs.readdirSync(charDir);
    for (const emotion of emotions) {
      const emotionDir = path.join(charDir, emotion);
      if (!fs.statSync(emotionDir).isDirectory()) {
        continue;
      }
      tree[character][emotion] = fs
        .readdirSync(emotionDir)
        .filter((name) => /\.(png|jpg|jpeg|gif|webp)$/i.test(name))
        .map((name) => path.join("data", "chat", "meme", character, emotion, name));
    }
  }

  return tree;
}

export function savePluginConfig(pluginName: string, fileName: string, value: any): void {
  const filePath = path.join(process.cwd(), "config", pluginName, `${fileName}.json`);
  writeJsonFile(filePath, value);
}

export function getPluginConfigs(pluginName: string): Record<string, any> {
  const pluginDir = path.join(process.cwd(), "config", pluginName);
  if (!fs.existsSync(pluginDir)) {
    return {};
  }

  const result: Record<string, any> = {};
  const files = fs.readdirSync(pluginDir).filter((name) => name.endsWith(".json"));

  for (const file of files) {
    const filePath = path.join(pluginDir, file);
    result[path.basename(file, ".json")] = readJsonFile(filePath, {});
  }

  return result;
}
