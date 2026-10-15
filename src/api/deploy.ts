import { httpGet, httpGetJson, httpPost, isSuccessRedirect, isActionOk } from "./http";
import { parseProjects, parseBranches, parseTaskList } from "./parser";
import type { Project, TaskListResult } from "./parser";

export type { Project, TaskListResult };

export type DeployType = "auto" | "docker";

/** commit 与 message 的分隔符，服务端原始值（5 个连字符） */
const COMMIT_SEPARATOR = "#-----#";

export interface CommitInfo {
  hash: string;
  message: string;
  fullString: string;
}

/**
 * 环境列表是硬编码的（spec §11 明确不做自定义环境列表）。
 * id 必须与服务端一致，顺序也不要动。
 */
export const ENVS: { id: number; name: string }[] = [
  { id: 1, name: "测试环境" },
  { id: 2, name: "正式环境" },
  { id: 4, name: "预发布环境" },
  { id: 7, name: "开发环境" },
  { id: 8, name: "测试环境2" },
  { id: 9, name: "UAT环境" },
  { id: 11, name: "测试环境3" },
  { id: 12, name: "谷歌云" },
  { id: 14, name: "腾讯云" },
];

/** 两种部署类型在服务端是两套完全不同的路由前缀 */
export function deployPath(type: DeployType): string {
  return type === "auto" ? "deployment/deploy" : "dockerdeploy/docker";
}

/**
 * 项目名可能带括号后缀，如 "zz-cy-iptv（tke_node）"，
 * 而 commit 接口只认括号前的主体。对应插件 src/api/deploy.ts:29。
 */
export function cleanProjectName(projectName: string): string {
  return projectName.replace(/[（(][^）)]*[）)]/g, "").trim();
}

export async function fetchProjects(type: DeployType, envId: number): Promise<Project[]> {
  const r = await httpGet(`/${deployPath(type)}/submit/`, { env: envId });
  return parseProjects(r.body);
}

export async function fetchBranches(type: DeployType, projectId: number): Promise<string[]> {
  const r = await httpGet(`/${deployPath(type)}/submit/${projectId}/`);
  return parseBranches(r.body);
}

export async function fetchCommits(projectName: string, branch: string): Promise<CommitInfo[]> {
  const data = await httpGetJson<{
    msg: string;
    data: Array<{ project: string; commitids: string[] }>;
  }>("/devapi/projectcommit/", { project: cleanProjectName(projectName), branch });

  if (data.msg !== "success" || !data.data.length) return [];

  return (
    data.data[0].commitids
      // 服务端在项目不存在或 git 配置异常时，仍返回 msg="success"，
      // 却把一句中文警告塞进 commitids（实例见 __fixtures__/commits_warning_sample.json）。
      // 正常 commit 一定含 "#-----#"，警告文本不含，据此过滤掉。
      // 插件没有这层过滤（src/api/deploy.ts:37），会显示假记录。
      .filter((raw) => raw.includes(COMMIT_SEPARATOR))
      .map((raw) => {
        const [hash, message] = raw.split(COMMIT_SEPARATOR);
        return { hash, message, fullString: raw };
      })
  );
}

export interface SubmitDeployParams {
  title: string;
  branchtag: string;
  version: string;
}

export async function submitDeploy(
  type: DeployType,
  projectId: number,
  params: SubmitDeployParams,
): Promise<boolean> {
  const body: Record<string, string> = {
    title: params.title,
    version: params.version,
    // 下面三个字段是踩坑补上的，删掉服务端会 500（插件 src/api/deploy.ts:48-57）
    iteration_id: "0",
    serial: "1",
    destination_host: "",
  };
  // 只有 docker 需要 branchtag
  if (type === "docker") {
    body.branchtag = params.branchtag;
  }
  const r = await httpPost(`/${deployPath(type)}/submit/task/${projectId}/`, body);
  return isSuccessRedirect(r);
}

export async function fetchTaskList(
  type: DeployType,
  page: number,
  search: string,
): Promise<TaskListResult> {
  const r = await httpGet(`/${deployPath(type)}/task/`, { page, search });
  return parseTaskList(r.body, type);
}

export async function submitOnline(type: DeployType, taskId: number): Promise<boolean> {
  return isActionOk(await httpGet(`/${deployPath(type)}/task/${taskId}/up/`));
}

export async function submitRollback(type: DeployType, taskId: number): Promise<boolean> {
  return isActionOk(await httpGet(`/${deployPath(type)}/task/${taskId}/roll/`));
}

/**
 * 重新构建。路径与「上线 / 回滚」同构，但**只对构建失败的任务开放**：
 * 入口的显示条件在 TaskListView（服务端只给文案，没有结构化的失败标志位）。
 */
export async function submitRebuild(type: DeployType, taskId: number): Promise<boolean> {
  return isActionOk(await httpGet(`/${deployPath(type)}/task/${taskId}/rebuild/`));
}

export async function deleteTask(type: DeployType, taskId: number): Promise<boolean> {
  return isActionOk(await httpGet(`/${deployPath(type)}/submit/task/${taskId}/`));
}
