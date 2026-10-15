import { call } from "./ipc";

export interface AppConfig {
  baseUrl: string;
  theme: "system" | "dark" | "light";
  username: string;
  closeBehavior: "tray" | "quit";
  pollIntervalSecs: number;
  logRetentionDays: number;
  logRetentionEntries: number;
  /** "always"（默认：不管窗口是否在前台都弹）| "unfocused"（仅窗口失焦时） */
  notifyMode: "unfocused" | "always";
  /** 侧边栏是否展开（重启后保持） */
  sidebarExpanded: boolean;
  /** 上次在向导里用的部署类型（下次打开向导预填） */
  lastDeployType: "auto" | "docker";
  /** 上次在向导里选的环境 id；null = 还没选过（首次运行不预填） */
  lastEnvId: number | null;
}

export function getConfig(): Promise<AppConfig> {
  return call<AppConfig>("config_get");
}

export function setConfig(patch: AppConfig): Promise<AppConfig> {
  return call<AppConfig>("config_set", { patch });
}
