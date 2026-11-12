// FLORA — atendimento e vendas no WhatsApp e no chat da loja.
// Regras inegociáveis: só informações reais (catálogo, datas, frete); nada de desconto não
// autorizado; resumo conferido antes de criar o pedido; link enviado ≠ pagamento confirmado;
// pedido em aberto é reaproveitado (sem duplicar); quando um funcionário assume, a Flora pausa.
import { db } from '../store.js';
import { getConfig, active, getTenant } from '../team.js';
import { log, working } from '../events.js';
import { createTask } from '../tasks.js';
import { buscarProdutos, verificarData, calcularFrete, getSettings, acharProduto, getProduct, disponibilidade, horarioDoDia } from '../catalog.js';
import { criarPedido, pedidoEmAberto, listOrders, registrarPergunta, upsertCliente } from '../orders.js';
import { aiEnabled, runToolLoop } from '../llm.js';
import { brl, norm, uid, now, localDate, parseDia, fmtDia, addDays, parseValor } from '../util.js';
import { sendWhatsApp } from '../integrations/whatsapp.js';

// ---------------- conversas ----------------
export function getConversa(tenantId, canal, contato, nome) {
  const id = `${tenantId}:${canal}:${contato}`;
  return db().get('conversations', id) || db().put('conversations', { id, tenant_id: tenantId, canal, contato, nome: nome || '', status: 'flora', estado: { etapa: 'inicio', itens: [] }, ultima_cliente_em: null, created_at: now() });
}
export const listMessages = (convId) => db().list('messages', null, (m) => m.conversation_id === convId).sort((a, b) => (a.em < b.em ? -1 : 1));
function addMsg(conv, role, texto) { return db().put('messages', { id: uid('msg_'), tenant_id: conv.tenant_id, conversation_id: conv.id, role, texto, em: now() }); }
const saveConv = (c) => db().put('conversations', c);

async function enviar(tenantId, conv, texto, role = 'flora') {
  addMsg(conv, role, texto);
  if (conv.canal === 'whatsapp') {
    try { await sendWhatsApp(getTenant(tenantId), conv.contato, texto); } catch (e) { log(tenantId, 'flora', `Falha ao enviar WhatsApp: ${e.message}`, { level: 'error' }); }
  }
}

const TEMAS = [
  ['entrega', /entreg|chega|prazo|hoje mesmo|mesmo dia|horario de entrega/], ['frete', /frete|taxa de entrega|cep|bairro/],
  ['pagamento', /pix|cartao de credito|pagar|pagamento|parcel|boleto/], ['horário da loja', /que horas|abre|fecha|funciona|aberto/],
  ['retirada', /retir|buscar na loja|endereco da loja/], ['preço', /quanto custa|preco|valor|mais barato/],
  ['troca e garantia', /troca|murch|durab|garantia/], ['cartão e mensagem', /cartao|bilhete|mensagem no/],
];
function temaDe(texto) { const t = norm(texto); return TEMAS.find(([, re]) => re.test(t))?.[0] || null; }

// ---------------- ferramentas (usadas pela IA e pela demonstração) ----------------
function complementos(tenantId) { return buscarProdutos(tenantId, { tipo: 'complemento' }); }
function resumoPedido(e) {
  const linhas = [...e.itens, ...(e.complementos || [])].map((i) => `• ${i.qtd}x ${i.nome}: ${brl(i.preco * i.qtd)}`);
  const sub = [...e.itens, ...(e.complementos || [])].reduce((s, i) => s + i.preco * i.qtd, 0);
  return `${linhas.join('\n')}\n• ${e.modalidade === 'retirada' ? 'Retirada na loja' : `Entrega em ${e.bairro}`}: ${e.modalidade === 'retirada' ? 'sem custo' : brl(e.frete)}\n` +
    `Data: ${fmtDia(e.data)}${e.janela ? `, ${e.janela}` : ''}\n${e.modalidade === 'entrega' ? `Para: ${e.destinatario}, ${e.endereco}\n` : `Quem retira: ${e.destinatario || e.comprador}\n`}` +
    `Cartão: ${e.mensagem_cartao ? `"${e.mensagem_cartao}"` : 'sem mensagem'}\n*Total: ${brl(sub + (e.modalidade === 'retirada' ? 0 : e.frete || 0))}*`;
}

