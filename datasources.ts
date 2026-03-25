import { connectedBots, logger } from "mioki";

export interface DatasourceOption {
  value: string;
  label: string;
  description?: string;
  meta?: Record<string, any>;
}

export interface DatasourceQuery {
  q?: string;
  limit?: number;
}

export type DatasourceProvider = (
  query?: DatasourceQuery,
) => Promise<DatasourceOption[]>;

const datasources = new Map<string, DatasourceProvider>();

export function registerDatasource(name: string, provider: DatasourceProvider): void {
  datasources.set(name, provider);
  logger.info(`Registered datasource: ${name}`);
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function matchesQuery(option: DatasourceOption, query?: string): boolean {
  const q = normalizeText(query);
  if (!q) {
    return true;
  }

  const haystacks = [
    option.value,
    option.label,
    option.description,
    option.meta?.searchText,
    option.meta?.qq,
    option.meta?.groupId,
    option.meta?.nickname,
    option.meta?.remark,
    option.meta?.groupName,
  ]
    .map((item) => normalizeText(item))
    .filter(Boolean);

  return haystacks.some((item) => item.includes(q));
}

function limitOptions(
  options: DatasourceOption[],
  limit?: number,
): DatasourceOption[] {
  if (!limit || limit <= 0) {
    return options;
  }
  return options.slice(0, limit);
}

export async function getDatasource(
  name: string,
  query?: DatasourceQuery,
): Promise<DatasourceOption[]> {
  const provider = datasources.get(name);
  if (!provider) {
    logger.warn(`Datasource not found: ${name}`);
    return [];
  }

  try {
    const options = await provider(query);
    return limitOptions(
      options.filter((option) => matchesQuery(option, query?.q)),
      query?.limit,
    );
  } catch (error: any) {
    logger.error(`Failed to fetch datasource ${name}: ${error.message}`);
    return [];
  }
}

export function listDatasources(): string[] {
  return Array.from(datasources.keys());
}

function buildFriendAvatar(userId: string): string {
  return `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(userId)}&s=100`;
}

function buildGroupAvatar(groupId: string): string {
  return `https://p.qlogo.cn/gh/${encodeURIComponent(groupId)}/${encodeURIComponent(groupId)}/100`;
}

function getConnectedBots(): any[] {
  return Array.from(connectedBots.values()).filter(Boolean);
}

async function fetchFriendOptions(): Promise<DatasourceOption[]> {
  const bots = getConnectedBots();
  const merged = new Map<string, DatasourceOption>();

  await Promise.all(
    bots.map(async (bot) => {
      const list = await bot.getFriendList().catch(() => []);
      for (const item of Array.isArray(list) ? list : []) {
        const userId = String(item?.user_id ?? "").trim();
        if (!userId) {
          continue;
        }
        const nickname = String(item?.nickname ?? "").trim();
        const remark = String(item?.remark ?? "").trim();
        const label = remark || nickname || userId;
        merged.set(userId, {
          value: userId,
          label,
          description: `QQ ${userId}${nickname && remark && nickname !== remark ? ` · ${nickname}` : ""}`,
          meta: {
            type: "qq_friend",
            qq: userId,
            nickname,
            remark,
            avatarUrl: buildFriendAvatar(userId),
            searchText: [userId, nickname, remark].filter(Boolean).join(" "),
          },
        });
      }
    }),
  );

  return Array.from(merged.values()).sort((a, b) =>
    a.label.localeCompare(b.label, "zh-Hans-CN"),
  );
}

async function fetchGroupOptions(): Promise<DatasourceOption[]> {
  const bots = getConnectedBots();
  const merged = new Map<string, DatasourceOption>();

  await Promise.all(
    bots.map(async (bot) => {
      const list = await bot.getGroupList().catch(() => []);
      for (const item of Array.isArray(list) ? list : []) {
        const groupId = String(item?.group_id ?? "").trim();
        if (!groupId) {
          continue;
        }
        const groupName = String(item?.group_name ?? "").trim() || groupId;
        const memberCount = Number(item?.member_count);
        merged.set(groupId, {
          value: groupId,
          label: groupName,
          description: Number.isFinite(memberCount)
            ? `${groupId} · ${memberCount} 人`
            : `群号 ${groupId}`,
          meta: {
            type: "qq_group",
            groupId,
            groupName,
            memberCount: Number.isFinite(memberCount) ? memberCount : undefined,
            avatarUrl: buildGroupAvatar(groupId),
            searchText: [groupId, groupName].filter(Boolean).join(" "),
          },
        });
      }
    }),
  );

  return Array.from(merged.values()).sort((a, b) =>
    a.label.localeCompare(b.label, "zh-Hans-CN"),
  );
}

// Built-in datasources
export function initBuiltinDatasources(): void {
  // QQ groups datasource
  registerDatasource("qq_groups", async () => {
    return fetchGroupOptions();
  });

  // QQ friends datasource
  registerDatasource("qq_friends", async () => {
    return fetchFriendOptions();
  });
}
