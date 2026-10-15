<script setup lang="ts">
import { ref } from "vue";
import { useAuthStore } from "@/stores/auth";
import { useSettingsStore } from "@/stores/settings";
import { useAppVersion } from "@/composables/useAppVersion";
import BrandLogo from "@/components/common/BrandLogo.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/*
 * 登录页：左侧品牌 + 右侧表单。
 *
 * 品牌区不是装饰——它是"这是内部工具、用 ITSM 账号登录"的第一眼说明，
 * 顺便把「至真部署」四个字用**品牌色**立起来（与 logo 同色，logo 用同一套线条动画）。
 * 窗口最小宽度 1024，所以两栏一直放得下；窄窗口（浏览器预览）时品牌区自动收起。
 */
const auth = useAuthStore();
const settings = useSettingsStore();
const version = useAppVersion();

const username = ref("");
const password = ref("");
const remember = ref(true);
const showAdvanced = ref(false);
const baseUrlDraft = ref(auth.baseUrl);

async function onSubmit(): Promise<void> {
  if (!username.value.trim() || !password.value) {
    auth.error = "请输入用户名和密码";
    return;
  }
  await auth.login(username.value.trim(), password.value, remember.value);
}

async function onSaveBaseUrl(): Promise<void> {
  // 必须走 settings store 的 changeBaseUrl：
  // 它会同时重建 Rust 侧 HttpClient 并让所有 store 重新读到新值
  await settings.changeBaseUrl(baseUrlDraft.value);
  baseUrlDraft.value = settings.baseUrl;
  showAdvanced.value = false;
}

/** 品牌区的三条说明：一句话讲清这个客户端多做了什么 */
const HIGHLIGHTS = [
  "自动化 / Docker 部署，选项目分支提交即构建",
  "实时构建日志：语法高亮、查找、进度原地刷新",
  "批量部署、收藏与失败一键重建",
];
</script>

<template>
  <div class="flex-1 min-h-0 flex items-stretch">
    <!-- 品牌区 -->
    <aside
      class="relative hidden lg:flex w-[46%] max-w-[560px] shrink-0 flex-col justify-between overflow-hidden border-r border-border bg-surface px-10 py-9"
    >
      <!-- 主题色柔光：与欢迎页同一手法，保证两屏视觉连续 -->
      <div
        class="pointer-events-none absolute -left-20 top-1/2 -translate-y-1/2 size-[420px] rounded-full bg-primary/10 blur-3xl"
        aria-hidden="true"
      />

      <div class="relative">
        <BrandLogo :size="64" class="shadow-sm" />

        <h1 class="mt-7 text-[32px] leading-none font-semibold tracking-[0.14em] text-brand">
          至真部署
        </h1>
        <p class="mt-3 text-sm text-text-muted">ITSM 部署桌面客户端</p>

        <ul class="mt-9 space-y-2.5">
          <li v-for="h in HIGHLIGHTS" :key="h" class="flex items-start gap-2 text-xs text-text-muted">
            <span class="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/70" />
            <span>{{ h }}</span>
          </li>
        </ul>
      </div>

      <p class="relative text-[11px] text-text-muted/70">
        {{ version ? `v${version}` : "" }}
      </p>
    </aside>

    <!-- 表单区 -->
    <div class="flex-1 min-w-0 flex items-center justify-center px-6 py-8 overflow-auto">
      <div class="w-[360px]">
        <div class="lg:hidden flex items-center gap-3 mb-6">
          <BrandLogo :size="32" />
          <span class="text-lg font-semibold tracking-[0.12em] text-brand">至真部署</span>
        </div>

        <h2 class="text-base font-semibold">登录</h2>
        <p class="mt-1 text-xs text-text-muted mb-6">使用你的 ITSM 账号</p>

        <div class="space-y-4">
          <div class="space-y-1.5">
            <Label for="login-username">用户名</Label>
            <Input
              id="login-username"
              v-model="username"
              placeholder="请输入用户名"
              autocomplete="username"
              :disabled="auth.loading"
              @keyup.enter="onSubmit"
            />
          </div>

          <div class="space-y-1.5">
            <Label for="login-password">密码</Label>
            <Input
              id="login-password"
              v-model="password"
              type="password"
              placeholder="请输入密码"
              autocomplete="current-password"
              :disabled="auth.loading"
              @keyup.enter="onSubmit"
            />
          </div>

          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <Switch id="remember" v-model="remember" :disabled="auth.loading" />
              <Label for="remember" class="text-text-muted font-normal">记住密码</Label>
            </div>
            <button
              type="button"
              class="text-xs text-text-muted hover:text-text underline underline-offset-2"
              @click="showAdvanced = !showAdvanced"
            >
              服务器
            </button>
          </div>

          <div v-if="showAdvanced" class="space-y-2 p-3 rounded-md bg-surface-2">
            <Label for="base-url" class="text-xs">ITSM 地址</Label>
            <Input id="base-url" v-model="baseUrlDraft" placeholder="https://itsm.zhizhengroup.com" />
            <Button variant="outline" size="sm" class="w-full" @click="onSaveBaseUrl">
              保存地址
            </Button>
          </div>

          <p v-if="auth.error" class="text-xs text-danger">{{ auth.error }}</p>

          <Button class="w-full" :disabled="auth.loading" @click="onSubmit">
            {{ auth.loading ? "登录中…" : "登录" }}
          </Button>

          <p class="text-[11px] text-text-muted leading-relaxed">
            勾选「记住密码」后，密码会加密保存在本机应用数据目录（不写系统钥匙串），
            用于会话过期时自动重登。
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
