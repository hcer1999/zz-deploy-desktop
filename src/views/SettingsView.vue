<script setup lang="ts">
import { ref, onMounted, watch } from "vue";
import { useSettingsStore } from "@/stores/settings";
import { useAuthStore } from "@/stores/auth";
import { useThemeStore } from "@/stores/theme";
import { forgetCredentials } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

const settings = useSettingsStore();
const auth = useAuthStore();
const themeStore = useThemeStore();

const baseUrlDraft = ref("");
const flash = ref("");
const forgetting = ref(false);
const forgotDone = ref(false);

onMounted(async () => {
  // 每次都重新读：不能因为"已加载过"就跳过，
  // 否则在别处（如登录页）改过地址后，这里会一直显示旧值。
  await settings.load();
  baseUrlDraft.value = settings.baseUrl;
  themeStore.apply(settings.theme);
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

const backendLabel = (): string =>
  auth.credentialBackend === "keyring" ? "系统钥匙串" : "加密文件";
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

      <p
        v-if="auth.credentialBackend === 'encryptedFile'"
        class="text-xs text-warning leading-relaxed p-3 rounded-md bg-surface-2"
      >
        本机未检测到可用的系统钥匙串，密码以加密文件形式保存在应用数据目录。
        该文件的密钥与密文同机存放，只能防止明文外泄，无法防御能在本机读取文件的攻击者。
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
        托盘常驻与构建完成通知将在后续计划（P6）实现；上述选项现在就会被持久化。
      </p>
    </section>

    <p v-if="flash" class="text-xs text-success">{{ flash }}</p>
  </div>
</template>
