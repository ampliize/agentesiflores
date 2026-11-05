// Agente ATENDENTE — vende pelo WhatsApp usando o catálogo, frete e pedidos da iFlores.
import { get, all, run, uid, now } from '../db.js';
import { getAgentConfig, getTenant } from '../lib/tenants.js';
import { logActivity, setAgentStatus } from '../lib/events.js';
import { aiEnabled, runToolLoop } from '../lib/llm.js';
import { IFloresClient } from '../integrations/iflores.js';
import { sendWhatsApp } from '../integrations/whatsapp.js';
import { dispatchWebhook } from '../lib/webhooks-out.js';

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const brl = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;

export function isOpen(cfg, date = new Date()) {
  const h = cfg.horario_atendimento || {};
  const local = new Date(date.toLocaleString('en-US', { timeZone: process.env.TZ_LOJA || 'America/Sao_Paulo' }));
  const hhmm = local.toTimeString().slice(0, 5);
  return (h.dias || DIAS).includes(DIAS[local.getDay()]) && hhmm >= (h.inicio || '00:00') && hhmm <= (h.fim || '23:59');
}

function buildSystem(tenant, cfg) {
  const faq = (cfg.faq || []).map((f) => `- P: ${f.pergunta}\n  R: ${f.resposta}`).join('\n');
  return `Você é ${cfg.nome_exibicao}, atendente virtual da floricultura "${tenant.name}" no WhatsApp.
Seu objetivo é atender bem e VENDER: entender a ocasião, indicar produtos do catálogo, calcular o frete e fechar o pedido gerando o link de pagamento.

Tom de voz: ${cfg.tom}.
Saudação inicial (use só na primeira mensagem): "${cfg.saudacao.replace('{nome}', cfg.nome_exibicao)}"

Regras:
- Use SEMPRE as ferramentas para preços, estoque, frete e status de pedido. Nunca invente preços ou produtos.
- Mensagens curtas, próprias de WhatsApp (até ~4 linhas). Uma pergunta por vez.
- Para fechar um pedido você precisa de: produto(s), nome de quem recebe, endereço com CEP, data/janela de entrega, mensagem do cartão (opcional) e nome/telefone de quem compra.
- Antes de criar o pedido, confirme o resumo e o valor total com o cliente.
${cfg.fazer_upsell ? `- Ofereça UM complemento de forma natural antes de fechar: ${cfg.sugestoes_upsell.join(', ')}.` : '- Não ofereça produtos adicionais.'}
- Desconto máximo permitido: ${cfg.desconto_maximo_percent}%. Nunca ofereça desconto espontaneamente.
- Transfira para um humano quando: ${cfg.transferir_para_humano_quando}.
- Políticas da loja: ${cfg.politicas}

Perguntas frequentes:
${faq || '(nenhuma)'}
${cfg.instrucoes ? `\nInstruções extras do dono:\n${cfg.instrucoes}` : ''}`;
}

