import { rmSync } from 'node:fs';
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const withTests = process.argv.includes('--tests');
const minify = process.argv.includes('--minify');

/** @type {import('esbuild').BuildOptions} */
const base = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  logLevel: 'warning',
  sourcemap: true,
};

/** @type {import('esbuild').BuildOptions} */
const extension = {
  ...base,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  external: ['vscode'],
  minify,
};

/** @type {import('esbuild').BuildOptions} */
const tests = {
  ...base,
  entryPoints: ['test/*.test.ts'],
  outdir: 'dist-test',
  external: ['vscode'],
  sourcemap: false,
};

if (watch) {
  const ctx = await context(extension);
  await ctx.watch();
  console.log('watching src -> dist/extension.js');
} else {
  const targets = withTests ? [extension, tests] : [extension];
  // esbuild leaves bundles of deleted test files behind, which the test runner
  // would happily keep executing.
  if (withTests) rmSync('dist-test', { recursive: true, force: true });
  await Promise.all(targets.map((options) => build(options)));
  console.log(withTests ? 'built extension and tests' : 'built extension');
}
