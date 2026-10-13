import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

vi.mock("./http", async () => {
  const actual = await vi.importActual<typeof import("./http")>("./http");
  return {
    ...actual,
    httpGet: vi.fn(),
    httpPost: vi.fn(),
    httpGetJson: vi.fn(),
  };
});

import * as http from "./http";
import {
  ENVS,
  deployPath,
  fetchProjects,
  fetchBranches,
  fetchCommits,
  submitDeploy,
  fetchTaskList,
  submitOnline,
  submitRollback,
  deleteTask,
  cleanProjectName,
} from "./deploy";

function res(status: number, location: string | null = null, body = ""): http.HttpResult {
  return { status, location, body };
}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
function fixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8"));
}

describe("deployPath", () => {
  it("自动化与 docker 走不同的前缀", () => {
    expect(deployPath("auto")).toBe("deployment/deploy");
    expect(deployPath("docker")).toBe("dockerdeploy/docker");
  });
});

describe("ENVS", () => {
  it("就是 spec 里那 9 个环境，id 与顺序都不能变", () => {
    expect(ENVS.map((e) => e.id)).toEqual([1, 2, 4, 7, 8, 9, 11, 12, 14]);
    expect(ENVS[0]).toEqual({ id: 1, name: "测试环境" });
    expect(ENVS[8]).toEqual({ id: 14, name: "腾讯云" });
  });
});

describe("cleanProjectName", () => {
  it("去掉全角括号后缀", () => {
    expect(cleanProjectName("zz-cy-iptv（tke_node）")).toBe("zz-cy-iptv");
  });

  it("去掉半角括号后缀", () => {
    expect(cleanProjectName("zz-vip-web(prod)")).toBe("zz-vip-web");
  });

  it("没有括号时原样返回（并 trim）", () => {
    expect(cleanProjectName("  zz-pay  ")).toBe("zz-pay");
  });

  it("能处理真实项目名的形态", () => {
    expect(cleanProjectName("supermagicstudio-net（h5）")).toBe("supermagicstudio-net");
  });
});

describe("fetchProjects", () => {
  beforeEach(() => vi.clearAllMocks());

  it("请求正确路径并解析出项目", async () => {
    vi.mocked(http.httpGet).mockResolvedValue(
      res(200, null, '<a class="btn btn-info" href="/deployment/deploy/submit/42/">zz-proj</a>'),
    );
    const out = await fetchProjects("auto", 1);
    expect(http.httpGet).toHaveBeenCalledWith("/deployment/deploy/submit/", { env: 1 });
    expect(out).toEqual([{ id: 42, name: "zz-proj" }]);
  });

  it("docker 走 docker 前缀", async () => {
    vi.mocked(http.httpGet).mockResolvedValue(res(200, null, ""));
    await fetchProjects("docker", 2);
    expect(http.httpGet).toHaveBeenCalledWith("/dockerdeploy/docker/submit/", { env: 2 });
  });
});

describe("fetchBranches", () => {
  beforeEach(() => vi.clearAllMocks());

  it("请求项目页并解析 #branchtag option", async () => {
    vi.mocked(http.httpGet).mockResolvedValue(
      res(200, null, '<select id="branchtag"><option value="main">main</option></select>'),
    );
    const out = await fetchBranches("auto", 42);
    expect(http.httpGet).toHaveBeenCalledWith("/deployment/deploy/submit/42/");
    expect(out).toEqual(["main"]);
  });
});

describe("fetchCommits", () => {
  beforeEach(() => vi.clearAllMocks());

  it("用清理过的项目名请求 devapi，并拆开 hash 与 message", async () => {
    vi.mocked(http.httpGetJson).mockResolvedValue({
      msg: "success",
      data: [{ project: "zz-cy-iptv", commitids: ["abc123#-----#修复黑屏", "def456#-----#优化"] }],
    });
    const out = await fetchCommits("zz-cy-iptv（tke_node）", "main");
    expect(http.httpGetJson).toHaveBeenCalledWith("/devapi/projectcommit/", {
      project: "zz-cy-iptv",
      branch: "main",
    });
    expect(out).toEqual([
      { hash: "abc123", message: "修复黑屏", fullString: "abc123#-----#修复黑屏" },
      { hash: "def456", message: "优化", fullString: "def456#-----#优化" },
    ]);
  });

  it("msg 非 success 时返回空数组而不抛错", async () => {
    vi.mocked(http.httpGetJson).mockResolvedValue({ msg: "fail", data: [] });
    expect(await fetchCommits("x", "main")).toEqual([]);
  });

  it("data 为空时返回空数组", async () => {
    vi.mocked(http.httpGetJson).mockResolvedValue({ msg: "success", data: [] });
    expect(await fetchCommits("x", "main")).toEqual([]);
  });

  it("真实样本能解析出合法的 hash 与 message", async () => {
    // 用抓取到的真实响应，锁住 #-----# 的拆解格式
    vi.mocked(http.httpGetJson).mockResolvedValue(fixtureJson("commits_sample.json") as never);
    const out = await fetchCommits("supermagicstudio-net", "release/gaoshantec_com");
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c.hash).toMatch(/^[0-9a-f]{7,40}$/);
      expect(typeof c.message).toBe("string");
      expect(c.fullString).toContain("#-----#");
    }
  });

  it("过滤掉不含分隔符的服务端警告（真实边界情况）", async () => {
    // devapi/projectcommit 在项目不存在或 git 配置异常时仍返回 msg="success"，
    // 却把一句中文警告塞进 commitids（样本见 commits_warning_sample.json）。
    // 不处理的话，Commit 下拉里会出现 hash 为整句中文的假记录。
    vi.mocked(http.httpGetJson).mockResolvedValue(
      fixtureJson("commits_warning_sample.json") as never,
    );
    const out = await fetchCommits("__nonexistent_project__", "release/x");
    expect(out).toEqual([]);
  });

  it("正常与警告混合时只保留正常条目", async () => {
    vi.mocked(http.httpGetJson).mockResolvedValue({
      msg: "success",
      data: [{ project: "p", commitids: ["abc123#-----#真提交", "【警告】git地址异常"] }],
    });
    const out = await fetchCommits("p", "main");
    expect(out).toHaveLength(1);
    expect(out[0].hash).toBe("abc123");
  });
});

