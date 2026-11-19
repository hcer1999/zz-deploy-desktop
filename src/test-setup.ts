/**
 * Vitest 全局 setup（在 jsdom 里跑组件测试）。
 *
 * jsdom 没实现 `Element.prototype.scrollIntoView`，而 reka-ui 的列表/下拉在
 * 高亮项变化时会调用它 → 会抛出未处理的 rejection，污染测试结果。补一个空实现。
 */
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/**
 * reka-ui 的 Select / 弹出层会用到指针捕获与 ResizeObserver，
 * jsdom 都没实现。补空实现，否则打开下拉会直接抛错（实测）。
 */
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
