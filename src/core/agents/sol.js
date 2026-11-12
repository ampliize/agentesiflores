// SOL — custos, precificação e resultado financeiro. Conversacional: responde perguntas como
// "Meu buquê custa R$50 para produzir. Por quanto posso vender?" mostrando sempre as premissas.
import { active } from '../team.js';
import { serial } from '../store.js';
import { working } from '../events.js';
import { listProducts, acharProduto } from '../catalog.js';
import { precoSugerido, impactoDesconto, analisarProduto, margens, diagnosticoMargem, resumoPeriodo, params } from '../finance.js';
import { getChat, saveChat } from './alex.js';
import { aiEnabled, runToolLoop } from '../llm.js';
import { brl, pct, norm, parseValor, now } from '../util.js';

const premissas = (r) => `\n\nPremissas:\n${r.premissas.map((p) => `• ${p}`).join('\n')}${r.parcial ? `\n\n⚠️ Cálculo parcial: falta ${r.faltando.join(' e ')}.` : ''}`;

export function textoPreco(r) {
  if (!r.sugerido) return `Com esses custos, não há preço que atinja a margem desejada: os custos variáveis e o rateio já consomem quase todo o preço. Reveja os custos fixos ou a meta.${premissas(r)}`;
  const a = r.analise;
  return `Para um produto que custa ${brl(r.custo)} para produzir:
• Abaixo de ${brl(r.minimo)} você paga para vender (não cobre nem os custos variáveis).
• ${brl(r.equilibrio)} cobre o custo e a parte dos custos fixos (resultado zero).
• Sugestão: ${brl(r.sugerido_arredondado)}.

Nesse preço:
• Margem de contribuição: ${brl(a.mc)} (${pct(a.mc_pct)})
• Rateio dos custos fixos: ${brl(a.rateio)}
• Resultado estimado do produto: ${brl(a.resultado)} (${pct(a.resultado_pct)}). Isso não é o lucro líquido da loja; é a contribuição estimada desse produto depois do rateio.${premissas(r)}`;
}

export function textoDesconto(d) {
  if (d.antes?.cmv == null && d.parcial) return `Não consigo avaliar o desconto: falta ${d.faltando.join(' e ')}.`;
  const base = `${d.produto ? `${d.produto}: ` : ''}com ${d.desconto_pct}% de desconto o preço vai de ${brl(d.antes.preco)} para ${brl(d.depois.preco)}.
• Margem de contribuição: ${brl(d.antes.mc)} (${pct(d.antes.mc_pct)}) → ${brl(d.depois.mc)} (${pct(d.depois.mc_pct)})`;
  if (d.inviavel) return `${base}\n\nNão recomendo: com esse desconto cada venda passa a dar prejuízo antes mesmo dos custos fixos.${premissas(d)}`;
  const extra = d.vendas_extra_necessarias;
  const veredito = extra > 0.4 ? 'Não recomendo, a não ser que seja uma ação curta para atrair clientes novos.' : extra > 0.15 ? 'Pode valer se a promoção realmente aumentar o volume.' : 'O impacto é pequeno; dá para fazer.';
  return `${base}\n• Para manter o mesmo dinheiro, você precisaria vender ${pct(extra, 0)} a mais.\n\n${veredito}${premissas(d)}`;
}

function textoDiagnostico(d) {
  return `Comparando os últimos ${d.atual.dias} dias com os ${d.anterior.dias} anteriores:
• Faturamento: ${brl(d.anterior.faturamento)} → ${brl(d.atual.faturamento)}
• Margem de contribuição: ${brl(d.anterior.mc)} (${pct(d.anterior.mc_pct)}) → ${brl(d.atual.mc)} (${pct(d.atual.mc_pct)})
• Custos fixos do período: ${brl(d.atual.custos_fixos)}
• Resultado estimado: ${brl(d.anterior.resultado)} → ${brl(d.atual.resultado)}

Por que sobra menos:
${d.causas.map((c) => `• ${c}`).join('\n')}

Vender mais só aumenta o dinheiro disponível quando a margem de cada venda cobre os custos variáveis e ajuda a pagar os fixos. Esse resultado é estimado a partir das fichas de custo; não é o fechamento contábil.`;
}

