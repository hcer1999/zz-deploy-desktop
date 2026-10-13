import { call } from "./ipc";

export interface AuthStatus {
  loggedIn: boolean;
  username: string;
  baseUrl: string;
  credentialBackend: "keyring" | "encryptedFile";
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

export function relogin(): Promise<LoginResult> {
  return call<LoginResult>("auth_relogin");
}

export function setBaseUrl(baseUrl: string): Promise<void> {
  return call<void>("set_base_url", { baseUrl });
}
