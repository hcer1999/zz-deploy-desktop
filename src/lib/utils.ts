import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn-vue 依赖的类名合并工具：先 clsx 拼接，再用 tailwind-merge 去掉冲突 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