function textoProduto(a) {
  if (a.cmv == null) return `${a.produto}: não consigo calcular, falta ${a.faltando.join(' e ')}.`;
  return `${a.produto} — preço ${brl(a.preco)}
• Custo da mercadoria (${a.cmv_fonte}): ${brl(a.cmv)}${a.cmv_itens?.length ? `\n${a.cmv_itens.map((i) => `   – ${i.qtd} ${i.unidade || ''} ${i.nome}: ${brl(i.total)}${i.perda_pct ? ` (com ${i.perda_pct}% de perda)` : ''}`).join('\n')}` : ''}
• Custos variáveis: ${brl(a.variaveis)}
• Margem de contribuição: ${brl(a.mc)} (${pct(a.mc_pct)})
• Rateio dos custos fixos: ${brl(a.rateio)}
• Resultado estimado após rateio: ${brl(a.resultado)} (${pct(a.resultado_pct)})${premissas(a)}`;
}

function interpretar(tenantId, texto, contexto) {
  const t = norm(texto);
  if (/(sobrando menos|sobra menos|sobrou menos|vendendo mais|lucro caiu|dinheiro nao sobra|nao sobra)/.test(t)) return { tipo: 'diagnostico' };
  const desc = t.match(/(\d{1,2}(?:[.,]\d)?)\s*(?:%|por cento)/);
  if (/desconto|promoc/.test(t)) {
    const ps = acharProduto(tenantId, texto);
    const produto = ps.length === 1 ? ps[0] : contexto?.produto_id ? listProducts(tenantId).find((p) => p.id === contexto.produto_id) : null;
    const valor = parseValor(t.replace(/\d{1,2}\s*%/, ''));
    if (!desc) return { pergunta: `De quanto seria o desconto${produto ? ` no ${produto.nome}` : ''}? Ex.: "10%".`, contexto: { produto_id: produto?.id } };
    if (!produto && !contexto?.custo) return { pergunta: `Em qual produto seria o desconto de ${desc[1]}%?`, contexto: { desconto: Number(desc[1].replace(',', '.')) } };
    return { tipo: 'desconto', produto, descontoPct: Number(desc[1].replace(',', '.')), preco: produto ? undefined : contexto?.preco, cmv: produto ? undefined : contexto?.custo, valor };
  }
  if (contexto?.desconto && acharProduto(tenantId, texto).length === 1) return { tipo: 'desconto', produto: acharProduto(tenantId, texto)[0], descontoPct: contexto.desconto };
  if (/(por quanto|que preco|qual preco|quanto (?:devo|posso) cobrar|quanto cobrar|precificar|preco de venda)/.test(t)) {
    const custo = parseValor(t);
    const ps = acharProduto(tenantId, texto);
    if (custo == null && ps.length === 1) return { tipo: 'produto', produto: ps[0] };
    if (custo == null) return { pergunta: 'Quanto custa para produzir? Some flores, embalagem, laço e cartão.' };
    const m = t.match(/margem de (\d{1,2})/);
    return { tipo: 'preco', custo, margem: m ? Number(m[1]) : undefined };
  }
  if (/(margem|quanto deixa|quanto sobra|lucro do|custo do|custo da)/.test(t)) {
    if (/(baixa|menor|pior|ruim|todos|lista)/.test(t)) return { tipo: 'margens' };
    const ps = acharProduto(tenantId, texto);
    if (ps.length === 1) return { tipo: 'produto', produto: ps[0] };
    if (ps.length > 1) return { pergunta: `Qual deles: ${ps.map((p) => p.nome).join(' ou ')}?` };
    return { tipo: 'margens' };
  }
  if (/(custo fixo|custos fixos|resultado do mes|faturamento|resumo financeiro|como estao as financas)/.test(t)) return { tipo: 'resumo' };
  return { ajuda: true };
}

const AJUDA = 'Pode me perguntar, por exemplo:\n• "Meu buquê custa R$50 para produzir. Por quanto posso vender?"\n• "Posso dar 10% de desconto no Buquê Encanto?"\n• "Por que estou vendendo mais e sobrando menos?"\n• "Qual a margem da Cesta Café da Manhã?"\n• "Quais produtos têm margem baixa?"';

