import esbuild from 'esbuild';

const production = process.argv[2] === 'production';

const buildOptions = {
  entryPoints: ['main.ts'],
  bundle: true,
  external: ['obsidian'],
  format: 'cjs',
  platform: 'node',
  target: 'es2018',
  outfile: 'main.js',
  sourcemap: production ? false : 'inline',
  minify: production,
};

if (production) {
  await esbuild.build(buildOptions);
} else {
  const context = await esbuild.context(buildOptions);
  await context.watch();
  console.log('Watching for changes...');
}