function fecharPedido(tenantId, conv) {
  const e = conv.estado;
  const order = criarPedido(tenantId, {
    contato: conv.contato, canal: conv.canal, comprador: e.comprador || conv.nome, ocasiao: e.ocasiao,
    itens: [...e.itens, ...(e.complementos || [])].map((i) => ({ produto_id: i.produto_id, nome: i.nome, preco: i.preco, qtd: i.qtd })),
    modalidade: e.modalidade, data: e.data, janela: e.janela, destinatario: e.destinatario || e.comprador, endereco: e.endereco, bairro: e.bairro,
    frete: e.modalidade === 'retirada' ? 0 : e.frete || 0, mensagem_cartao: e.mensagem_cartao, origem: 'flora',
  });
  if (!order.ja_existia) {
    db().put('orders', { ...order, pagamento: { ...order.pagamento, enviado_em: now() } });
    log(tenantId, 'flora', `Criou o pedido #${order.numero} para ${conv.nome || conv.contato} (${brl(order.total)}) e enviou o link de pagamento`, { type: 'pedido', kind: 'acao', level: 'success', data: { order_id: order.id } });
  }
  return order;
}

function statusPedido(tenantId, contato) {
  const os = listOrders(tenantId, (o) => o.contato === contato && o.status !== 'cancelado');
  if (!os.length) return null;
  const o = os[0];
  const st = { aguardando_pagamento: 'aguardando o pagamento', pago: 'pago e na fila de produção', em_producao: 'em produção', saiu_para_entrega: 'saiu para entrega', entregue: 'entregue', pronto_retirada: 'pronto para retirada' }[o.status] || o.status;
  return { o, texto: `Pedido #${o.numero}: ${st}.${o.status === 'aguardando_pagamento' ? `\nAinda não recebemos a confirmação do pagamento. O link é este: ${o.pagamento.link}` : ''}` };
}

function transferir(tenantId, conv, motivo) {
  conv.status = 'humano'; conv.motivo_transferencia = motivo; saveConv(conv);
  createTask(tenantId, { responsavel: 'flora', solicitante: 'flora', tipo: 'pedido', titulo: `Atender ${conv.nome || conv.contato} (${motivo})`, prioridade: 'alta', detalhes: `Conversa no ${conv.canal === 'whatsapp' ? 'WhatsApp' : 'chat da loja'} encaminhada para uma pessoa da loja.` });
  log(tenantId, 'flora', `Encaminhou ${conv.nome || conv.contato} para uma pessoa da loja: ${motivo}`, { type: 'transferencia', level: 'warning' });
}

// ---------------- modo demonstração: atendimento guiado por etapas ----------------
const OCASIOES = [['aniversário', /aniversari|niver/], ['namorados', /namorad|amor|paixao|romant|esposa|marido/], ['mãe', /\bmae\b|maes|mamae/], ['agradecimento', /agradec|obrigad/], ['pedido de desculpas', /desculpa|perdao/], ['melhoras', /melhora|hospital|recupera/], ['nascimento', /nasceu|bebe|maternidade|nascimento/], ['condolências', /velorio|falec|condolenc|luto|funeral|coroa/], ['formatura', /formatura|formou/]];

function extrair(tenantId, conv, texto) {
  const t = norm(texto); const e = conv.estado; const s = getSettings(tenantId);
  for (const [nome, re] of OCASIOES) if (re.test(t)) { e.ocasiao = nome; break; }
  const orc = t.match(/(?:ate|uns|por volta de|no maximo|orcamento de|gastar)\s*r?\$?\s*(\d{2,4})/);
  if (orc) e.orcamento = Number(orc[1]);
  const d = /(\bdia\b|hoje|amanha|\d\/\d)/.test(t) ? parseDia(t) : null;
  if (d) e.data_pedida = d;
  if (/retir|buscar (?:na|aqui)|vou buscar|passo ai/.test(t)) e.modalidade = 'retirada';
  else if (/entreg|mandar para|enviar para/.test(t) && !e.modalidade) e.modalidade = 'entrega';
  const bairro = s.fretes.find((f) => f.ativo !== false && t.includes(norm(f.bairro)));
  if (bairro && e.modalidade !== 'retirada') { e.bairro = bairro.bairro; e.frete = bairro.valor; e.modalidade = 'entrega'; }
  const cartao = texto.match(/(?:cart[aã]o|mensagem|bilhete)\s*(?:com|:|dizendo|escrito)\s*["“]?(.+?)["”]?$/i);
  if (cartao) e.mensagem_cartao = cartao[1].trim();
  if (/sem (?:cartao|mensagem)/.test(t)) e.mensagem_cartao = '';
}

