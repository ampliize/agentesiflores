// Camada de IA (Claude). Sem ANTHROPIC_API_KEY, `aiEnabled()` retorna false e cada
// agente usa sua lógica de demonstração (regras + templates), mantendo o painel funcional.
import Anthropic from '@anthropic-ai/sdk';
import { db, lojaAtual } from './store.js';

let client = null;
export const MODEL = () => process.env.AI_MODEL || 'claude-opus-5-5';
export const aiEnabled = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const getClient = () => (client ??= new Anthropic());

// Fallback automático do servidor caso o modelo recuse uma requisição.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

// ---------- uso por loja (custo e limite diário, sem afetar as outras lojas) ----------
const LIMITE = () => Number(process.env.IA_LIMITE_DIARIO_POR_LOJA || 400);
function idUso(t) { return `${t}:${new Date().toISOString().slice(0, 10)}`; }
function verificarLimite() {
  const t = lojaAtual(); if (!t) return;
  const u = db().get('uso_ia', idUso(t));
  if (u && u.chamadas >= LIMITE()) throw Object.assign(new Error('Limite diário de IA desta loja atingido'), { status: 429 });
}
function registrarUso(res) {
  const t = lojaAtual(); if (!t) return;
  const id = idUso(t); const u = db().get('uso_ia', id) || { id, tenant_id: t, data: id.slice(-10), chamadas: 0, tokens_entrada: 0, tokens_saida: 0 };
  db().put('uso_ia', { ...u, chamadas: u.chamadas + 1, tokens_entrada: u.tokens_entrada + (res.usage?.input_tokens || 0), tokens_saida: u.tokens_saida + (res.usage?.output_tokens || 0) });
}

const textOf = (msg) => msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

/**
 * Loop agêntico com ferramentas (Flora, Alex e Sol).
 * tools: [{ name, description, input_schema, run: async (input) => any }]
 * Retorna { text, messages } — `messages` é o histórico completo, para persistir.
 */
export async function runToolLoop({ system, messages, tools, effort = 'low', maxTurns = 8, maxTokens = 4096 }) {
  const defs = tools.map(({ run, ...t }) => ({ ...t, strict: true }));
  const handlers = Object.fromEntries(tools.map((t) => [t.name, t.run]));
  const history = [...messages];
  for (let turn = 0; turn < maxTurns; turn++) {
    verificarLimite();
    const res = await getClient().beta.messages.create({
      model: MODEL(), max_tokens: maxTokens, system, tools: defs, messages: history,
      output_config: { effort }, ...FALLBACK,
    });
    registrarUso(res);
    if (res.stop_reason === 'refusal') return { text: '', refused: true, messages: history };
    history.push({ role: 'assistant', content: res.content });
    if (res.stop_reason === 'pause_turn') continue;
    if (res.stop_reason !== 'tool_use') return { text: textOf(res), messages: history };

    const calls = res.content.filter((b) => b.type === 'tool_use');
    const results = await Promise.all(calls.map(async (call) => {
      try {
        const out = await handlers[call.name](call.input);
        return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out ?? null) };
      } catch (err) {
        return { type: 'tool_result', tool_use_id: call.id, content: `Erro: ${err.message}`, is_error: true };
      }
    }));
    history.push({ role: 'user', content: results });
  }
  return { text: '', messages: history, exhausted: true };
}

/** Uma chamada com saída JSON garantida por schema (planejamento, análises, relatórios). */
export async function structured({ system, prompt, schema, effort = 'medium', maxTokens = 16000 }) {
  verificarLimite();
  const res = await getClient().beta.messages.create({
    model: MODEL(), max_tokens: maxTokens, system,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort, format: { type: 'json_schema', schema } },
    ...FALLBACK,
  });
  registrarUso(res);
  if (res.stop_reason === 'refusal') throw new Error('A IA recusou a solicitação');
  if (res.stop_reason === 'max_tokens') throw new Error('Resposta da IA truncada (max_tokens)');
  return JSON.parse(textOf(res));
}
