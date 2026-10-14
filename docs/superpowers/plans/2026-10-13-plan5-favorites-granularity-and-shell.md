# Plan 5：收藏粒度、可搜索下拉与应用外壳 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让收藏支持「仅项目 / 项目+分支」两种粒度，收藏页部署时分支可改；把 commit/分支选择换成可搜索下拉；窗口标题与侧边栏按新需求调整。

**Architecture:** 后端 `Favorite` 模型（`type` + 可选 `branch`）**已经支持**两种粒度，去重键也已兼容，因此本次**不改数据模型**，只补前端入口与交互；新增一个基于 reka-ui Combobox 的可搜索下拉组件，替换原生 `<select>`；侧边栏展开状态作为一个新的配置项持久化到 `config.json`。

**Tech Stack:** Vue 3 + Pinia + Tailwind + shadcn-vue/reka-ui（Combobox）、Rust/tauri-plugin-store。

**关于本计划的形式**：写出每处改动的**接口、关键代码、测试与命令**，但不再像 Plan 1–4 那样逐行粘贴全部实现——本次由同一会话内联执行，逐行重复会在文档与代码间产生两份真值。测试与验收步骤一律给全。

---

## 决策摘要（用户已确认）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 版本号 | 真的改成 `0.0.1`（`package.json` + `tauri.conf.json`），标题取**运行时版本**，三处不会漂移 |
| 2 | 窗口标题 | `至真部署-桌面版 Ver0.0.1`（TitleBar 显示，并用 `setTitle` 同步到原生窗口标题） |
| 3 | 侧边栏 | **点击**展开/收起，状态写入 `config.json`（默认折叠，保留现状外观） |
| 4 | 下拉组件 | commit（向导 + 收藏页）与**收藏页的分支**换成可搜索下拉；**向导的分支保留按钮组**（一眼看全、点得快） |
| 5 | 收藏是否记 commit | **不记**。`Favorite` 不加 commit 字段，保持与 VSCode 插件的收藏文件互相兼容 |
| 6 | 收藏页改的分支是否写回收藏 | **不写回**。只是本次部署的临时覆盖，避免"改一次就永久改掉收藏"这种意外副作用 |

**为什么规格要求"可搜索"**：spec §5.4 原文就写着「Commit：**可搜索**下拉 —— commit message 很长，原生 select 不可用」。现状用的是原生 `<select>`，属于实现与 spec 不符，本次一并纠正。

---

## 文件结构

```
src-tauri/src/commands/config.rs        AppConfig 增加 sidebarExpanded
src-tauri/capabilities/default.json     加 core:window:allow-set-title
src-tauri/tauri.conf.json               版本 0.0.1；window.title 改为「至真部署-桌面版」
src-tauri/Cargo.toml / package.json     版本 0.0.1

src/api/config.ts                       AppConfig 类型加 sidebarExpanded
src/stores/settings.ts                  sidebarExpanded + patch
src/components/layout/SideNav.vue       可展开 + 显示导航名 + 持久化
src/components/layout/TitleBar.vue      标题取运行时版本并 setTitle
src/components/common/SearchSelect.vue  新增：可搜索下拉（reka-ui Combobox 封装）
src/views/DeployWizard.vue              收藏粒度入口（收藏此项目 / 收藏此分支）+ commit 用下拉
src/views/FavoritesView.vue             分支可改 + commit 下拉 + 粒度标签
docs/superpowers/specs/...design.md     同步 §5.1 / §5.4 / §5.5 / §7
```

---

## Task 1: 配置项 sidebarExpanded（Rust + 前端）

**Files:**
- Modify: `src-tauri/src/commands/config.rs`
- Modify: `src/api/config.ts`、`src/stores/settings.ts`
- Test: `src-tauri/src/commands/config.rs`（内联测试）、`src/stores/settings.test.ts`

- [ ] **Step 1: 写失败的测试（Rust）**

