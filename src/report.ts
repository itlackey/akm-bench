/**
 * Public barrel for akm-bench report rendering.
 *
 * Each report domain has its own module under ./report/. Internal
 * cross-references between modules go directly to the sub-module — only
 * outside callers should import from "./report".
 */

export * from "./report/attribution";
export * from "./report/compare";
export * from "./report/coverage";
export * from "./report/envelope";
export * from "./report/evolve-track";
export * from "./report/failure-modes";
export * from "./report/git";
export * from "./report/negative-transfer";
export * from "./report/overhead";
export * from "./report/search-bridge";
export * from "./report/utility-track";
export * from "./report/workflow-compliance";
export * from "./run-record";
