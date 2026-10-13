<script setup lang="ts">
import { ref, onMounted, watch, computed } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import { platform } from "@tauri-apps/plugin-os";
import { useSettingsStore } from "@/stores/settings";
import { useAuthStore } from "@/stores/auth";
import { useThemeStore } from "@/stores/theme";
import { forgetCredentials } from "@/api/auth";
import { useHistoryStore } from "@/stores/history";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";

const settings = useSettingsStore();
const auth = useAuthStore();
const themeStore = useThemeStore();
const history = useHistoryStore();

const baseUrlDraft = ref("");
const flash = ref("");
const forgetting = ref(false);
const forgotDone = ref(false);
const pendingClearLogs = ref(false);
const clearingLogs = ref(false);

onMounted(async () => {
  // 每次都重新读：不能因为"已加载过"就跳过，
  // 否则在别处（如登录页）改过地址后，这里会一直显示旧值。
  await settings.load();
  baseUrlDraft.value = settings.baseUrl;
  themeStore.apply(settings.theme);
  // 日志占用空间要现算，不然在历史页删过之后这里会显示旧值
  void history.load();
  // 关于分组：版本来自 tauri.conf.json，平台由 plugin-os 提供
  version.value = await getVersion();
  currentPlatform.value = platform();
});

// 地址在别处被改动时，输入框跟着更新，避免用户看到陈旧的草稿
watch(
  () => settings.baseUrl,
  (v) => {
    baseUrlDraft.value = v;
  },
);

function showFlash(msg: string): void {
  flash.value = msg;
  setTimeout(() => (flash.value = ""), 2500);
}

async function saveBaseUrl(): Promise<void> {
  await settings.changeBaseUrl(baseUrlDraft.value);
  baseUrlDraft.value = settings.baseUrl;
  showFlash("地址已保存，下次请求生效");
}

async function pickTheme(m: "system" | "light" | "dark"): Promise<void> {
  await settings.patch({ theme: m });
  themeStore.apply(m);
}

async function onForget(): Promise<void> {
  forgetting.value = true;
  try {
    await forgetCredentials();
    forgotDone.value = true;
    await auth.refresh();
    showFlash("已清除保存的凭据");
  } finally {
    forgetting.value = false;
  }
}

const backendLabel = (): string => "加密文件（应用数据目录）";

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "⌘/Ctrl + N", action: "新建部署" },
  { keys: "⌘/Ctrl + R", action: "刷新当前标签" },
  { keys: "⌘/Ctrl + W", action: "关闭当前标签" },
  { keys: "⌘/Ctrl + 1…5", action: "切换到第 N 个标签" },
  { keys: "⌘/Ctrl + ,", action: "打开设置" },
];

const version = ref("");
const currentPlatform = ref("");
const PLATFORM_LABEL: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};
const platformLabel = computed(() => PLATFORM_LABEL[currentPlatform.value] ?? currentPlatform.value);

