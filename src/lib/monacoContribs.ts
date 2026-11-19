import "monaco-editor/editor/contrib/find/browser/findController.js";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

/**
 * Monaco 的按需引入。
 *
 * 我们用的是 `editor.api`（核心编辑器，不含任何可选功能），它**不带查找面板**：
 * 少了下面这行 findController，⌘F / Ctrl+F 在日志里就是死的（实测用户反馈）。
 * 查找面板连样式一起由这个模块带进来（findWidget.css 由 findController 自己 import）。
 *
 * 只引 editor.worker：zzlog 是主线程 tokenize 的自写语法，
 * 不需要 typescript / json 那些语言服务 worker（体积差好几 MB）。
 * Vite 会把 worker 打成随包资源，桌面端从本地文件加载，离线可用。
 */
export function installMonacoSupport(): void {
  (self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
}
