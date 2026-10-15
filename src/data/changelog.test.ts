import { describe, it, expect } from "vitest";
import { CHANGELOG } from "./changelog";

describe("CHANGELOG", () => {
  it("按版本从新到旧排列（关于页直接顺序渲染）", () => {
    const versions = CHANGELOG.map((e) => e.version);
    const sorted = [...versions].sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true }),
    );
    expect(versions).toEqual(sorted);
  });

  it("每条都有版本号、日期、主题与非空条目", () => {
    for (const e of CHANGELOG) {
      expect(e.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.summary.length).toBeGreaterThan(2);
      expect(e.items.length).toBeGreaterThan(0);
      expect(e.items.every((i) => i.trim().length > 4)).toBe(true);
    }
  });
});
