<script setup lang="ts">
import { onMounted, ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import TitleBar from "./components/layout/TitleBar.vue";
import SideNav from "./components/layout/SideNav.vue";
import TabBar from "./components/layout/TabBar.vue";
import TabHost from "./components/TabHost.vue";
import LoginView from "./views/LoginView.vue";
import WelcomeView from "./views/WelcomeView.vue";
import HomeView from "./views/HomeView.vue";
import { useTabsStore } from "./stores/tabs";
import { useAuthStore } from "./stores/auth";
import { useSettingsStore } from "./stores/settings";
import { useThemeStore } from "./stores/theme";
import { useFavoritesStore } from "./stores/favorites";
import { useBatchFavoritesStore } from "./stores/batchFavorites";
import { useBuildNotifications } from "./composables/useBuildNotifications";
import { registerLogEvents } from "./composables/useLogEvents";
import { useShortcuts } from "./composables/useShortcuts";
import { waitForAuthSettled } from "./composables/useBoot";
import { ENVS } from "./api/deploy";

const tabs = useTabsStore();
const auth = useAuthStore();

/**
 * 启动遮罩（欢迎页）是否还在挡住界面。
 *
 * 它解决的是"已经登录过、开软件却先闪一下登录页"：Rust 静默续登期间
 * `auth.loggedIn` 还是 false，直接渲染就是登录页。遮罩一直挂到
 * "登录状态有结论"（见 useBoot.ts）。
 */
const booting = ref(true);
/** 渐隐期间还要留在 DOM 里（否则 300ms 的淡出会跳没） */
const splashFading = ref(false);
/** Rust 侧静默续登是否已结束（auth://ready） */
const authSettled = ref(false);
const settings = useSettingsStore();
const theme = useThemeStore();
// 构建完成通知：本 composable 会在内部完成"状态跃迁 diff"与"通知点击"的订阅
const notify = useBuildNotifications();
// 应用级快捷键（Cmd/Ctrl+N/R/W/1-5/,）
useShortcuts();

/**
 * 启动步骤互不牵连。
 *
 * 这条链上任何一次 `await` 抛出，**后面全部不会执行**。原来的顺序把日志事件订阅
 * 排在设置/登录/收藏之后，于是一个失败的 `config_get` 就能把日志订阅一起带走——
 * 表现正是「日志标签一直不出新内容」而且毫无提示。所以：日志订阅提到最前，
 * 每步单独兜住异常（只记 console，不让后续步骤陪葬）。
 */
async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[startup] ${name} 失败`, e);
  }
}

onMounted(async () => {
  // 日志事件最先订阅：晚一步就可能丢掉刚打开标签时的前几帧
  await step("订阅日志事件", () => registerLogEvents(notify));

  await step("订阅 auth / tray 事件", async () => {
    // 续登失败 → 弹回登录页
    await listen<string>("auth://expired", (e) => auth.handleExpired(e.payload));
    // Rust 启动时的静默续登结束 → 刷新一次真实状态，并告诉欢迎页"有结论了"
    await listen("auth://ready", () => {
      authSettled.value = true;
      void auth.refresh();
    });
    // 托盘菜单：Rust 只负责"显示窗口"，开哪个标签由前端决定
    await listen<string>("tray://command", (e) => {
      if (e.payload === "new_deploy") tabs.open({ kind: "wizard" });
      else if (e.payload === "task_list") tabs.open({ kind: "list" });
    });
  });

  await step("加载设置", () => settings.load());
  // 主题紧跟设置：欢迎页也要用对主题，否则深色用户会先看到一屏浅色
  await step("应用主题", async () => theme.apply(settings.theme));
  await step("同步登录状态", () => auth.refresh());
  await step("加载收藏", async () => {
    const favorites = useFavoritesStore();
    await favorites.load();
    // 环境列表是硬编码的，用最新名字刷新收藏里存的旧环境名
    favorites.refreshEnvNames(ENVS);
  });
  await step("加载批量收藏", async () => {
    const batchFavorites = useBatchFavoritesStore();
    await batchFavorites.load();
    batchFavorites.refreshEnvNames(ENVS);
  });

  // 等"到底登录没有"有结论再撤遮罩（超时也会撤，不能让欢迎页一直挂着）
  const startedAt = Date.now();
  await step("等待登录状态", async () => {
    await waitForAuthSettled({
      isReady: () => authSettled.value,
      isLoggedIn: () => auth.loggedIn,
      refresh: () => auth.refresh(),
    });
  });
  // 结论来得太快（没存凭据）时也留一下：一是遮罩一闪而过反而像闪屏，
  // 二是要覆盖完 logo 的 draw-on（1.867s + 0.1s 延迟 ≈ 2s，见 BrandLogo），
  // 否则遮罩会在"画到一半"时撤掉
  const MIN_SPLASH_MS = 2150;
  const rest = MIN_SPLASH_MS - (Date.now() - startedAt);
  if (rest > 0) await new Promise((r) => setTimeout(r, rest));

  booting.value = false;
  splashFading.value = true;
  setTimeout(() => (splashFading.value = false), 300);
});
</script>

<template>
  <div class="relative h-full flex flex-col bg-bg text-text">
    <TitleBar />

    <!--
      启动遮罩：盖住登录页/主界面的"未定型"阶段。
      z-40 高于内容、低于标题栏之外的浮层（对话框 z-50），渐隐 300ms 后卸载。
    -->
    <div
      v-if="booting || splashFading"
      data-test="welcome"
      :class="[
        'absolute inset-x-0 bottom-0 top-10 z-40 flex bg-bg transition-opacity duration-300',
        booting ? 'opacity-100' : 'opacity-0 pointer-events-none',
      ]"
    >
      <WelcomeView />
    </div>

    <LoginView v-if="!auth.loggedIn" />

    <div v-else class="flex-1 flex min-h-0">
      <SideNav />
      <div class="flex-1 flex flex-col min-w-0">
        <TabBar />
        <main class="flex-1 min-h-0 overflow-auto">
          <TabHost v-if="tabs.tabs.length > 0" />
          <!-- 没打开标签时的落脚点：首页（启动器），不是一句空状态提示 -->
          <HomeView v-else />
        </main>
      </div>
    </div>
  </div>
</template>