```rust
#[test]
fn invalid_bool_config_falls_back_to_collapsed() {
    assert!(!normalize_sidebar_expanded(None));
    assert!(normalize_sidebar_expanded(Some(true)));
}

#[test]
fn config_serializes_sidebar_expanded_as_camel_case() {
    let v = serde_json::to_value(AppConfig::default()).unwrap();
    assert_eq!(v["sidebarExpanded"], serde_json::json!(false));
}
```

- [ ] **Step 2: 运行确认失败**

```bash
cd src-tauri && cargo test --lib config 2>&1 | grep -E "^error" | head -3
```
预期：找不到 `normalize_sidebar_expanded`

- [ ] **Step 3: 实现**

`AppConfig` 增加 `pub sidebar_expanded: bool`（默认 `false`）；`load` 里读 `store.get("sidebarExpanded").and_then(|v| v.as_bool())`；`save` 里 `store.set("sidebarExpanded", json!(cfg.sidebar_expanded))`。

- [ ] **Step 4: 前端类型与 store**

`src/api/config.ts` 的 `AppConfig` 加 `sidebarExpanded: boolean`；`src/stores/settings.ts` 加 ref、`apply()` 赋值、`patch()` 回填（**必须回填**，否则改主题会把展开状态写回默认）。

前端测试（`settings.test.ts`）：

```ts
it("patch 只改主题时不会把侧边栏展开状态写回默认", async () => {
  vi.mocked(configApi.getConfig).mockResolvedValue({ ...CONFIG, sidebarExpanded: true });
  vi.mocked(configApi.setConfig).mockImplementation(async (p) => p);
  const s = useSettingsStore();
  await s.load();
  await s.patch({ theme: "light" });
  expect(vi.mocked(configApi.setConfig).mock.calls[0][0].sidebarExpanded).toBe(true);
});
```

- [ ] **Step 5: 验证并提交**

```bash
cd src-tauri && cargo test 2>&1 | grep -E "^test result" | head -1
cd .. && npm test 2>&1 | grep -E "Tests "
git add -A && git commit -m "feat(config): 侧边栏展开状态持久化到 config.json"
```

---

## Task 2: 应用外壳（版本 0.0.1 + 窗口标题 + 侧边栏展开）

**Files:**
- Modify: `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/capabilities/default.json`
- Modify: `src/components/layout/TitleBar.vue`、`src/components/layout/SideNav.vue`
- Test: `src/components/layout/SideNav.test.ts`、`src/components/layout/TitleBar.test.ts`（新增）

- [ ] **Step 1: 版本号**

`package.json` 与 `src-tauri/tauri.conf.json` 的 `version` 都改 `0.0.1`；`tauri.conf.json` 的 `app.windows[0].title` 改 `至真部署-桌面版`（占位，运行时再补版本）。

- [ ] **Step 2: 写失败的测试（TitleBar）**

```ts
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.0.1") }));
it("标题显示 名称 + Ver 版本", async () => {
  const w = mount(TitleBar);
  await flushPromises();
  expect(w.text()).toContain("至真部署-桌面版 Ver0.0.1");
});
```

- [ ] **Step 3: 实现 TitleBar**

```ts
const version = ref("");
const title = computed(() => `至真部署-桌面版${version.value ? ` Ver${version.value}` : ""}`);
onMounted(async () => {
  version.value = await getVersion();
  // 原生窗口标题（Dock / 任务栏 / 窗口菜单）跟随同一份版本，避免两处漂移
  await getCurrentWindow().setTitle(title.value);
});
```
`capabilities/default.json` 的 permissions 追加 `"core:window:allow-set-title"`。

- [ ] **Step 4: 写失败的测试（SideNav）**

```ts
it("默认折叠，只有图标", () => { ... expect(w.find("span").exists()).toBe(false) })
it("点击后展开并显示导航名，且持久化", async () => {
  await w.find('[data-test="sidebar-toggle"]').trigger("click");
  expect(w.text()).toContain("任务列表");
  expect(sent.sidebarExpanded).toBe(true);
})
```

