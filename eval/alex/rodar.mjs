// Roda os cenários do Alex com o modelo real. Precisa de LLM_PROVIDER=openai, OPENAI_API_KEY e OPENAI_MODEL.
// Uso: npm run eval:alex
import fs from 'node:fs';
import path from 'node:path';
import { init } from '../../src/core/index.js';
import { createMemoryStore, comLoja, db } from '../../src/core/store.js';
import { seedDemo } from '../../src/core/seed.js';
import { getSettings, listProducts } from '../../src/core/catalog.js';
import * as AL from '../../src/core/agents/alex.js';
import { aiEnabled, MODEL, PROVEDOR } from '../../src/core/llm.js';
import { CENARIOS } from './cenarios.mjs';

if (PROVEDOR() !== 'openai' || !process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) {
  console.error('Defina LLM_PROVIDER=openai, OPENAI_API_KEY e OPENAI_MODEL antes de rodar a avaliação.');
  process.exit(2);
}
if (!aiEnabled()) { console.error('IA não ativa.'); process.exit(2); }

init(createMemoryStore());
const foto = async (t) => ({ destaques: JSON.stringify((await getSettings(t)).destaques_home), mudancas: (await db().list('changes', t)).length, produtos: JSON.stringify((await listProducts(t)).map((p) => [p.id, p.ativo, p.estoque])) });
const resultados = [];
for (const c of CENARIOS) {
  const t = await seedDemo(`Avaliação ${c.id}`);
  await comLoja(t, async () => {
    const antes = await foto(t); const trace = [];
    const { texto } = await AL.conversar(t, c.pergunta, { trace });
    const depois = await foto(t);
    const mudouLoja = antes.mudancas !== depois.mudancas || antes.produtos !== depois.produtos || antes.destaques !== depois.destaques;
    const destaques = (await getSettings(t)).destaques_home;
    const destaque1 = destaques[0];
    const nomeDestaque1 = destaque1 ? (await db().get('products', destaque1))?.nome : null;
    const r = { texto, rastro: trace, mudouLoja, estado: { destaques_home: destaques, nomeDestaque1 } };
    const falhas = [c.deve(r), c.deve2(r), c.proibido(r)].filter((x) => x !== true && x !== null && x !== undefined);
    resultados.push({ id: c.id, pergunta: c.pergunta, passou: falhas.length === 0, falhas, rastro: trace.map((x) => x.nome), resposta: texto });
  });
}
const passou = resultados.filter((r) => r.passou).length;
for (const r of resultados) console.log(`${r.passou ? 'PASSOU' : 'FALHOU'}  ${r.id}${r.falhas.length ? ` — ${r.falhas.join('; ')}` : ''}`);
console.log(`\n${passou}/${resultados.length} cenários passaram · modelo ${MODEL()}`);
const dir = path.resolve('eval/alex/resultados'); fs.mkdirSync(dir, { recursive: true });
const arq = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(arq, JSON.stringify({ modelo: MODEL(), provedor: PROVEDOR(), passou, total: resultados.length, resultados }, null, 2));
console.log(`Resultado completo: ${arq}`);
process.exit(passou === resultados.length ? 0 : 1);
