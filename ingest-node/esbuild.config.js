#!/usr/bin/env node

/**
 * esbuild configuration for optimized worker bundle
 * 
 * This script bundles the TypeScript source code into a single optimized
 * JavaScript file with tree-shaking and minification.
 * 
 * Usage:
 *   node esbuild.config.js          # Development build
 *   node esbuild.config.js --prod   # Production build (minified)
 */

const esbuild = require('esbuild');
const path = require('path');

const isProduction = process.argv.includes('--prod');

const buildOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  outfile: 'dist/index.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: !isProduction,
  minify: isProduction,
  treeShaking: true,
  legalComments: 'none',
  // External dependencies that should not be bundled
  external: [
    'fastify',
    'ioredis',
    'nats',
    'prom-client',
    'zod',
  ],
  // Bundle analysis
  metafile: true,
  // Log level
  logLevel: 'info',
};

async function build() {
  try {
    console.log(`Building ${isProduction ? 'production' : 'development'} bundle...`);
    
    const result = await esbuild.build(buildOptions);
    
    if (result.metafile) {
      const analysis = await esbuild.analyzeMetafile(result.metafile);
      console.log('\nBundle analysis:');
      console.log(analysis);
    }
    
    console.log('\n✅ Build successful!');
    console.log(`Output: ${path.resolve(buildOptions.outfile)}`);
    
    if (isProduction) {
      console.log('📦 Minified: Yes');
      console.log('🌳 Tree-shaking: Yes');
    }
    
  } catch (error) {
    console.error('❌ Build failed:', error.message);
    process.exit(1);
  }
}

build();