function sugerir(tenantId, e) {
  let ps = buscarProdutos(tenantId, { busca: `${e.busca || ''} ${e.ocasiao || ''}`, precoMax: e.orcamento });
  if (!ps.length) ps = buscarProdutos(tenantId, { precoMax: e.orcamento });
  if (!ps.length) ps = buscarProdutos(tenantId, {});
  ps = ps.sort((a, b) => (b.destaque ? 1 : 0) - (a.destaque ? 1 : 0)).slice(0, 3);
  e.opcoes = ps.map((p) => p.id);
  return ps;
}

function escolher(tenantId, e, texto) {
  const t = norm(texto);
  const idx = t.match(/\b(primeir|1|um\b|segund|2|dois|terceir|3|tres)/);
  if (idx && e.opcoes?.length) { const n = /primeir|1|um/.test(idx[1]) ? 0 : /segund|2|dois/.test(idx[1]) ? 1 : 2; const p = getProduct(e.opcoes[n]); if (p) return p; }
  const ps = acharProduto(tenantId, texto).filter((p) => disponibilidade(p, getSettings(tenantId)).ok);
  if (ps.length === 1) return ps[0];
  if (e.opcoes?.length) { const op = e.opcoes.map(getProduct).find((p) => p && norm(texto).split(' ').some((w) => w.length > 4 && norm(p.nome).includes(w))); if (op) return op; }
  return null;
}

