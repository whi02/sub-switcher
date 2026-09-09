import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const test = process.argv.includes("--test");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  outfile: "dist/extension.js",
  external: ["vscode"],
  minify: production,
  sourcemap: !production,
  logLevel: "info",
};

// The test entry runs outside the editor, so `vscode` is aliased to a stub.
// ESM because the suite uses top-level await to redirect HOME before the source
// modules resolve any paths.
if (test) {
  await esbuild.build({
    entryPoints: ["test/run.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile: "dist-test/run.mjs",
    alias: { vscode: "./test/vscode-stub.js" },
    logLevel: "warning",
  });
} else if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
