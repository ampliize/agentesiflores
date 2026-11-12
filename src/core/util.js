// Utilitários compartilhados (funcionam no Node e no navegador).
export const TZ = 'America/Sao_Paulo';
export const uid = (p = '') => p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const now = () => new Date().toISOString();
export const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
export const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export function brl(v) {
  const n = round2(v); const neg = n < 0; const [i, d] = Math.abs(n).toFixed(2).split('.');
  return `${neg ? '-' : ''}R$ ${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d}`;
}
export const pct = (v, casas = 1) => `${(Math.round((Number(v) || 0) * 100 * 10 ** casas) / 10 ** casas).toString().replace('.', ',')}%`;

const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtWd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
const WD = { Sun: 'dom', Mon: 'seg', Tue: 'ter', Wed: 'qua', Thu: 'qui', Fri: 'sex', Sat: 'sab' };
export const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

/** Data local da loja 'YYYY-MM-DD'. */
export const localDate = (d = new Date()) => fmtDate.format(d);
/** Hora local da loja 'HH:MM'. */
export const localTime = (d = new Date()) => fmtTime.format(d);
/** Dia da semana local ('seg', 'ter', ...). Aceita Date ou 'YYYY-MM-DD'. */
export const weekday = (d = new Date()) => (typeof d === 'string' ? DIAS[new Date(`${d}T12:00:00Z`).getUTCDay()] : WD[fmtWd.format(d)]);
export function addDays(dateStr, n) { const d = new Date(`${dateStr}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export const diffDays = (a, b) => Math.round((new Date(`${a}T12:00:00Z`) - new Date(`${b}T12:00:00Z`)) / 864e5);
export const fmtDia = (dateStr) => { const [y, m, d] = dateStr.split('-'); return `${d}/${m}`; };

/** Interpreta "dia 7", "7/12", "amanhã", "hoje", "2026-12-07" como data local (próxima ocorrência). */
export function parseDia(texto, hoje = localDate()) {
  const t = norm(texto);
  if (/\bhoje\b/.test(t)) return hoje;
  if (/\bdepois de amanha\b/.test(t)) return addDays(hoje, 2);
  if (/\bamanha\b/.test(t)) return addDays(hoje, 1);
  let m = t.match(/(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0];
  const [hy, hm, hd] = hoje.split('-').map(Number);
  m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    let y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : hy;
    const cand = `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    if (!m[3] && cand < hoje) y += 1;
    return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  m = t.match(/\bdia (\d{1,2})\b/) || t.match(/^(\d{1,2})$/);
  if (m) {
    const d = Number(m[1]); let y = hy; let mo = hm;
    if (d < hd) { mo += 1; if (mo > 12) { mo = 1; y += 1; } }
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

/** Interpreta valores em reais: "R$12", "12,50", "1.200,00". */
export function parseValor(texto) {
  const m = String(texto).match(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/i);
  if (!m) return null;
  let s = m[1];
  if (/\.\d{3}/.test(s)) s = s.replace(/\./g, '');
  return Number(s.replace(',', '.'));
}

export function mergeDeep(base, over) {
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return over === undefined ? base : over;
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(over)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeDeep(base?.[k], v) : v;
  return out;
}

/** Tokeniza preservando singular/plural simples (rosas -> rosa). */
export function stem(w) { return w.length > 3 ? w.replace(/(oes|aes)$/, 'ao').replace(/(ns)$/, 'm').replace(/(es|s)$/, '') : w; }
export const tokens = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 1).map(stem);
/** Verdadeiro se todos os termos da busca aparecem no texto (com stem). */
export function contemTermos(texto, busca) {
  const t = new Set(tokens(texto));
  const b = tokens(busca).filter((w) => !STOP.has(w));
  return b.length > 0 && b.every((w) => t.has(w));
}
export const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'com', 'para', 'pra', 'um', 'uma', 'o', 'a', 'e', 'em', 'no', 'na']);