async function demoResponder(tenantId, conv, texto) {
  const cfg = getConfig(tenantId, 'flora'); const loja = getTenant(tenantId).name; const s = getSettings(tenantId);
  const e = conv.estado; const t = norm(texto);
  const primeira = listMessages(conv.id).filter((m) => m.role === 'flora').length === 0;
  const ola = primeira ? `${cfg.saudacao.replace('{loja}', loja)}\n\n` : '';

  if (/(falar com (?:uma )?(?:pessoa|atendente|humano|alguem)|reclama|absurdo|errado|nao chegou|casamento|evento)/.test(t)) {
    transferir(tenantId, conv, /casamento|evento/.test(t) ? 'evento ou casamento' : /reclama|absurdo|errado|nao chegou/.test(t) ? 'reclamação' : 'cliente pediu uma pessoa');
    return 'Vou chamar uma pessoa da nossa equipe para te atender. Só um instante, por favor. 🙏';
  }
  if (/desconto|mais barato|faz por|abaixa|cupom/.test(t) && !/sem desconto/.test(t)) {
    if (!cfg.desconto_maximo_pct) return `${ola}Não consigo oferecer desconto por aqui, mas posso te mostrar opções em uma faixa de preço menor. Qual valor você gostaria de investir?`;
  }
  if (/(meu pedido|status|rastre|ja pagu|paguei|link|chegou o pagamento)/.test(t)) {
    const st = statusPedido(tenantId, conv.contato);
    if (st) return st.texto;
    if (!e.itens.length) return 'Não encontrei pedido neste número. Quer fazer um pedido novo?';
  }
  if (!s.recebendo_pedidos) return `${ola}No momento não estamos recebendo novos pedidos. Anotei seu contato e avisamos assim que voltarmos. 🌷`;

  extrair(tenantId, conv, texto);

  // perguntas diretas
  if (/(que horas|abre|fecha|horario de funcionamento|esta aberto|estao abertos)/.test(t)) {
    const h = horarioDoDia(s, localDate());
    return `${ola}${h ? `Hoje funcionamos das ${h[0]} às ${h[1]}.` : 'Hoje a loja está fechada.'} Pedidos para entrega no mesmo dia vão até ${s.corte_mesmo_dia}. Posso te ajudar a escolher?`;
  }
  if (/(entregam|entrega) (?:no|na|em) /.test(t) && !e.itens.length) {
    const b = texto.match(/(?:no|na|em)\s+(?:bairro\s+)?([A-ZÀ-ú][\wÀ-ú ]+)/i);
    const f = b ? calcularFrete(tenantId, b[1]) : null;
    return f?.ok ? `${ola}Entregamos sim em ${f.bairro}! O frete é ${brl(f.valor)}. Já sabe o que quer presentear?` : `${ola}${f?.motivo || 'Me diz o bairro, por favor?'}`;
  }

  // escolha do produto
  if (!e.itens.length) {
    const escolhido = e.opcoes?.length ? escolher(tenantId, e, texto) : null;
    if (!escolhido) {
      if (!e.ocasiao && !e.orcamento && primeira && !/(buque|flor|rosa|orquidea|cesta|arranjo|girass|presente)/.test(t)) return `${ola}É para alguma ocasião especial? E tem um valor em mente?`;
      e.busca = texto;
      const ps = sugerir(tenantId, e);
      if (!ps.length) return `${ola}No momento estamos sem produtos disponíveis nessa faixa. Posso chamar alguém da equipe para montar algo sob medida?`;
      return `${ola}Separei estas opções${e.ocasiao ? ` para ${e.ocasiao}` : ''}${e.orcamento ? ` até ${brl(e.orcamento)}` : ''}:\n${ps.map((p, i) => `${i + 1}. ${p.nome}: ${brl(p.preco)}\n   ${p.descricao}`).join('\n')}\n\nQual delas você prefere?`;
    }
    e.itens = [{ produto_id: escolhido.id, nome: escolhido.nome, preco: escolhido.preco, qtd: 1 }];
    if (cfg.fazer_upsell && !e.upsell_oferecido) {
      e.upsell_oferecido = true;
      const comps = complementos(tenantId).slice(0, 3);
      if (comps.length) { e.opcoes_comp = comps.map((c) => c.id); return `Ótima escolha! ${escolhido.nome} por ${brl(escolhido.preco)}.\n\nQuer incluir algum complemento?\n${comps.map((c) => `• ${c.nome}: ${brl(c.preco)}`).join('\n')}\n(ou responda "não")`; }
    }
  } else if (e.upsell_oferecido && !e.upsell_respondido) {
    e.upsell_respondido = true;
    const comps = (e.opcoes_comp || []).map(getProduct).filter(Boolean).filter((c) => norm(texto).split(/\s+/).some((w) => w.length > 3 && norm(c.nome).includes(w)));
    if (comps.length) e.complementos = comps.map((c) => ({ produto_id: c.id, nome: c.nome, preco: c.preco, qtd: 1 }));
  }
  if (e.upsell_oferecido && !e.upsell_respondido) e.upsell_respondido = true;

  // modalidade e data
  if (!e.modalidade) return 'Vai ser entrega ou você prefere retirar na loja?';
  if (!e.data) {
    if (!e.data_pedida && e.pediu_data) e.data_pedida = parseDia(t);
    if (!e.data_pedida) { e.pediu_data = true; return `Para qual dia? ${e.modalidade === 'entrega' ? `Para hoje, pedidos até ${s.corte_mesmo_dia}.` : ''}`; }
    const v = verificarData(tenantId, e.data_pedida, e.modalidade);
    if (!v.ok) { const pedida = e.data_pedida; e.data_pedida = null; return `${v.motivo} ${pedida ? 'Pode ser em outra data?' : ''}`.trim(); }
    e.data = e.data_pedida; e.janelas = v.janelas;
    if (e.modalidade === 'entrega') return `Perfeito, ${fmtDia(e.data)}. Qual janela prefere? ${v.janelas.join(', ')}`;
    e.janela = v.janelas[0];
  }
  const pergunta = (slot, txt) => { e.aguardando = slot; return txt; };
  if (e.modalidade === 'entrega' && !e.janela) {
    const j = (e.janelas || []).find((x) => t.includes(x.slice(0, 2)) || (t.includes('manha') && x.startsWith('09')) || (t.includes('tarde') && x.startsWith('15')));
    if (!j) return `Qual janela? ${(e.janelas || []).join(', ')}`;
    e.janela = j; return pergunta('endereco', 'Anotado! Qual o endereço completo de entrega, com o bairro?');
  }
  if (e.modalidade === 'entrega' && !e.endereco) {
    if (e.aguardando !== 'endereco') return pergunta('endereco', 'Qual o endereço completo de entrega, com o bairro?');
    e.endereco = texto.trim();
    const f = getSettings(tenantId).fretes.find((x) => x.ativo !== false && norm(texto).includes(norm(x.bairro)));
    if (f) { e.bairro = f.bairro; e.frete = f.valor; }
    if (!e.bairro) { e.endereco = null; return pergunta('endereco', `Não identifiquei um bairro que atendemos nesse endereço. Atendemos: ${s.fretes.filter((x) => x.ativo !== false).map((x) => x.bairro).join(', ')}. Se preferir, você pode retirar na loja (${s.retirada.endereco}).`); }
    return pergunta('destinatario', `Frete para ${e.bairro}: ${brl(e.frete)}. Qual o nome de quem vai receber?`);
  }
  if (!e.destinatario) {
    if (e.aguardando !== 'destinatario') return pergunta('destinatario', e.modalidade === 'entrega' ? 'Qual o nome de quem vai receber?' : 'Qual o nome de quem vai retirar?');
    e.destinatario = texto.trim().replace(/^(e |é |para |pra )/i, '');
    return pergunta('cartao', 'Quer que eu inclua uma mensagem no cartão? Me diga o texto (ou "sem cartão").');
  }
  if (e.mensagem_cartao == null) {
    if (e.aguardando !== 'cartao') return pergunta('cartao', 'Quer que eu inclua uma mensagem no cartão? Me diga o texto (ou "sem cartão").');
    e.mensagem_cartao = /^(nao|sem)\b/.test(t) ? '' : texto.trim();
  }
  if (!e.comprador) {
    if (e.aguardando !== 'comprador') return pergunta('comprador', 'E qual o seu nome, para o pedido?');
    e.comprador = texto.trim().replace(/^(meu nome e |meu nome é |sou |e )/i, ''); conv.nome = conv.nome || e.comprador;
  }
  e.aguardando = null;
  if (!e.resumo_enviado) { e.resumo_enviado = true; return `Confere o resumo, por favor:\n\n${resumoPedido(e)}\n\nPosso criar o pedido e te enviar o link de pagamento?`; }
  if (!e.pedido_id) {
    if (/^(sim|pode|ok|isso|confirmo|confirma|perfeito|certo|manda|pode criar)/.test(t)) {
      const v = verificarData(tenantId, e.data, e.modalidade);
      if (!v.ok) { e.data = null; e.janela = null; e.resumo_enviado = false; return `${v.motivo} Vamos escolher outra data?`; }
      for (const i of e.itens) { const p = getProduct(i.produto_id); if (!disponibilidade(p, s).ok) { e.itens = []; e.resumo_enviado = false; e.opcoes = null; return `Desculpe, o ${i.nome} acabou de ficar indisponível. Posso te sugerir outra opção?`; } }
      const o = fecharPedido(tenantId, conv);
      e.pedido_id = o.id;
      return `${o.ja_existia ? `Você já tem o pedido #${o.numero} aguardando pagamento, então reenviei o mesmo link` : `Pedido #${o.numero} criado`}! 💐\nPague por aqui: ${o.pagamento.link}\n\nAssim que o pagamento for confirmado pelo sistema, eu te aviso por aqui.`;
    }
    if (/(nao|corrig|mud|troc|errad)/.test(t)) { e.resumo_enviado = false; e.destinatario = null; e.mensagem_cartao = null; e.aguardando = 'destinatario'; return 'Sem problema, vamos corrigir. Qual o nome de quem vai receber? Depois confirmo o cartão de novo.'; }
    return 'Posso criar o pedido? Responda "sim" para receber o link de pagamento.';
  }
  const st = statusPedido(tenantId, conv.contato);
  return st ? st.texto : 'Posso ajudar com mais alguma coisa?';
}

