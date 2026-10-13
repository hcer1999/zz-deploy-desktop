import { call } from "./ipc";

export interface AppConfig {
  baseUrl: string;
  theme: "system" | "dark" | "light";
  username: string;
  closeBehavior: "tray" | "quit";
  pollIntervalSecs: number;
}

export function getConfig(): Promise<AppConfig> {
  return call<AppConfig>("config_get");
}

export function setConfig(patch: AppConfig): Promise<AppConfig> {
  return call<AppConfig>("config_set", { patch });
}
