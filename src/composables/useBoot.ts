/**
 * 启动期的登录判定。
 *
 * 背景：Rust 启动时会用已保存的凭据**静默续登**，这个过程要走一次网络
 * （GET /login/ → POST /login/ → 探活请求），期间 `auth_status` 仍会如实回答
 * "当前没登录"。前端如果照它直接渲染登录页，已经登录过的人每次开软件都会看到
 * 登录页闪一下。所以启动时要等一个"有结论"的时刻：
 *
 * - Rust 静默续登结束会发 `auth://ready`（`isReady` 变真）
 * - 或者轮询发现已经登录了
 * - 再或者兜底超时（网络卡住时不能让欢迎页一直挂着）
 *
 * 抽成独立函数是为了能单测：真实调用要挂载整个 App、mock 一堆 IPC，成本高且容易漏分支。
 */
export interface AuthProbe {
  /** `auth://ready` 是否已经收到 */
  isReady: () => boolean;
  isLoggedIn: () => boolean;
  /** 重新读一次真实状态（auth_status） */
  refresh: () => Promise<void>;
}

export interface WaitOptions {
  /** 兜底超时，默认 6s */
  timeoutMs?: number;
  /** 轮询间隔，默认 150ms */
  intervalMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 等到登录状态有结论。返回是否已登录（超时未登录 = false，此时该显示登录页了）。
 *
 * 注意：**首次判断放在轮询之后**，因为调用方通常已经先 `auth.refresh()` 过一次；
 * 这里再读一次的成本是一次本地 IPC，可以忽略。
 */
export async function waitForAuthSettled(
  probe: AuthProbe,
  opts: WaitOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const intervalMs = opts.intervalMs ?? 150;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (probe.isLoggedIn()) return true;
    // Rust 说它已经结束续登了：这时候还没登录就是真的没登录
    if (probe.isReady()) return false;
    if (Date.now() >= deadline) return probe.isLoggedIn();

    await sleep(intervalMs);
    try {
      await probe.refresh();
    } catch {
      // 读状态失败不该把欢迎页卡住；下一轮再试，最终由超时兜底
    }
  }
}
