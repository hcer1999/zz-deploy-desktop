import { invoke } from "@tauri-apps/api/core";

/**
 * invoke 的类型化薄封装。
 *
 * Tauri 在命令返回 Err 时，抛出的是命令 error 载荷本身（即 AppError 形状的对象），
 * 所以这里不做任何转换，交给 http.ts / store 统一收口。
 */
export function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}