describe("submitDeploy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("自动化不带 branchtag", async () => {
    vi.mocked(http.httpPost).mockResolvedValue(res(302, "/deployment/deploy/task/"));
    const ok = await submitDeploy("auto", 42, { title: "t", branchtag: "main", version: "v1" });
    expect(ok).toBe(true);
    const [path, form] = vi.mocked(http.httpPost).mock.calls[0];
    expect(path).toBe("/deployment/deploy/submit/task/42/");
    expect(form).not.toHaveProperty("branchtag");
  });

  it("docker 带 branchtag", async () => {
    vi.mocked(http.httpPost).mockResolvedValue(res(302, "/dockerdeploy/docker/task/"));
    await submitDeploy("docker", 42, { title: "t", branchtag: "release/v1", version: "v1" });
    const [, form] = vi.mocked(http.httpPost).mock.calls[0];
    expect(form).toMatchObject({ branchtag: "release/v1" });
  });

  it("必须带上踩坑加上的三个字段", async () => {
    vi.mocked(http.httpPost).mockResolvedValue(res(302, "/x/"));
    await submitDeploy("auto", 42, { title: "标题", branchtag: "main", version: "v1" });
    const [, form] = vi.mocked(http.httpPost).mock.calls[0];
    expect(form).toMatchObject({
      title: "标题",
      version: "v1",
      iteration_id: "0",
      serial: "1",
      destination_host: "",
    });
  });

  it("302 指向登录页时判为失败（不能误报成功）", async () => {
    vi.mocked(http.httpPost).mockResolvedValue(res(302, "/login/?next=/x"));
    expect(await submitDeploy("auto", 42, { title: "t", branchtag: "b", version: "v" })).toBe(false);
  });

  it("500 判为失败", async () => {
    vi.mocked(http.httpPost).mockResolvedValue(res(500));
    expect(await submitDeploy("auto", 42, { title: "t", branchtag: "b", version: "v" })).toBe(false);
  });
});

describe("fetchTaskList", () => {
  beforeEach(() => vi.clearAllMocks());

  it("带 page 与 search 参数，并按类型解析", async () => {
    vi.mocked(http.httpGet).mockResolvedValue(res(200, null, "<html></html>"));
    const out = await fetchTaskList("docker", 3, "zz-pay");
    expect(http.httpGet).toHaveBeenCalledWith("/dockerdeploy/docker/task/", {
      page: 3,
      search: "zz-pay",
    });
    expect(out).toEqual({
      tasks: [],
      pageInfo: { currentPage: 1, totalPages: 1, hasPrev: false, hasNext: false },
    });
  });
});

describe("行内操作", () => {
  beforeEach(() => vi.clearAllMocks());

  it("上线走 /up/", async () => {
    vi.mocked(http.httpGet).mockResolvedValue(res(302, "/deployment/deploy/task/"));
    expect(await submitOnline("auto", 7)).toBe(true);
    expect(http.httpGet).toHaveBeenCalledWith("/deployment/deploy/task/7/up/");
  });

  it("回滚走 /roll/", async () => {
    vi.mocked(http.httpGet).mockResolvedValue(res(302, "/x/"));
    expect(await submitRollback("docker", 7)).toBe(true);
    expect(http.httpGet).toHaveBeenCalledWith("/dockerdeploy/docker/task/7/roll/");
  });

  it("删除走 /submit/task/{id}/", async () => {
    vi.mocked(http.httpGet).mockResolvedValue(res(302, "/x/"));
    expect(await deleteTask("auto", 7)).toBe(true);
    expect(http.httpGet).toHaveBeenCalledWith("/deployment/deploy/submit/task/7/");
  });

  it("会话过期时三个操作都判为失败", async () => {
    vi.mocked(http.httpGet).mockResolvedValue(res(302, "/login/"));
    expect(await submitOnline("auto", 7)).toBe(false);
    expect(await submitRollback("auto", 7)).toBe(false);
    expect(await deleteTask("auto", 7)).toBe(false);
  });

  it("200 也算成功（服务端有的动作直接返回页面）", async () => {
    vi.mocked(http.httpGet).mockResolvedValue(res(200));
    expect(await submitOnline("auto", 7)).toBe(true);
  });
});
