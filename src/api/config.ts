import { call } from "./ipc";

export interface AppConfig {
  baseUrl: string;
  theme: "system" | "dark" | "light";
  username: string;
  closeBehavior: "tray" | "quit";
  pollIntervalSecs: number;
  logRetentionDays: number;
  logRetentionEntries: number;
  /** "unfocused"（仅窗口失焦时，默认）| "always"	*/
  notifyMode: "unfocused" | "always";
}

export function getConfig(): Promise<AppConfig> {
  return call<AppConfig>("config_get");
}

export function setConfig(patch: AppConfig): Promise<AppConfig> {
  return call<AppConfig>("config_set", { patch });
}
