import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  target: 'es2022',
  format: 'esm',
  outfile: 'dist/index.js',
  // Tree-shake unused exports
  treeShaking: true,
  // Remove console.log in production (keep warn/error)
  pure: ['console.log', 'console.debug', 'console.info'],
  // Analyze bundle size
  metafile: true,
}).then((result) => {
  const text = Object.entries(result.metafile.outputs)
    .map(([file, info]) => `${file}: ${(info.bytes / 1024).toFixed(1)} KB`)
    .join('\n');
  console.log('Bundle sizes:\n' + text);
});
