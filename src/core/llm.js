// Camada de IA. Provedor escolhido por LLM_PROVIDER:
//   • 'anthropic' (padrão do produto): Claude, com ANTHROPIC_API_KEY e AI_MODEL
//   • 'openai' (para testes dos agentes): OPENAI_API_KEY e OPENAI_MODEL (obrigatório, sem padrão)
// Sem chave do provedor escolhido, aiEnabled() é false e os agentes usam a lógica de demonstração.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { db, lojaAtual } from './store.js';

export const PROVEDOR = () => (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
export const MODEL = () => (PROVEDOR() === 'openai' ? process.env.OPENAI_MODEL || null : process.env.AI_MODEL || 'claude-opus-5-5');
export const aiEnabled = () => (PROVEDOR() === 'openai'
  ? !!process.env.OPENAI_API_KEY
  : !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN));

let anthropic = null; let openai = null;
const getAnthropic = () => (anthropic ??= new Anthropic());
const getOpenAI = () => (openai ??= new OpenAI({ baseURL: process.env.OPENAI_BASE_URL || undefined }));

// Fallback automático do servidor caso o modelo recuse uma requisição (Claude).
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

// ---------- limite de uso por loja (custo e abuso, sem afetar as outras lojas) ----------
const LIMITE = () => Number(process.env.IA_LIMITE_DIARIO_POR_LOJA || 400);
function idUso(t) { return `${t}:${new Date().toISOString().slice(0, 10)}`; }
async function verificarLimite() {
  const t = lojaAtual(); if (!t) return;
  const u = await db().get('uso_ia', idUso(t));
  if (u && u.chamadas >= LIMITE()) throw Object.assign(new Error('Limite diário de IA desta loja atingido'), { status: 429 });
}
async function registrarUso(entrada, saida) {
  const t = lojaAtual(); if (!t) return;
  const id = idUso(t); const u = (await db().get('uso_ia', id)) || { id, tenant_id: t, data: id.slice(-10), chamadas: 0, tokens_entrada: 0, tokens_saida: 0 };
  await db().put('uso_ia', { ...u, chamadas: u.chamadas + 1, tokens_entrada: u.tokens_entrada + (entrada || 0), tokens_saida: u.tokens_saida + (saida || 0), provedor: PROVEDOR(), modelo: MODEL() });
}

// ---------- ferramentas: formato de cada provedor ----------
// Os dois usam schema estrito: todas as propriedades obrigatórias e additionalProperties false.
const anthropicTool = ({ run, ...t }) => ({ ...t, strict: true });
const openaiTool = ({ name, description, input_schema }) => ({ type: 'function', function: { name, description, parameters: input_schema, strict: true } });

async function executarFerramenta(tools, nome, entrada, trace) {
  const tool = tools.find((x) => x.name === nome);
  let resultado; let erro = false;
  try { resultado = tool ? await tool.run(entrada) : { erro: `ferramenta desconhecida: ${nome}` }; }
  catch (e) { resultado = `Erro: ${e.message}`; erro = true; }
  trace?.push({ nome, entrada, erro });
  return { content: typeof resultado === 'string' ? resultado : JSON.stringify(resultado ?? null), erro };
}

/**
 * Loop com ferramentas (Flora, Alex e Sol). Retorna { text, messages, refused?, exhausted? }.
 * `trace` (opcional) recebe cada chamada de ferramenta: útil para testes e auditoria.
 */
export async function runToolLoop({ system, messages, tools, effort = 'low', maxTurns = 8, maxTokens = 4096, trace }) {
  return PROVEDOR() === 'openai'
    ? openaiToolLoop({ system, messages, tools, maxTurns, maxTokens, trace })
    : anthropicToolLoop({ system, messages, tools, effort, maxTurns, maxTokens, trace });
}

async function anthropicToolLoop({ system, messages, tools, effort, maxTurns, maxTokens, trace }) {
  const defs = tools.map(anthropicTool);
  const history = [...messages];
  for (let turn = 0; turn < maxTurns; turn++) {
    await verificarLimite();
    const res = await getAnthropic().beta.messages.create({ model: MODEL(), max_tokens: maxTokens, system, tools: defs, messages: history, output_config: { effort }, ...FALLBACK });
    await registrarUso(res.usage?.input_tokens, res.usage?.output_tokens);
    if (res.stop_reason === 'refusal') return { text: '', refused: true, messages: history };
    history.push({ role: 'assistant', content: res.content });
    if (res.stop_reason === 'pause_turn') continue;
    if (res.stop_reason !== 'tool_use') return { text: textoDeBlocos(res.content), messages: history };
    const results = [];
    for (const call of res.content.filter((b) => b.type === 'tool_use')) {
      const r = await executarFerramenta(tools, call.name, call.input, trace);
      results.push({ type: 'tool_result', tool_use_id: call.id, content: r.content, ...(r.erro ? { is_error: true } : {}) });
    }
    history.push({ role: 'user', content: results });
  }
  return { text: '', messages: history, exhausted: true };
}

async function openaiToolLoop({ system, messages, tools, maxTurns, maxTokens, trace }) {
  const defs = tools.map(openaiTool);
  const hist = [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : textoDeBlocos(m.content) }))];
  for (let turn = 0; turn < maxTurns; turn++) {
    await verificarLimite();
    const res = await getOpenAI().chat.completions.create({ model: MODEL(), messages: hist, tools: defs, max_completion_tokens: maxTokens });
    await registrarUso(res.usage?.prompt_tokens, res.usage?.completion_tokens);
    const msg = res.choices[0]?.message;
    if (!msg) return { text: '', messages: hist, exhausted: true };
    hist.push(msg);
    if (!msg.tool_calls?.length) return { text: msg.content || '', messages: hist };
    for (const call of msg.tool_calls) {
      let entrada = {};
      try { entrada = JSON.parse(call.function.arguments || '{}'); } catch { entrada = null; }
      const r = entrada === null
        ? { content: 'Erro: argumentos inválidos (JSON)', erro: true }
        : await executarFerramenta(tools, call.function.name, entrada, trace);
      hist.push({ role: 'tool', tool_call_id: call.id, content: r.content });
    }
  }
  return { text: '', messages: hist, exhausted: true };
}

/** Uma chamada com saída JSON garantida por schema (planejamento, análises, relatórios). */
export async function structured({ system, prompt, schema, effort = 'medium', maxTokens = 16000 }) {
  await verificarLimite();
  if (PROVEDOR() === 'openai') {
    const res = await getOpenAI().chat.completions.create({
      model: MODEL(), max_completion_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      response_format: { type: 'json_schema', json_schema: { name: 'resposta', strict: true, schema } },
    });
    await registrarUso(res.usage?.prompt_tokens, res.usage?.completion_tokens);
    const c = res.choices[0]?.message;
    if (c?.refusal) throw new Error('A IA recusou a solicitação');
    return JSON.parse(c?.content || 'null');
  }
  const res = await getAnthropic().beta.messages.create({
    model: MODEL(), max_tokens: maxTokens, system,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort, format: { type: 'json_schema', schema } },
    ...FALLBACK,
  });
  await registrarUso(res.usage?.input_tokens, res.usage?.output_tokens);
  if (res.stop_reason === 'refusal') throw new Error('A IA recusou a solicitação');
  if (res.stop_reason === 'max_tokens') throw new Error('Resposta da IA truncada (max_tokens)');
  return JSON.parse(textoDeBlocos(res.content));
}

function textoDeBlocos(content) {
  return (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}