function tools(ctx) {
  const { iflores, tenant, conv } = ctx;
  const nullable = (type) => ({ type: [type, 'null'] });
  return [
    {
      name: 'buscar_produtos',
      description: 'Busca produtos no catálogo da loja por termo, ocasião ou faixa de preço. Retorna nome, preço, estoque e complementos.',
      input_schema: { type: 'object', additionalProperties: false, required: ['busca', 'preco_max'], properties: { busca: { type: 'string', description: 'termos ex.: "rosas vermelhas", "dia das mães"' }, preco_max: nullable('number') } },
      run: (i) => iflores.searchProducts({ busca: i.busca, preco_max: i.preco_max || undefined }),
    },
    {
      name: 'calcular_frete',
      description: 'Calcula taxa e prazo de entrega para um CEP.',
      input_schema: { type: 'object', additionalProperties: false, required: ['cep'], properties: { cep: { type: 'string' } } },
      run: (i) => iflores.deliveryQuote({ cep: i.cep }),
    },
    {
      name: 'criar_pedido',
      description: 'Cria o pedido na iFlores após o cliente confirmar o resumo. Retorna número do pedido e link de pagamento.',
      input_schema: {
        type: 'object', additionalProperties: false,
        required: ['itens', 'destinatario', 'endereco', 'cep', 'data_entrega', 'janela', 'mensagem_cartao', 'comprador_nome', 'taxa_entrega'],
        properties: {
          itens: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['produto_id', 'nome', 'preco', 'quantidade'], properties: { produto_id: { type: 'string' }, nome: { type: 'string' }, preco: { type: 'number' }, quantidade: { type: 'integer' } } } },
          destinatario: { type: 'string' }, endereco: { type: 'string' }, cep: { type: 'string' },
          data_entrega: { type: 'string' }, janela: { type: 'string' }, mensagem_cartao: nullable('string'),
          comprador_nome: { type: 'string' }, taxa_entrega: { type: 'number' },
        },
      },
      run: async (i) => {
        const order = await iflores.createOrder({ ...i, comprador_telefone: conv.contact, origem: 'agente_atendente' });
        logActivity(tenant.id, 'atendente', 'pedido_criado', `Pedido ${order.id} criado para ${i.comprador_nome} (${brl(order.total)})`, { order, conversation_id: conv.id }, 'success');
        updateConv(conv.id, { pedidos: [...(conv.pedidos || []), order.id], valor_vendido: (conv.valor_vendido || 0) + (order.total || 0) });
        return order;
      },
    },
    {
      name: 'consultar_pedido',
      description: 'Consulta status e rastreio de um pedido existente.',
      input_schema: { type: 'object', additionalProperties: false, required: ['pedido_id'], properties: { pedido_id: { type: 'string' } } },
      run: (i) => iflores.getOrder(i.pedido_id),
    },
    {
      name: 'transferir_para_humano',
      description: 'Transfere a conversa para um atendente humano da loja. Use nos casos definidos pelo dono.',
      input_schema: { type: 'object', additionalProperties: false, required: ['motivo'], properties: { motivo: { type: 'string' } } },
      run: async (i) => {
        updateConv(conv.id, { motivo_transferencia: i.motivo }, 'humano');
        logActivity(tenant.id, 'atendente', 'transferido_humano', `Conversa com ${conv.contact_name || conv.contact} transferida: ${i.motivo}`, { conversation_id: conv.id }, 'warning');
        dispatchWebhook(tenant.id, 'atendimento.transferido', { conversation_id: conv.id, contato: conv.contact, motivo: i.motivo }).catch(() => {});
        return { ok: true, mensagem: 'Um atendente humano vai assumir em instantes.' };
      },
    },
  ];
}