// ---------------- IA (Claude) ----------------
function system(tenantId) {
  const cfg = getConfig(tenantId, 'flora'); const s = getSettings(tenantId); const loja = getTenant(tenantId).name;
  return `Você é a Flora, atendente da floricultura "${loja}" no WhatsApp e no chat da loja. Tom: ${cfg.tom}.
Objetivo: facilitar a compra, do primeiro contato até o pedido criado e o link de pagamento enviado.
Saudação (só na primeira mensagem): "${cfg.saudacao.replace('{loja}', loja)}"
Regras:
- Use SEMPRE as ferramentas para produtos, preços, disponibilidade, datas, frete e pedidos. Nunca invente disponibilidade, preço ou prazo.
- Entenda a ocasião, o orçamento e a data. Recomende até 3 opções.
- ${cfg.fazer_upsell ? 'Ofereça complementos (ferramenta listar_complementos) uma vez, de forma natural.' : 'Não ofereça complementos.'}
- Desconto máximo autorizado: ${cfg.desconto_maximo_pct}%. ${cfg.desconto_maximo_pct ? '' : 'Não ofereça nem conceda desconto.'}
- Colete: produto, entrega ou retirada, data e janela, endereço com bairro (se entrega), nome de quem recebe, mensagem do cartão e nome de quem compra.
- Antes de criar o pedido, apresente o resumo com o total e peça confirmação. Só chame criar_pedido com cliente_confirmou_resumo=true depois do "sim" do cliente.
- Enviar o link NÃO confirma o pagamento. Para status, use consultar_pedido. Se pedirem o link de novo, use o pedido existente.
- Encaminhe para uma pessoa (transferir_para_pessoa) em: ${cfg.transferir_quando}.
- Mensagens curtas, uma pergunta por vez.
Hoje é ${localDate()}. Corte para entrega no mesmo dia: ${s.corte_mesmo_dia}. Retirada: ${s.retirada.ativa ? s.retirada.endereco : 'não disponível'}.
${cfg.instrucoes || ''}`;
}

