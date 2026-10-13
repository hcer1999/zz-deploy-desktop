import { defineStore } from "pinia";
import { ref } from "vue";
import type { DeployType } from "@/api/deploy";
import type { DeployTask, PageInfo } from "@/api/parser";

/** Task 6 只建骨架，Task 8 填充 refresh / 分页 / 搜索，Task 10 加轮询 */
export const useTasksStore = defineStore("tasks", () => {
  const deployType = ref<DeployType>("auto");
  const page = ref(1);
  const search = ref("");
  const tasks = ref<DeployTask[]>([]);
  const pageInfo = ref<PageInfo>({
    currentPage: 1,
    totalPages: 1,
    hasPrev: false,
    hasNext: false,
  });
  const loading = ref(false);

  return { deployType, page, search, tasks, pageInfo, loading };
});