- [ ] **Step 5: 实现 SideNav**

- 宽度：折叠 `w-14` → 展开 `w-[180px]`，`transition-[width] duration-150`
- 展开时在图标右侧渲染 label；折叠时保留 `title`/`aria-label` 作为 tooltip
- 顶部一个切换按钮（`PanelLeftClose` / `PanelLeftOpen` 图标，`data-test="sidebar-toggle"`），点击调 `settings.patch({ sidebarExpanded: !settings.sidebarExpanded })`
- 导航项：`justify-start`（折叠时居中用 `justify-center` 条件类）

- [ ] **Step 6: 验证并提交**

```bash
npm test 2>&1 | grep -E "Tests " && npx vue-tsc --noEmit && echo "类型检查 ✓"
git add -A && git commit -m "feat: 窗口标题带版本、侧边栏可展开显示导航名、版本号改为 0.0.1"
```

---

## Task 3: 可搜索下拉组件 SearchSelect

**Files:**
- Create: `src/components/common/SearchSelect.vue`
- Test: `src/components/common/SearchSelect.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
const OPTIONS = [
  { value: "a1b2c3d4#-----#修复黑屏", label: "a1b2c3d4 修复黑屏" },
  { value: "e5f6a7b8#-----#新增榜单", label: "e5f6a7b8 新增榜单" },
];
it("输入关键字只保留匹配项", async () => {
  const w = mount(SearchSelect, { props: { modelValue: "", options: OPTIONS } });
  await w.find("input").setValue("榜单");
  expect(w.text()).toContain("新增榜单");
  expect(w.text()).not.toContain("修复黑屏");
});
it("点选后向上抛出选中值", async () => { ... expect(w.emitted("update:modelValue")![0]).toEqual([OPTIONS[0].value]) });
it("没有匹配项时显示空态", async () => { ... });
it("disabled 时不可输入", () => { ... });
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run src/components/common/SearchSelect.test.ts` → 找不到模块

- [ ] **Step 3: 实现**

reka-ui `Combobox` 封装（`ComboboxRoot` / `ComboboxAnchor` / `ComboboxInput` / `ComboboxTrigger` / `ComboboxPortal` / `ComboboxContent` / `ComboboxViewport` / `ComboboxItem` / `ComboboxItemIndicator` / `ComboboxEmpty`）：

```ts
const props = withDefaults(defineProps<{
  modelValue: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  class?: string;
}>(), { placeholder: "请选择", emptyText: "没有匹配项", disabled: false });
const emit = defineEmits<{ "update:modelValue": [string] }>();

const open = ref(false);
const labelOf = (v: string) => props.options.find((o) => o.value === v)?.label ?? "";
```

要点：
- `v-model:open="open"`、`:model-value="modelValue"`、`@update:model-value="(v) => emit('update:modelValue', String(v ?? ''))"`
- `ComboboxInput` 的 `:display-value="labelOf"`（失焦时显示选中项文本，聚焦时是搜索词）
- `open-on-click` / `open-on-focus` 打开列表；`ignore-filter` 保持 false（用内置过滤）
- 样式语言与 `ui/select/*` 一致（`bg-popover`/`border-border`/`text-text-muted`，选中项打勾）
- 长文本 `truncate`，`min-w-(--reka-combobox-trigger-width)`

- [ ] **Step 4: 验证并提交**

```bash
npx vitest run src/components/common/SearchSelect.test.ts 2>&1 | tail -5
npx vue-tsc --noEmit
git add -A && git commit -m "feat: 新增可搜索下拉组件（reka-ui Combobox 封装）"
```

---

## Task 4: 向导支持两种收藏粒度 + commit 换下拉

**Files:**
- Modify: `src/views/DeployWizard.vue`
- Test: `src/views/DeployWizard.test.ts`（新增）

- [ ] **Step 1: 写失败的测试**

