import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseProjects, parseBranches, parseTaskList } from "./parser";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf-8");
}

/** fixture 缺失时给出可操作的提示，而不是一句 ENOENT */
function hasFixture(name: string): boolean {
  try {
    readFileSync(join(FIXTURES, name));
    return true;
  } catch {
    return false;
  }
}

const MISSING = "缺 fixture：请先跑 `cargo run --example capture_fixtures`（需内网 + 已保存凭据）";

describe("parseProjects", () => {
  it("能从真实项目页解析出项目列表", () => {
    if (!hasFixture("projects_auto_env1.html")) throw new Error(MISSING);
    const projects = parseProjects(fixture("projects_auto_env1.html"));
    expect(projects.length).toBeGreaterThan(0);
    for (const p of projects) {
      expect(p.id).toBeGreaterThan(0);
      expect(p.name.length).toBeGreaterThan(0);
    }
  });

  it("项目 id 互不重复", () => {
    if (!hasFixture("projects_auto_env1.html")) throw new Error(MISSING);
    const ids = parseProjects(fixture("projects_auto_env1.html")).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("Docker 项目页也能解析", () => {
    if (!hasFixture("projects_docker_env1.html")) throw new Error(MISSING);
    const projects = parseProjects(fixture("projects_docker_env1.html"));
    expect(projects.length).toBeGreaterThan(0);
  });
});

describe("parseBranches", () => {
  it("能从真实分支页解析出分支列表", () => {
    if (!hasFixture("branches_auto.html")) throw new Error(MISSING);
    const branches = parseBranches(fixture("branches_auto.html"));
    expect(branches.length).toBeGreaterThan(0);
    expect(branches.every((b) => b.length > 0)).toBe(true);
  });

  it("分支名互不重复", () => {
    if (!hasFixture("branches_auto.html")) throw new Error(MISSING);
    const branches = parseBranches(fixture("branches_auto.html"));
    expect(new Set(branches).size).toBe(branches.length);
  });
});

describe("parseTaskList - 自动化", () => {
  it("解析出任务与分页信息", () => {
    if (!hasFixture("tasks_auto.html")) throw new Error(MISSING);
    const r = parseTaskList(fixture("tasks_auto.html"), "auto");
    expect(r.tasks.length).toBeGreaterThan(0);
    expect(r.pageInfo.currentPage).toBeGreaterThanOrEqual(1);
    expect(r.pageInfo.totalPages).toBeGreaterThanOrEqual(r.pageInfo.currentPage);
  });

  it("每条任务的字段都取到了值", () => {
    if (!hasFixture("tasks_auto.html")) throw new Error(MISSING);
    const r = parseTaskList(fixture("tasks_auto.html"), "auto");
    for (const t of r.tasks) {
      expect(t.taskId).toBeGreaterThan(0);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.projectName.length).toBeGreaterThan(0);
      expect(t.submitTime.length).toBeGreaterThan(0);
      // cluster / deployType 在自动化下按设计为空（见 parser.ts 的列布局差异）
      expect(t.cluster).toBe("");
      expect(t.deployType).toBe("");
    }
  });

  it("taskId 互不重复", () => {
    if (!hasFixture("tasks_auto.html")) throw new Error(MISSING);
    const r = parseTaskList(fixture("tasks_auto.html"), "auto");
    const ids = r.tasks.map((t) => t.taskId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("至少有一个任务带有可操作标志位（否则说明列索引已错位）", () => {
    if (!hasFixture("tasks_auto.html")) throw new Error(MISSING);
    const r = parseTaskList(fixture("tasks_auto.html"), "auto");
    const anyFlag = r.tasks.some((t) => t.canUp || t.canRoll || t.canDelete);
    expect(anyFlag).toBe(true);
  });

  it("解析出导航栏里的当前登录人显示名（通知靠它区分自己与别人）", () => {
    if (!hasFixture("tasks_auto.html")) throw new Error(MISSING);
    const r = parseTaskList(fixture("tasks_auto.html"), "auto");
    expect(r.currentUser).toBe("贺浩成");
    // 它必须不是登录账号（账号是拼音），否则通知会永远不弹
    expect(r.currentUser).not.toContain("hehaocheng");
  });
});

describe("parseTaskList - Docker", () => {
  it("解析出任务与分页信息", () => {
    if (!hasFixture("tasks_docker.html")) throw new Error(MISSING);
    const r = parseTaskList(fixture("tasks_docker.html"), "docker");
    expect(r.tasks.length).toBeGreaterThan(0);
    expect(r.pageInfo.currentPage).toBeGreaterThanOrEqual(1);
  });

  it("docker 下 cluster 与 deployType 有值（列布局与 auto 不同）", () => {
    if (!hasFixture("tasks_docker.html")) throw new Error(MISSING);
    const r = parseTaskList(fixture("tasks_docker.html"), "docker");
    const withCluster = r.tasks.filter((t) => t.cluster.length > 0);
    expect(withCluster.length).toBeGreaterThan(0);
  });

  it("每条任务都有标题与项目名", () => {
    if (!hasFixture("tasks_docker.html")) throw new Error(MISSING);
    const r = parseTaskList(fixture("tasks_docker.html"), "docker");
    for (const t of r.tasks) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.projectName.length).toBeGreaterThan(0);
    }
  });
});

describe("parseTaskList - 两种类型互不串位", () => {
  it("同一份 auto HTML 用 docker 规则解析会得到不同的 projectName", () => {
    if (!hasFixture("tasks_auto.html")) throw new Error(MISSING);
    const html = fixture("tasks_auto.html");
    const asAuto = parseTaskList(html, "auto").tasks;
    const asDocker = parseTaskList(html, "docker").tasks;
    // 列顺序不同，必然至少有一行的 projectName 不一致——这条测试锁住
    // "type 参数真的被用上了"，防止以后有人把分支写反
    const differs = asAuto.some((t, i) => t.projectName !== asDocker[i]?.projectName);
    expect(differs).toBe(true);
  });
});

describe("parseTaskList - 容错", () => {
  it("没有表格时返回空列表而不是抛错", () => {
    const r = parseTaskList("<html><body><p>no table</p></body></html>", "auto");
    expect(r.tasks).toEqual([]);
    expect(r.pageInfo.currentPage).toBe(1);
  });

  it("完全空的输入也不抛错", () => {
    const r = parseTaskList("", "docker");
    expect(r.tasks).toEqual([]);
  });

  it("拿不到导航栏时 currentUser 是空串（调用方按身份未知处理）", () => {
    const html = `<html><body><table><tbody>
      <tr>${'<td>x</td>'.repeat(13)}</tr>
    </tbody></table></body></html>`;
    expect(parseTaskList(html, "auto").currentUser).toBe("");
  });

  it("列数不足的行被跳过", () => {
    const html = `<html><body><table><tbody>
      <tr><td id="title_1">too few cells</td><td>x</td></tr>
    </tbody></table></body></html>`;
    expect(parseTaskList(html, "auto").tasks).toEqual([]);
  });
});