export function conversar(tenantId, texto) { return serial(`${tenantId}:chat:sol`, () => conversarAgora(tenantId, texto)); }
async function conversarAgora(tenantId, texto) {
  if (!active(tenantId, 'sol')) return { texto: 'A Sol não está contratada ou está pausada nesta loja.' };
  const chat = getChat(tenantId, 'sol');
  chat.mensagens.push({ role: 'user', texto, em: now() });
  const resposta = await working(tenantId, 'sol', 'Fazendo as contas', async () => {
    if (aiEnabled()) {
      const history = chat.mensagens.slice(-12).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.texto }));
      const obj = { type: 'object', additionalProperties: false };
      const tools = [
        { name: 'preco_sugerido', description: 'Preço mínimo, de equilíbrio e sugerido para um custo de produção.', input_schema: { ...obj, required: ['custo', 'margem_alvo_pct'], properties: { custo: { type: 'number' }, margem_alvo_pct: { type: ['number', 'null'] } } }, run: (i) => precoSugerido(tenantId, { custo: i.custo, margemAlvoPct: i.margem_alvo_pct ?? undefined }) },
        { name: 'impacto_desconto', description: 'Efeito de um desconto em um produto do catálogo.', input_schema: { ...obj, required: ['produto', 'desconto_pct'], properties: { produto: { type: 'string' }, desconto_pct: { type: 'number' } } }, run: (i) => { const ps = acharProduto(tenantId, i.produto); return ps.length === 1 ? impactoDesconto(tenantId, { produto: ps[0], descontoPct: i.desconto_pct }) : { erro: 'produto ambíguo ou não encontrado', candidatos: ps.map((p) => p.nome) }; } },
        { name: 'analisar_produto', description: 'Custo, margem de contribuição, rateio e resultado de um produto.', input_schema: { ...obj, required: ['produto'], properties: { produto: { type: 'string' } } }, run: (i) => { const ps = acharProduto(tenantId, i.produto); return ps.length === 1 ? analisarProduto(tenantId, ps[0]) : { erro: 'produto ambíguo ou não encontrado', candidatos: ps.map((p) => p.nome) }; } },
        { name: 'margens', description: 'Margens de todos os produtos.', input_schema: { ...obj, required: [], properties: {} }, run: () => margens(tenantId) },
        { name: 'diagnostico_margem', description: 'Compara os últimos 30 dias com os 30 anteriores e explica por que sobra menos dinheiro.', input_schema: { ...obj, required: [], properties: {} }, run: () => diagnosticoMargem(tenantId) },
      ];
      const r = await runToolLoop({ system: `Você é a Sol, especialista em custos e precificação de floriculturas. Explique em linguagem simples, mostre sempre as premissas, separe margem de contribuição de custos fixos e nunca chame o resultado estimado de um produto de lucro líquido da loja. Se faltar dado, diga que o cálculo é parcial e peça o que falta. Use as ferramentas para todos os números.`, messages: history, tools, effort: 'medium' });
      return { texto: r.text };
    }
    const it = interpretar(tenantId, texto, chat.contexto);
    chat.contexto = it.contexto || (it.produto ? { produto_id: it.produto.id } : it.tipo === 'preco' ? { custo: it.custo } : chat.contexto);
    if (it.pergunta) return { texto: it.pergunta };
    if (it.ajuda) return { texto: AJUDA };
    if (it.tipo === 'preco') { const r = precoSugerido(tenantId, { custo: it.custo, margemAlvoPct: it.margem }); chat.contexto = { custo: it.custo, preco: r.sugerido_arredondado }; return { texto: textoPreco(r), dados: r }; }
    if (it.tipo === 'desconto') { const d = impactoDesconto(tenantId, { produto: it.produto, descontoPct: it.descontoPct, preco: it.preco, cmv: it.cmv }); return { texto: textoDesconto(d), dados: d }; }
    if (it.tipo === 'diagnostico') return { texto: textoDiagnostico(diagnosticoMargem(tenantId)) };
    if (it.tipo === 'produto') return { texto: textoProduto(analisarProduto(tenantId, it.produto)) };
    if (it.tipo === 'margens') {
      const ms = margens(tenantId).filter((a) => a.mc_pct != null).sort((a, b) => a.mc_pct - b.mc_pct);
      const sem = margens(tenantId).filter((a) => a.cmv == null);
      return { texto: `Margem de contribuição por produto (menor para maior):\n${ms.map((a) => `• ${a.produto}: ${brl(a.mc)} (${pct(a.mc_pct)})${a.mc_pct < 0.35 ? ' ⚠️ baixa' : ''}`).join('\n')}${sem.length ? `\n\nSem custo cadastrado: ${sem.map((a) => a.produto).join(', ')}.` : ''}` };
    }
    if (it.tipo === 'resumo') {
      const r = resumoPeriodo(tenantId); const P = params(tenantId);
      return { texto: `Últimos 30 dias: faturamento ${brl(r.faturamento)}, margem de contribuição ${brl(r.mc)} (${pct(r.mc_pct)}), custos fixos ${brl(r.custos_fixos)} (${brl(P.fixos)}/mês), resultado estimado ${brl(r.resultado)}. Estimativa a partir das fichas de custo e das vendas registradas.` };
    }
    return { texto: AJUDA };
  });
  chat.mensagens.push({ role: 'assistant', texto: resposta.texto, em: now() });
  saveChat(chat);
  return resposta;
}