function getOrCreateConv(tenantId, channel, contact, name) {
  let conv = get('SELECT * FROM conversations WHERE tenant_id = ? AND channel = ? AND contact = ?', tenantId, channel, contact);
  if (!conv) {
    const id = uid('conv_');
    run('INSERT INTO conversations (id, tenant_id, channel, contact, contact_name, status, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, tenantId, channel, contact, name || '', 'bot', JSON.stringify({ pedidos: [], valor_vendido: 0 }), now(), now());
    conv = get('SELECT * FROM conversations WHERE id = ?', id);
  }
  return conv;
}

function updateConv(id, patch, status) {
  const c = get('SELECT * FROM conversations WHERE id = ?', id);
  const { id: _i, tenant_id, channel, contact, contact_name, status: st, created_at, updated_at, ...data } = c;
  run('UPDATE conversations SET status = ?, data = ?, updated_at = ? WHERE id = ?', status || st, JSON.stringify({ ...data, ...patch }), now(), id);
}

const addMsg = (convId, role, content) =>
  run('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)', uid('msg_'), convId, role, content, now());

export const listMessages = (convId) => all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', convId);

/**
 * Processa uma mensagem do cliente e devolve a resposta da atendente.
 * channel: 'whatsapp' (envia de verdade se conectado) | 'simulador' (teste no painel) | 'api'
 */
export async function handleIncoming(tenantId, { channel = 'whatsapp', contact, name, text }) {
  const tenant = getTenant(tenantId);
  const cfg = getAgentConfig(tenantId, 'atendente');
  const conv = getOrCreateConv(tenantId, channel, contact, name);
  const started = Date.now();
  addMsg(conv.id, 'user', text);

  if (!cfg.enabled) return { conversation_id: conv.id, reply: null, skipped: 'agente desativado' };
  if (conv.status === 'humano') return { conversation_id: conv.id, reply: null, skipped: 'conversa com humano' };

  setAgentStatus(tenantId, 'atendente', 'trabalhando', `Atendendo ${name || contact}`);
  let reply;
  try {
    if (channel !== 'simulador' && !isOpen(cfg)) {
      reply = cfg.mensagem_fora_horario;
    } else if (aiEnabled()) {
      const history = listMessages(conv.id).slice(-30).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
      const iflores = new IFloresClient(tenant);
      const result = await runToolLoop({
        system: buildSystem(tenant, cfg),
        messages: mergeConsecutive(history),
        tools: tools({ iflores, tenant, conv }),
        effort: 'low',
      });
      reply = result.text || 'Só um instante, vou chamar alguém da equipe para te ajudar! 🌷';
    } else {
      reply = await demoReply(tenant, cfg, conv, text);
    }
  } catch (err) {
    logActivity(tenantId, 'atendente', 'erro', `Falha ao responder ${contact}: ${err.message}`, {}, 'error');
    reply = 'Tive uma instabilidade aqui, mas já estou chamando alguém da equipe para te atender! 🌷';
  } finally {
    setAgentStatus(tenantId, 'atendente', 'online', '');
  }

  addMsg(conv.id, 'assistant', reply);
  const elapsed = Math.round((Date.now() - started) / 1000);
  const fresh = get('SELECT * FROM conversations WHERE id = ?', conv.id);
  updateConv(conv.id, { respostas: (fresh.respostas || 0) + 1, tempo_resposta_total: (fresh.tempo_resposta_total || 0) + elapsed });

  if (channel === 'whatsapp') {
    try { await sendWhatsApp(tenant, contact, reply); } catch (err) { logActivity(tenantId, 'atendente', 'erro', `WhatsApp: ${err.message}`, {}, 'error'); }
  }
  logActivity(tenantId, 'atendente', 'mensagem', `Respondeu ${name || contact}: "${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}"`, { conversation_id: conv.id });
  return { conversation_id: conv.id, reply };
}

// A API exige alternância user/assistant: junta mensagens consecutivas do mesmo papel.
function mergeConsecutive(msgs) {
  const out = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n${m.content}`;
    else out.push({ ...m });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// ---------------- modo demonstração (sem chave de IA) ----------------
async function demoReply(tenant, cfg, conv, text) {
  const t = text.toLowerCase();
  const iflores = new IFloresClient(tenant);
  const first = listMessages(conv.id).filter((m) => m.role === 'assistant').length === 0;
  const hello = first ? cfg.saudacao.replace('{nome}', cfg.nome_exibicao) + '\n\n' : '';
  if (/humano|atendente|pessoa|reclama/.test(t)) {
    await tools({ iflores, tenant, conv }).find((x) => x.name === 'transferir_para_humano').run({ motivo: 'cliente pediu humano' });
    return 'Claro! Já chamei alguém da nossa equipe, só um instante 🙏';
  }
  const cep = t.match(/\d{5}-?\d{3}/);
  if (cep) {
    const q = await iflores.deliveryQuote({ cep: cep[0] });
    return `${hello}Entregamos sim no CEP ${cep[0]}! 🚚 Taxa de ${brl(q.taxa)}, ${q.prazo}. Janelas: ${q.janelas.join(', ')}. Qual prefere?`;
  }
  if (/pedido|rastre|status/.test(t) && /\d{4,}/.test(t)) {
    const o = await iflores.getOrder(t.match(/\w*\d{4,}/)[0].toUpperCase());
    return `Seu pedido ${o.id} está ${o.status.replace('_', ' ')} 🌸 Previsão: ${o.previsao}. Acompanhe: ${o.rastreio_url}`;
  }
  if (/quero|fechar|comprar|esse|pode ser/.test(t) && conv.status !== 'humano' && !first) {
    return 'Perfeito! 💐 Para finalizar me envia: nome de quem vai receber, endereço com CEP, data da entrega e a mensagem do cartão.' + (cfg.fazer_upsell ? `\n\nQuer incluir um ${cfg.sugestoes_upsell[0]}? Fica lindo junto!` : '');
  }
  const { items } = await iflores.searchProducts({ busca: text, limite: 3 });
  const list = items.map((p) => `• ${p.nome} — ${brl(p.preco)}`).join('\n');
  return `${hello}Separei algumas opções lindas pra você:\n${list}\n\nQual delas mais combina com a ocasião?`;
}

export function conversationStats(tenantId, sinceIso) {
  const convs = all('SELECT * FROM conversations WHERE tenant_id = ? AND updated_at >= ?', tenantId, sinceIso);
  const comPedido = convs.filter((c) => (c.pedidos || []).length);
  const respostas = convs.reduce((s, c) => s + (c.respostas || 0), 0);
  const tempo = convs.reduce((s, c) => s + (c.tempo_resposta_total || 0), 0);
  return {
    conversas: convs.length,
    vendas: comPedido.length,
    valor_vendido: Math.round(convs.reduce((s, c) => s + (c.valor_vendido || 0), 0) * 100) / 100,
    taxa_conversao: convs.length ? Math.round((comPedido.length / convs.length) * 1000) / 10 : 0,
    tempo_medio_resposta_seg: respostas ? Math.round(tempo / respostas) : 0,
    transferidas: convs.filter((c) => c.status === 'humano').length,
  };
}
