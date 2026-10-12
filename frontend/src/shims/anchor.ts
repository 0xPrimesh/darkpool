// @arcium-hq/client's ESM build does `import anchor__default from "@anchor-lang/core"`,
// but Anchor's browser bundle has no default export. Re-export everything and
// provide the namespace as the default so rollup is satisfied.
import * as anchor from "@anchor-lang/core/dist/browser/index.js";
export * from "@anchor-lang/core/dist/browser/index.js";
export default anchor;
