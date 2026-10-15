import * as cheerio from 'cheerio';

export interface Project {
  id: number;
  name: string;
}

export interface DeployTask {
  taskId: number;
  title: string;
  projectName: string;
  envName: string;
  cluster: string;
  deployType: string;
  branch: string;
  version: string;
  onlineStatus: string;
  buildStatus: string;
  submitTime: string;
  submitter: string;
  canUp: boolean;
  canRoll: boolean;
  canDelete: boolean;
}

export interface PageInfo {
  currentPage: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
}

export interface TaskListResult {
  tasks: DeployTask[];
  pageInfo: PageInfo;
  /**
   * 当前登录人的显示名（页面左侧导航栏里的那个名字）。
   * 「提交人」列用的就是同一套名字，构建完成通知据此只弹自己提交的任务。
   * 解析不到时是空串，调用方按「身份未知」处理。
   */
  currentUser: string;
}

export function parseProjects(html: string): Project[] {
  const $ = cheerio.load(html);
  const projects: Project[] = [];
  $('a.btn-info[href*="/submit/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/\/submit\/(\d+)\//);
    if (match) {
      projects.push({
        id: parseInt(match[1], 10),
        name: $(el).text().trim(),
      });
    }
  });
  return projects;
}

export function parseBranches(html: string): string[] {
  const $ = cheerio.load(html);
  const branches: string[] = [];
  $('#branchtag option').each((_, el) => {
    const val = $(el).attr('value');
    if (val) branches.push(val);
  });
  return branches;
}

export function parseTaskList(html: string, type: 'auto' | 'docker' = 'auto'): TaskListResult {
  const $ = cheerio.load(html);
  const tasks: DeployTask[] = [];

  $('table tbody tr').each((_, row) => {
    const tds = $(row).find('td');
    if (tds.length < 11) return;

    const titleTd = $(row).find('td[id^="title_"]');
    const idMatch = titleTd.attr('id')?.match(/title_(\d+)/);
    if (!idMatch) return;

    const taskId = parseInt(idMatch[1], 10);

    if (type === 'docker') {
      // Docker: td[0]title td[1]project td[2]env td[5]branch td[6]version td[7]online td[8]build td[9]time td[10]submitter td[11]actions
      const actionsTd = $(tds[11]);
      const upHref = actionsTd.find('a[href*="/up/"]').attr('href');
      const rollHref = actionsTd.find('a[href*="/roll/"]').attr('href');
      const deleteHref = actionsTd.find('a[href*="/submit/task/"]').attr('href');
      tasks.push({
        taskId,
        title: titleTd.text().trim(),
        projectName: $(tds[1]).text().replace(/\s+/g, ' ').trim(),
        envName: $(row).find('td[id^="env_"]').text().trim(),
        cluster: $(tds[3]).text().trim(),
        deployType: $(tds[4]).text().trim(),
        branch: $(row).find('td[id^="branchtag_"]').text().trim(),
        version: $(row).find('td[id^="version_"]').text().trim(),
        onlineStatus: $(tds[7]).text().trim(),
        buildStatus: $(tds[8]).text().trim(),
        submitTime: $(tds[9]).text().trim(),
        submitter: $(tds[10]).text().trim(),
        canUp: !!upHref,
        canRoll: !!rollHref,
        canDelete: !!deleteHref,
      });
    } else {
      // 自动化: td[0]title td[1]dtype td[2]project td[3]env td[6]branch td[7]version td[8]online td[9]build td[10]time td[11]submitter td[12]actions
      const actionsTd = $(tds[12]);
      const upHref = actionsTd.find('a[href*="/up/"]').attr('href');
      const rollHref = actionsTd.find('a[href*="/roll/"]').attr('href');
      const deleteHref = actionsTd.find('a[href*="/submit/task/"]').attr('href');
      tasks.push({
        taskId,
        title: titleTd.text().trim(),
        projectName: $(row).find('td[id^="project_"]').text().trim(),
        envName: $(row).find('td[id^="env_"]').text().trim(),
        cluster: '',
        deployType: '',
        branch: $(row).find('td[id^="branchtag_"]').text().trim(),
        version: $(row).find('td[id^="version_"]').text().trim(),
        onlineStatus: $(tds[8]).text().trim(),
        buildStatus: $(tds[9]).text().trim(),
        submitTime: $(tds[10]).text().trim(),
        submitter: $(tds[11]).text().trim(),
        canUp: !!upHref,
        canRoll: !!rollHref,
        canDelete: !!deleteHref,
      });
    }
  });

  const pageInfo = parsePageInfo($);
  return { tasks, pageInfo, currentUser: parseCurrentUser($) };
}

/**
 * 导航栏里的当前登录人显示名。
 *
 * 注意它不是登录账号：账号是拼音（fixture 里的头像文件名 `..._hehaocheng.png`），
 * 而这里和「提交人」列都是中文显示名（如 `贺浩成`）。
 */
function parseCurrentUser($: ReturnType<typeof cheerio.load>): string {
  return $('div.profile-element strong.font-bold').first().text().trim();
}

function parsePageInfo($: ReturnType<typeof cheerio.load>): PageInfo {
  const nav = $('nav[aria-label="Page navigation"]');
  const activePage = nav.find('li.active a').text().trim();
  const currentPage = parseInt(activePage, 10) || 1;

  const lastPageHref = nav.find('a:contains("尾页")').attr('href') || '';
  const totalMatch = lastPageHref.match(/page=(\d+)/);
  const totalPages = totalMatch ? parseInt(totalMatch[1], 10) : currentPage;

  const hasPrev = nav.find('li:not(.disabled) a:contains("«")').length > 0;
  const hasNext = nav.find('li:not(.disabled) a:contains("»")').length > 0;

  return { currentPage, totalPages, hasPrev, hasNext };
}
