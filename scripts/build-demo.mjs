// Gera dist/painel-demo.html: painel + núcleo dos agentes num único arquivo (sem servidor).
// Uso: node scripts/build-demo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const stub = {
  name: 'llm-stub',
  setup(b) { b.onResolve({ filter: /\/llm\.js$/ }, () => ({ path: path.join(root, 'src/core/llm-stub.js') })); },
};
const out = await build({ entryPoints: [path.join(root, 'demo/main.js')], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false, minify: true, plugins: [stub], legalComments: 'none' });
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
const body = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8').match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[^>]*><\/script>/, '');
const html = `<title>Equipe dos Sonhos iFlores</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<style>\n${css}\n</style>\n${body}\n<script>\n${js}\n</script>\n`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/painel-demo.html'), html);
console.log(`dist/painel-demo.html ${(html.length / 1024).toFixed(0)} KB`);