function sizeText(bytes: number): string {  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 改完条数立刻按新策略清理一次：用户改这个值的目的就是"现在就瘦身"，
 * 等下次启动才生效会让人以为没生效（实测踩过）。
 */
async function onRetentionEntriesChange(e: Event): Promise<void> {
  const n = Number((e.target as HTMLInputElement).value);
  await settings.patch({ logRetentionEntries: n });
  const removed = await history.applyRetention();
  showFlash(removed > 0 ? `已按新策略删除 ${removed} 条` : "已按新策略清理");
}

/** 天数同理：改完立刻清一次，否则要等下次启动才生效 */
async function onRetentionDaysChange(e: Event): Promise<void> {
  const n = Number((e.target as HTMLInputElement).value);
  await settings.patch({ logRetentionDays: n });
  const removed = await history.applyRetention();
  showFlash(removed > 0 ? `已按新策略删除 ${removed} 条` : "已按新策略清理");
}

async function doClearLogs(): Promise<void> {
  clearingLogs.value = true;
  try {
    await history.clear();
    pendingClearLogs.value = false;
    showFlash("已清空全部日志");
  } finally {
    clearingLogs.value = false;
  }
}
</script>

<template>
  <div class="mx-auto max-w-[720px] p-6 space-y-8">
    <section class="space-y-3">
      <h2 class="text-xs font-semibold text-text-muted uppercase tracking-wider">服务</h2>
      <div class="space-y-1.5">
        <Label for="s-base-url">ITSM 地址</Label>
        <div class="flex gap-2">
          <Input id="s-base-url" v-model="baseUrlDraft" />
          <Button @click="saveBaseUrl">保存</Button>
        </div>
      </div>
      <div class="flex items-center justify-between text-xs py-1">
        <span class="text-text-muted">当前登录用户</span>
        <span>{{ auth.username || "未登录" }}</span>
      </div>
      <Button variant="outline" size="sm" @click="auth.logout()">退出登录</Button>
    </section>

    <section class="space-y-3">
      <h2 class="text-xs font-semibold text-text-muted uppercase tracking-wider">凭据</h2>
      <div class="flex items-center justify-between text-xs py-1">
        <span class="text-text-muted">存储方式</span>
        <span>{{ backendLabel() }}</span>
      </div>
      <div class="space-y-1 text-xs py-1">
        <span class="text-text-muted">存储位置</span>
        <p class="font-mono text-[11px] break-all text-text-muted">
          {{ auth.credentialPath || "—" }}
        </p>
      </div>

      <p class="text-xs text-warning leading-relaxed p-3 rounded-md bg-surface-2">
        凭据以 AES-256-GCM 加密后存在应用数据目录，<strong>不写入系统钥匙串</strong>——
        未签名应用读写钥匙串会每次启动都弹授权框，体验上等于每次都要重输密码。
        密钥与密文同机存放，只能防止明文外泄（文件被拷走、被随手打开都看不到密码），
        无法防御已经能在本机读取文件的攻击者。
      </p>

      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" :disabled="forgetting || forgotDone" @click="onForget">
          {{ forgotDone ? "凭据已清除" : forgetting ? "清除中…" : "清除已保存的凭据" }}
        </Button>
        <span class="text-[11px] text-text-muted">仅删除保存的密码，不影响当前会话</span>
      </div>
    </section>

    <section class="space-y-3">
      <h2 class="text-xs font-semibold text-text-muted uppercase tracking-wider">外观</h2>
      <div class="flex gap-2">
        <Button
          v-for="m in (['system', 'light', 'dark'] as const)"
          :key="m"
          :variant="settings.theme === m ? 'default' : 'outline'"
          size="sm"
          @click="pickTheme(m)"
        >
          {{ m === "system" ? "跟随系统" : m === "light" ? "浅色" : "深色" }}
        </Button>
      </div>
    </section>

    <section class="space-y-3">
      <h2 class="text-xs font-semibold text-text-muted uppercase tracking-wider">行为</h2>
      <div class="flex items-center justify-between">
        <Label for="s-close" class="font-normal">关闭窗口时最小化到托盘</Label>
        <Switch
          id="s-close"
          :model-value="settings.closeBehavior === 'tray'"
          @update:model-value="(v: boolean) => settings.patch({ closeBehavior: v ? 'tray' : 'quit' })"
        />
      </div>
      <div class="space-y-1.5">
        <Label for="s-poll" class="font-normal">列表轮询间隔（秒）</Label>
        <Input
          id="s-poll"
          type="number"
          :model-value="String(settings.pollIntervalSecs)"
          min="10"
          max="3600"
          @change="
            (e: Event) =>
              settings.patch({ pollIntervalSecs: Number((e.target as HTMLInputElement).value) })
          "
        />
      </div>
      <p class="text-[11px] text-text-muted">
        关闭到托盘后，应用会常驻系统托盘；构建完成且窗口不在前台时会发系统通知。
      </p>

      <!-- spec §6.2：通知触发条件可配（默认仅窗口失焦时） -->
      <div class="space-y-1.5 pt-1">
        <Label class="font-normal">构建完成通知</Label>
        <div class="flex gap-2">
          <Button
            v-for="m in (['unfocused', 'always'] as const)"
            :key="m"
            :variant="settings.notifyMode === m ? 'default' : 'outline'"
            size="sm"
            @click="settings.patch({ notifyMode: m })"
          >
            {{ m === "unfocused" ? "仅窗口失焦时" : "始终通知" }}
          </Button>
        </div>
      </div>
    </section>

    <section class="space-y-3">
      <h2 class="text-xs font-semibold text-text-muted uppercase tracking-wider">日志留存</h2>
      <div class="space-y-1.5">
        <Label for="s-retention-days" class="font-normal">保留天数</Label>
        <Input
          id="s-retention-days"
          type="number"
          :model-value="String(settings.logRetentionDays)"
          min="1"
          max="3650"
          @change="onRetentionDaysChange"
        />
      </div>
      <div class="space-y-1.5">
        <Label for="s-retention-entries" class="font-normal">最大条数</Label>
        <Input
          id="s-retention-entries"
          type="number"
          :model-value="String(settings.logRetentionEntries)"
          min="1"
          max="10000"
          @change="onRetentionEntriesChange"
        />
      </div>
      <div class="flex items-center justify-between text-xs py-1">
        <span class="text-text-muted">当前占用</span>
        <span>{{ history.entries.length }} 条 · {{ sizeText(history.totalSize) }}</span>
      </div>
      <p class="text-[11px] text-text-muted">
        只留存你主动打开过日志的任务；超出策略的日志会被自动删除（包括正文文件）。
      </p>
      <Button
        variant="outline"
        size="sm"
        class="text-danger hover:text-danger"
        :disabled="history.entries.length === 0"
        @click="pendingClearLogs = true"
      >
        清空全部日志
      </Button>
    </section>

    <p v-if="flash" class="text-xs text-success">{{ flash }}</p>

    <section class="space-y-2">
      <h2 class="text-xs font-semibold text-text-muted uppercase tracking-wider">关于</h2>
      <div class="flex items-center justify-between text-xs py-1">
        <span class="text-text-muted">版本</span>
        <span class="font-mono text-[11px]">{{ version || "—" }}</span>
      </div>
      <div class="flex items-center justify-between text-xs py-1">
        <span class="text-text-muted">当前平台</span>
        <span>{{ platformLabel || "—" }}</span>
      </div>
      <table class="w-full text-xs">
        <tbody>
          <tr
            v-for="row in SHORTCUTS"
            :key="row.keys"
            class="border-b border-border last:border-0"
          >
            <td class="py-1.5 pr-4 w-40 font-mono text-[11px] text-text-muted whitespace-nowrap">
              {{ row.keys }}
            </td>
            <td class="py-1.5">{{ row.action }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <ConfirmDialog
      :open="pendingClearLogs"
      title="清空全部历史日志？"
      description="将删除所有已留存的日志文件，不可恢复"
      confirm-text="清空"
      danger
      :loading="clearingLogs"
      @update:open="
        (v: boolean) => {
          if (!v) pendingClearLogs = false;
        }
      "
      @confirm="doClearLogs"
    />
  </div>
</template>