function tools(tenantId, conv) {
  const obj = (props, req = Object.keys(props)) => ({ type: 'object', additionalProperties: false, required: req, properties: props });
  const N = (t) => ({ type: [t, 'null'] });
  return [
    { name: 'buscar_produtos', description: 'Produtos disponíveis agora (ativos e com estoque).', input_schema: obj({ busca: { type: 'string' }, preco_max: N('number'), data: { type: ['string', 'null'], description: 'YYYY-MM-DD' } }), run: (i) => buscarProdutos(tenantId, { busca: i.busca, precoMax: i.preco_max || undefined, data: i.data || undefined }).slice(0, 6).map((p) => ({ id: p.id, nome: p.nome, preco: p.preco, descricao: p.descricao, estoque: p.estoque })) },
    { name: 'listar_complementos', description: 'Complementos disponíveis (chocolates, cartões, pelúcias...).', input_schema: obj({}), run: () => complementos(tenantId).map((p) => ({ id: p.id, nome: p.nome, preco: p.preco })) },
    { name: 'verificar_data', description: 'Verifica se é possível entregar ou retirar numa data e retorna as janelas.', input_schema: obj({ data: { type: 'string', description: 'YYYY-MM-DD' }, modalidade: { type: 'string', enum: ['entrega', 'retirada'] } }), run: (i) => verificarData(tenantId, i.data, i.modalidade) },
    { name: 'calcular_frete', description: 'Frete para um bairro, conforme as configurações da loja.', input_schema: obj({ bairro: { type: 'string' } }), run: (i) => calcularFrete(tenantId, i.bairro) },
    { name: 'criar_pedido', description: 'Cria o pedido na loja e retorna o link de pagamento. Reaproveita pedido igual em aberto.',
      input_schema: obj({ cliente_confirmou_resumo: { type: 'boolean' }, itens: { type: 'array', items: obj({ produto_id: { type: 'string' }, qtd: { type: 'integer' } }) }, modalidade: { type: 'string', enum: ['entrega', 'retirada'] }, data: { type: 'string' }, janela: N('string'), bairro: N('string'), endereco: N('string'), destinatario: { type: 'string' }, mensagem_cartao: N('string'), comprador: { type: 'string' }, ocasiao: N('string') }),
      run: (i) => {
        if (!i.cliente_confirmou_resumo) return { erro: 'Apresente o resumo e aguarde a confirmação do cliente antes de criar o pedido.' };
        const s = getSettings(tenantId);
        const itens = i.itens.map((x) => { const p = getProduct(x.produto_id); if (!p || p.tenant_id !== tenantId || !disponibilidade(p, s).ok) throw new Error(`Produto indisponível: ${x.produto_id}`); return { produto_id: p.id, nome: p.nome, preco: p.preco, qtd: x.qtd }; });
        const v = verificarData(tenantId, i.data, i.modalidade); if (!v.ok) return { erro: v.motivo };
        let frete = 0; if (i.modalidade === 'entrega') { const f = calcularFrete(tenantId, i.bairro || ''); if (!f.ok) return { erro: f.motivo }; frete = f.valor; }
        conv.estado = { ...conv.estado, itens, complementos: [], modalidade: i.modalidade, data: i.data, janela: i.janela, bairro: i.bairro, endereco: i.endereco, destinatario: i.destinatario, mensagem_cartao: i.mensagem_cartao, comprador: i.comprador, ocasiao: i.ocasiao, frete };
        const o = fecharPedido(tenantId, conv); conv.estado.pedido_id = o.id;
        return { numero: o.numero, total: o.total, link_pagamento: o.pagamento.link, ja_existia: !!o.ja_existia, status_pagamento: o.pagamento.status };
      } },
    { name: 'consultar_pedido', description: 'Status do último pedido deste cliente e do pagamento (conforme o sistema).', input_schema: obj({}), run: () => statusPedido(tenantId, conv.contato)?.o || { info: 'nenhum pedido encontrado' } },
    { name: 'transferir_para_pessoa', description: 'Encaminha a conversa para uma pessoa da loja.', input_schema: obj({ motivo: { type: 'string' } }), run: (i) => { transferir(tenantId, conv, i.motivo); return { ok: true }; } },
  ];
}

