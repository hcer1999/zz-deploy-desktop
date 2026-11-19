import EditorWorker from "monaco-editor/editor/editor.worker?worker";

/**
 * Monaco 的编辑器 worker。
 *
 * 只引 editor.worker：我们只用自写的 zzlog 语法（主线程 tokenize），
 * 不需要 typescript/json 那些语言服务 worker。Vite 会把它打成随包资源，
 * 桌面端从本地文件加载，离线可用。
 */
export function installMonacoWorker(): void {
  (self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
}
