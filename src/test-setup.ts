/**
 * Vitest 全局 setup（在 jsdom 里跑组件测试）。
 *
 * jsdom 没实现 `Element.prototype.scrollIntoView`，而 reka-ui 的列表/下拉在
 * 高亮项变化时会调用它 → 会抛出未处理的 rejection，污染测试结果。补一个空实现。
 */
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