// ---------------- entrada principal ----------------
/** Mensagem de cliente (WhatsApp, chat da loja ou simulador). */
export async function receberMensagem(tenantId, { canal = 'chat_loja', contato, nome, texto }) {
  const conv = getConversa(tenantId, canal, contato, nome);
  addMsg(conv, 'cliente', texto);
  conv.ultima_cliente_em = now(); conv.recuperacao_enviada = false;
  const tema = temaDe(texto); if (tema) registrarPergunta(tenantId, tema, texto);
  upsertCliente(tenantId, { contato, nome: nome || conv.nome });
  const cfg = getConfig(tenantId, 'flora');
  if (!active(tenantId, 'flora') || conv.status === 'humano' || (canal !== 'simulador' && !cfg.canais[canal === 'chat_loja' ? 'chat_loja' : 'whatsapp'])) { saveConv(conv); return { conversa_id: conv.id, resposta: null, pausada: conv.status === 'humano' }; }
  const resposta = await working(tenantId, 'flora', `Atendendo ${nome || contato}`, async () => {
    try {
      if (aiEnabled()) {
        const hist = listMessages(conv.id).slice(-30).filter((m) => m.role !== 'sistema').map((m) => ({ role: m.role === 'cliente' ? 'user' : 'assistant', content: m.texto }));
        const msgs = []; for (const m of hist) { const l = msgs[msgs.length - 1]; if (l && l.role === m.role) l.content += `\n${m.content}`; else msgs.push({ ...m }); }
        while (msgs.length && msgs[0].role !== 'user') msgs.shift();
        const r = await runToolLoop({ system: system(tenantId), messages: msgs, tools: tools(tenantId, conv), effort: 'low' });
        return r.text || 'Vou chamar uma pessoa da equipe para continuar seu atendimento. 🌷';
      }
      return await demoResponder(tenantId, conv, texto);
    } catch (err) {
      log(tenantId, 'flora', `Erro no atendimento de ${contato}: ${err.message}`, { level: 'error' });
      transferir(tenantId, conv, 'erro no atendimento automático');
      return 'Tive uma instabilidade aqui. Já chamei uma pessoa da equipe para continuar com você. 🙏';
    }
  });
  const fresh = db().get('conversations', conv.id);
  saveConv({ ...conv, status: fresh?.status === 'humano' ? 'humano' : conv.status });
  await enviar(tenantId, conv, resposta);
  return { conversa_id: conv.id, resposta };
}