```ts
it("选中项目后即可保存「项目级」收藏（type=project，不带分支）", async () => {
  const w = await mountWizard();            // 已 mock @/api/deploy：项目/分支/commit
  await w.find('[data-test="fav-project"]').trigger("click");
  await confirm(w);                          // ConfirmDialog 的确认按钮
  await flushPromises();
  expect(vi.mocked(api.saveFavorite).mock.calls[0][0]).toMatchObject({
    type: "project", projectId: 7, branch: undefined,
  });
});

it("选中分支后可保存「分支级」收藏（type=config + branch）", async () => {
  ... expect(payload).toMatchObject({ type: "config", branch: "main" });
});

it("没选项目时没有收藏入口", async () => { expect(w.find('[data-test="fav-project"]').exists()).toBe(false); });
it("commit 列表用下拉组件渲染（不是原生 select）", async () => {
  expect(w.find("select").exists()).toBe(false);
  expect(w.findComponent(SearchSelect).exists()).toBe(true);
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

- 项目区标题行加按钮 `data-test="fav-project"`（`v-if="selectedProject"`）→ `favTarget = "project"`
- 分支区标签行加按钮 `data-test="fav-branch"`（`v-if="selectedBranch"`）→ `favTarget = "branch"`
- 一个 `ConfirmDialog`（`:open="favTarget !== null"`），标题/描述按粒度变化，`@confirm="onSaveFavorite"`
- `onSaveFavorite()`：

```ts
const payload: Favorite = {
  id: "",
  type: favTarget.value === "project" ? "project" : "config",
  deployType: deployType.value,
  envId: envId.value!, envName: envName.value,
  projectId: selectedProject.value.id, projectName: selectedProject.value.name,
  // 仅项目级收藏不带分支：收藏页部署时再选
  branch: favTarget.value === "branch" ? selectedBranch.value : undefined,
};
await favorites.save(payload);
```
- commit 选择由原生 `<select>` 换成 `SearchSelect`（options 由 `commits` 映射，`label = hash.slice(0,8) + " " + message`）
- 删掉提交区里旧的「保存为收藏」按钮与其 ConfirmDialog

- [ ] **Step 4: 验证并提交**

```bash
npx vitest run src/views/DeployWizard.test.ts 2>&1 | tail -6
npx vue-tsc --noEmit && npm test 2>&1 | grep -E "Tests "
git add -A && git commit -m "feat(wizard): 支持项目级/分支级两种收藏粒度，commit 改为可搜索下拉"
```

---

## Task 5: 收藏页分支可改 + commit 下拉 + 粒度标签

**Files:**
- Modify: `src/views/FavoritesView.vue`
- Test: `src/views/FavoritesView.test.ts`（扩充）

- [ ] **Step 1: 写失败的测试**

```ts
it("项目级收藏：展开后自动拉分支列表，选完分支再拉 commit", async () => {
  // fav = { type: "project", branch: undefined }
  await expand(w);
  expect(api.fetchBranches).toHaveBeenCalled();
  expect(api.fetchCommits).not.toHaveBeenCalled();     // 还没选分支
  await pickBranch(w, "main");
  expect(api.fetchCommits).toHaveBeenCalledWith("proj-AAA", "main");
});

it("分支级收藏：预选记忆的分支，但仍可改成别的分支并重拉 commit", async () => {
  // fav = { type: "config", branch: "main" }
  await expand(w);
  expect(api.fetchCommits).toHaveBeenLastCalledWith("proj-AAA", "main");   // 预选即拉
  await pickBranch(w, "dev");
  expect(api.fetchCommits).toHaveBeenLastCalledWith("proj-AAA", "dev");
  expect(api.fetchCommits).toHaveBeenCalledTimes(2);
});

it("提交用当前选中的分支与 commit，且不改动收藏本身", async () => {
  await submit(w);
  expect(api.submitDeploy).toHaveBeenCalledWith("auto", 1, { title: "", branchtag: "dev", version: "..." });
  expect(api.saveFavorite).not.toHaveBeenCalled();
});

