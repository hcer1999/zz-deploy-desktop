<script setup lang="ts">
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const props = defineProps<{
  open: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  loading?: boolean;
}>();

const emit = defineEmits<{ "update:open": [boolean]; confirm: []; cancel: [] }>();

function onOpenChange(v: boolean): void {
  emit("update:open", v);
  // 关闭（含点遮罩、按 Esc）一律视作取消，调用方据此清掉待处理状态
  if (!v) emit("cancel");
}
</script>

<template>
  <Dialog :open="props.open" @update:open="onOpenChange">
    <DialogContent class="max-w-[380px]">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription v-if="description">{{ description }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" :disabled="loading" @click="onOpenChange(false)">
          {{ cancelText ?? "取消" }}
        </Button>
        <Button
          :variant="danger ? 'destructive' : 'default'"
          :disabled="loading"
          @click="emit('confirm')"
        >
          {{ loading ? "处理中…" : (confirmText ?? "确认") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
