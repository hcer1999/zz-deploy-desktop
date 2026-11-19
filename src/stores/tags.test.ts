import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/api/tags", () => ({
  listTags: vi.fn(),
  upsertTag: vi.fn(),
  deleteTag: vi.fn(),
}));

import * as api from "@/api/tags";
import { useTagsStore, DEFAULT_TAG_COLOR } from "./tags";

describe("tags store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("load 之后按名字查颜色", async () => {
    vi.mocked(api.listTags).mockResolvedValue([{ name: "线上", color: "#f87171" }]);
    const s = useTagsStore();
    await s.load();
    expect(s.colorOf("线上")).toBe("#f87171");
    expect(s.loaded).toBe(true);
  });

  it("未登记的标签按名字稳定兜底（同名同色）", () => {
    const s = useTagsStore();
    const a = s.colorOf("临时");
    expect(a).toBe(s.colorOf("临时"));
    expect(a).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("未登记时用中性灰兜底也不会崩", () => {
    const s = useTagsStore();
    expect(s.colorOf("")).toBe(DEFAULT_TAG_COLOR);
  });

  it("upsert 用命令返回的新表替换本地状态", async () => {
    vi.mocked(api.listTags).mockResolvedValue([]);
    const s = useTagsStore();
    await s.load();

    vi.mocked(api.upsertTag).mockResolvedValue([{ name: "线上", color: "#34d399" }]);
    await s.upsert({ name: "线上", color: "#34d399" });
    expect(api.upsertTag).toHaveBeenCalledWith({ name: "线上", color: "#34d399" });
    expect(s.colorOf("线上")).toBe("#34d399");
  });

  it("改名走 oldName 并更新本地表", async () => {
    vi.mocked(api.listTags).mockResolvedValue([{ name: "线上", color: "#f87171" }]);
    const s = useTagsStore();
    await s.load();

    vi.mocked(api.upsertTag).mockResolvedValue([{ name: "生产", color: "#f87171" }]);
    await s.upsert({ oldName: "线上", name: "生产", color: "#f87171" });
    expect(api.upsertTag).toHaveBeenCalledWith({
      oldName: "线上",
      name: "生产",
      color: "#f87171",
    });
    expect(s.byName.has("线上")).toBe(false);
    expect(s.colorOf("生产")).toBe("#f87171");
  });

  it("remove 删除后本地不再有该标签", async () => {
    vi.mocked(api.listTags).mockResolvedValue([
      { name: "线上", color: "#f87171" },
      { name: "紧急", color: "#fbbf24" },
    ]);
    const s = useTagsStore();
    await s.load();

    vi.mocked(api.deleteTag).mockResolvedValue([{ name: "紧急", color: "#fbbf24" }]);
    await s.remove("线上");
    expect(api.deleteTag).toHaveBeenCalledWith("线上");
    expect(s.byName.has("线上")).toBe(false);
  });
});
