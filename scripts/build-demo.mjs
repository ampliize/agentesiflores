// Gera dist/painel-demo.html: o painel completo rodando 100% no navegador, com backend simulado.
// Uso: node scripts/build-demo.mjs
import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const css = read('public/styles.css');
const art = read('src/lib/art-svg.js').replace(/^export /m, '');
const backend = read('demo/backend.js');
let app = read('public/app.js')
  .replace(/let TOKEN = .*\n/, "let TOKEN = 'demo-token';\n")
  .replace("if (!confirm('A chave antiga deixará de funcionar. Continuar?')) return; ", '')
  .replace(/\s*<a class="btn sm ghost" href="\$\{esc\(p\.image_url\)\}" download>Baixar<\/a>/, '')
  .replace(/\nboot\(\);\s*$/, '\nwindow.__demoSeed().then(boot);\n');
const body = read('public/index.html').match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[^>]*><\/script>/, '');
if (!app.includes('__demoSeed')) throw new Error('patch do app.js falhou');

const html = `<title>iFlores Equipe Virtual</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
${css}
</style>
${body}
<script>
${art}
${backend}
</script>
<script type="module">
${app}
</script>
`;
fs.mkdirSync(new URL('../dist', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../dist/painel-demo.html', import.meta.url), html);
console.log('dist/painel-demo.html', (html.length / 1024).toFixed(0), 'KB');
