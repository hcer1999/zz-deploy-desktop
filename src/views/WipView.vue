<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <div class="h-full flex items-center justify-center text-text-muted text-sm">
    「{{ title }}」将在后续计划中实现
  </div>
</template>
