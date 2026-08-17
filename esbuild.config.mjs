import esbuild from 'esbuild';
import fs from 'node:fs';
const production = process.argv[2] === 'production';
await esbuild.build({entryPoints:['main.ts'],bundle:true,external:['obsidian'],format:'cjs',platform:'node',target:'es2018',outfile:'main.js',sourcemap:production?'external':'inline',minify:production,watch:production?false:{}});
if (production) { fs.rmSync('main.js.map',{force:true}); }