it("行内标签区分两种粒度", async () => {
  expect(w.text()).toContain("仅项目");
  expect(w.text()).toContain("项目+分支");
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

- `Draft` 的 `branch` 现在总是被下拉使用；展开时：`await loadBranches(id)`（总是），若 `fav.branch` 则 `d.branch = fav.branch; await loadCommits(id)`
- 分支区改为 `SearchSelect`（`options = d.branches.map(b => ({ value: b, label: b }))`，`@update:model-value="onBranchChange(id, $event)"`）
- `onBranchChange`：写 `d.branch`、清空 `d.commit` 与 `d.commits`、`await loadCommits(id)`
- `loadCommits` 后自动选中第一条 commit（减少一次点击；用户仍可改）——**注意**：现状是必须手选，自动选中会让"提交"按钮立刻可用，符合"一键复用收藏"的诉求
- commit 区改为 `SearchSelect`，`:disabled="!d.branch"`
- 提交按钮：`:disabled="!d.branch || !d.commit || d.submitting"`
- 行内摘要加粒度标签：`type === "project" ? "仅项目" : "项目+分支"`，样式沿用 `StatusBadge` 的胶囊语言（本页内联一个 span 即可）
- 移除模板里的 `v-if="!f.branch"` 分支选择分支（这是本次的核心修复）

- [ ] **Step 4: 验证并提交**

```bash
npx vitest run src/views/FavoritesView.test.ts 2>&1 | tail -6
npx vue-tsc --noEmit && npm test 2>&1 | grep -E "Tests "
git add -A && git commit -m "feat(favorites): 部署时分支可改（含项目级收藏），下拉改为可搜索组件"
```

---

## Task 6: 文档同步 + 全量验证 + 出包

- [ ] **Step 1: 更新 spec**

- §5.1 窗口骨架：侧边栏可展开（点击、状态持久化）；窗口标题 `至真部署-桌面版 Ver<版本>`
- §5.4 向导：收藏两个粒度入口（选项目即可收藏项目、选分支即可收藏分支）；commit 用可搜索下拉
- §5.5 收藏页（spec 里对应 §5.6 之前的内容）：部署时分支可改；两种粒度标签；不记 commit、不写回收藏
- §7 存储：`config.json` 增加 `sidebarExpanded`

- [ ] **Step 2: 全量自动化**

```bash
npm test 2>&1 | grep -E "Test Files|Tests "
npx vue-tsc --noEmit
cd src-tauri && cargo test 2>&1 | grep -E "^test result" | head -1
```

- [ ] **Step 3: 真实浏览器验证拖动 + 下拉（沿用 Plan 3+4 的 CDP 探针思路）**

至少验证：收藏页展开后下拉能搜索并选中、选中后提交按钮可用、拖动排序仍生效（本轮改了同一个文件，必须回归）。

- [ ] **Step 4: 出包 + 冒烟**

```bash
npm run tauri build          # 注意：产物名会变成 至真部署_0.0.1_aarch64.dmg
# 冒烟：启动 release 二进制 10s 不退出
```

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "docs: 同步 spec（收藏粒度、可搜索下拉、侧边栏与标题）；Plan 5 完成"
```

---

## 验收标准

- [ ] 向导：选完项目就能「收藏此项目」；选完分支能「收藏此分支」；**不必选 commit**
- [ ] 收藏页：两种粒度都能部署，**分支可改**，改分支后 commit 列表刷新，提交用的是当前选择
- [ ] 收藏页改动不写回收藏（收藏记录本身不变）
- [ ] commit 与收藏页分支用可搜索下拉渲染（不再是原生 `<select>`），无匹配项有空态
- [ ] 窗口标题显示 `至真部署-桌面版 Ver0.0.1`；`package.json` / `tauri.conf.json` / 关于页三处一致
- [ ] 侧边栏点击可展开，显示五个导航名，重启后保持上次状态
- [ ] 前端测试全绿、`vue-tsc` 无错误、Rust 测试全绿
- [ ] 拖动排序回归通过（真浏览器验证）
- [ ] 出包成功且版本号正确
