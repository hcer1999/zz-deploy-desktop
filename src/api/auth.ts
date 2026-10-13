import { call } from "./ipc";

export interface AuthStatus {
  loggedIn: boolean;
  username: string;
  baseUrl: string;
  /** 恒为 "encryptedFile"：凭据存在应用数据目录的加密文件里，不用系统钥匙串 */
  credentialBackend: "encryptedFile";
  /** 凭据文件的实际路径，设置页会显示 */
  credentialPath: string;
}

export interface LoginResult {
  ok: boolean;
  message: string;
}

export function getAuthStatus(): Promise<AuthStatus> {
  return call<AuthStatus>("auth_status");
}

export function login(
  username: string,
  password: string,
  remember: boolean,
): Promise<LoginResult> {
  return call<LoginResult>("auth_login", { username, password, remember });
}

export function logout(): Promise<void> {
  return call<void>("auth_logout");
}

/** 只清除已保存的凭据，不影响当前会话 */
export function forgetCredentials(): Promise<void> {
  return call<void>("auth_forget_credentials");
}

export function relogin(): Promise<LoginResult> {
  return call<LoginResult>("auth_relogin");
}

export function setBaseUrl(baseUrl: string): Promise<void> {
  return call<void>("set_base_url", { baseUrl });
}
