<script setup lang="ts">
import { ref } from "vue";
import { useAuthStore } from "@/stores/auth";
import { useSettingsStore } from "@/stores/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

const auth = useAuthStore();
const settings = useSettingsStore();
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
</script>

<template>
  <div class="flex-1 flex items-center justify-center p-6">
    <div class="w-[380px] p-8 rounded-lg border border-border bg-surface shadow-xs">
      <h1 class="text-lg font-semibold mb-1">至真部署</h1>
      <p class="text-xs text-text-muted mb-6">使用 ITSM 账号登录</p>

      <div class="space-y-4">
        <div class="space-y-1.5">
          <Label for="login-username">用户名</Label>
          <Input
            id="login-username"
            v-model="username"
            placeholder="请输入用户名"
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
          勾选「记住密码」后密码会存入系统钥匙串，用于会话过期时自动续登。
        </p>
      </div>
    </div>
  </div>
</template>