/** Mensagem enviada por um funcionário pelo painel: a Flora pausa nessa conversa. */
export async function mensagemFuncionario(tenantId, convId, texto) {
  const conv = db().get('conversations', convId);
  if (!conv || conv.tenant_id !== tenantId) throw new Error('Conversa não encontrada');
  if (conv.status !== 'humano') { conv.status = 'humano'; conv.motivo_transferencia = 'funcionário assumiu'; saveConv(conv); log(tenantId, 'flora', `Pausou o atendimento de ${conv.nome || conv.contato}: um funcionário assumiu`, { type: 'pausa' }); }
  await enviar(tenantId, conv, texto, 'funcionario');
  return conv;
}

export function devolverParaFlora(tenantId, convId) {
  const conv = db().get('conversations', convId);
  if (!conv || conv.tenant_id !== tenantId) throw new Error('Conversa não encontrada');
  saveConv({ ...conv, status: 'flora' });
  log(tenantId, 'flora', `Voltou a atender ${conv.nome || conv.contato}`, { type: 'retomada' });
}

// ---------------- rotinas: recuperação e recompra ----------------
export async function rotina(tenantId, agora = new Date()) {
  if (!active(tenantId, 'flora')) return { recuperadas: 0, recompra: 0 };
  const cfg = getConfig(tenantId, 'flora');
  let recuperadas = 0; let recompra = 0;
  if (cfg.recuperar_abandonos) {
    const limite = new Date(agora - cfg.horas_para_recuperar * 3600e3).toISOString();
    const janela = new Date(agora - 23 * 3600e3).toISOString(); // janela de 24 h do WhatsApp
    for (const c of db().list('conversations', tenantId, (x) => x.status === 'flora' && !x.recuperacao_enviada && x.ultima_cliente_em && x.ultima_cliente_em <= limite && x.ultima_cliente_em >= janela)) {
      const aberto = pedidoEmAberto(tenantId, c.contato);
      let msg = null;
      if (aberto) msg = `Oi${c.nome ? `, ${c.nome.split(' ')[0]}` : ''}! Seu pedido #${aberto.numero} ainda está aguardando pagamento. Se quiser finalizar, o link é este: ${aberto.pagamento.link} 🌷`;
      else if (c.estado?.itens?.length && !c.estado.pedido_id) msg = `Oi${c.nome ? `, ${c.nome.split(' ')[0]}` : ''}! Vi que você estava escolhendo o ${c.estado.itens[0].nome}. Posso te ajudar a finalizar?`;
      if (!msg) continue;
      await enviar(tenantId, c, msg);
      saveConv({ ...c, recuperacao_enviada: true });
      recuperadas++;
      log(tenantId, 'flora', `Enviou mensagem de recuperação para ${c.nome || c.contato}`, { type: 'recuperacao', kind: 'acao' });
    }
  }
  if (cfg.recompra?.ativa) {
    const hoje = localDate(agora); const alvo = addDays(hoje, cfg.recompra.dias_antes);
    for (const cli of db().list('customers', tenantId, (x) => x.optin_marketing && x.data_ocasiao && x.data_ocasiao.slice(5) === alvo.slice(5) && x.data_ocasiao < hoje && x.recompra_enviada !== hoje.slice(0, 4))) {
      const conv = getConversa(tenantId, 'whatsapp', cli.contato, cli.nome);
      await enviar(tenantId, conv, `Oi${cli.nome ? `, ${cli.nome.split(' ')[0]}` : ''}! No ano passado você presenteou com flores no dia ${fmtDia(cli.data_ocasiao)}${cli.ocasiao ? ` (${cli.ocasiao})` : ''}. Quer que eu separe algo especial de novo? 🌷 (Responda SAIR para não receber mais lembretes.)`);
      db().put('customers', { ...cli, recompra_enviada: hoje.slice(0, 4) });
      recompra++;
      log(tenantId, 'flora', `Enviou lembrete de recompra autorizado para ${cli.nome || cli.contato}`, { type: 'recompra', kind: 'acao' });
    }
  }
  return { recuperadas, recompra };
}

export function optout(tenantId, contato) {
  const c = db().get('customers', `${tenantId}:${contato}`); if (c) db().put('customers', { ...c, optin_marketing: false });
}
