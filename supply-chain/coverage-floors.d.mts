// Types for coverage-floors.mjs, so vitest.config.ts (type-checked with
// allowJs off) can import the floors without an implicit any (#1099).
export interface CoverageFloor {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}
export const headroom: number;
export const floors: Record<string, CoverageFloor>;
