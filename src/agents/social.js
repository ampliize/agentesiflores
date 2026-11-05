// Agente SOCIAL MEDIA — planeja o conteúdo da semana, cria artes (feed/stories/anúncios),
// escreve legendas e publica automaticamente (ou envia para aprovação do dono/Gerente).
import { get, all, run, uid, now } from '../db.js';
import { getAgentConfig, getTenant } from '../lib/tenants.js';
import { logActivity, setAgentStatus } from '../lib/events.js';
import { aiEnabled, structured } from '../lib/llm.js';
import { IFloresClient } from '../integrations/iflores.js';
import { publishInstagram } from '../integrations/meta.js';
import { renderArt } from '../lib/art.js';
import { upcomingDates } from '../lib/calendar.js';

const DIA_IDX = { dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6 };
const brl = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['posts'],
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['formato', 'tema', 'produto_id', 'titulo_arte', 'subtitulo_arte', 'cta', 'mostrar_preco', 'legenda', 'hashtags', 'layout'],
        properties: {
          formato: { type: 'string', enum: ['feed', 'story', 'anuncio'] },
          tema: { type: 'string' },
          produto_id: { type: ['string', 'null'] },
          titulo_arte: { type: 'string', description: 'Texto principal da arte, máx. 5 palavras' },
          subtitulo_arte: { type: 'string', description: 'Linha de apoio, máx. 12 palavras' },
          cta: { type: 'string', description: 'Chamada curta, ex.: "Peça pelo WhatsApp"' },
          mostrar_preco: { type: 'boolean' },
          legenda: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } },
          layout: { type: 'string', enum: ['classico', 'destaque', 'minimal'] },
        },
      },
    },
  },
};

/** Calcula os horários das publicações da próxima semana conforme a config. */
function slots(cfg, count, start = new Date()) {
  const out = []; const d = new Date(start); d.setDate(d.getDate() + 1);
  const horarios = cfg.horarios?.length ? cfg.horarios : ['10:00'];
  const dias = (cfg.dias || []).map((x) => DIA_IDX[x]);
  for (let guard = 0; out.length < count && guard < 60; guard++, d.setDate(d.getDate() + 1)) {
    if (dias.length && !dias.includes(d.getDay())) continue;
    for (const h of horarios) {
      if (out.length >= count) break;
      const [hh, mm] = h.split(':').map(Number);
      const s = new Date(d); s.setHours(hh, mm, 0, 0); out.push(s.toISOString());
    }
  }
  return out;
}

export async function planWeek(tenantId, { reason = 'agenda semanal', extra = '' } = {}) {
  const tenant = getTenant(tenantId);
  const cfg = getAgentConfig(tenantId, 'social');
  if (!cfg.enabled) return [];
  setAgentStatus(tenantId, 'social', 'trabalhando', 'Planejando conteúdo da semana');
  try {
    const products = await new IFloresClient(tenant).listProducts();
    const datas = upcomingDates(30);
    const nFeed = cfg.posts_feed_semana; const nStory = Math.min(cfg.stories_dia * 7, 14); const nAds = cfg.criativos_anuncio_semana;
    let plan;
    if (aiEnabled()) {
      const r = await structured({
        system: `Você é ${cfg.nome_exibicao}, social media especialista em floriculturas. Cria conteúdo que vende, com estética delicada e copy persuasiva em português do Brasil.`,
        prompt: `Planeje o conteúdo da próxima semana da floricultura "${tenant.name}".
Quantidades: ${nFeed} posts de feed, ${nStory} stories e ${nAds} criativos de anúncio.
Tom: ${cfg.tom}. Temas preferidos: ${cfg.temas.join(', ')}. Hashtags fixas: ${cfg.hashtags_fixas.join(' ')}.
Datas comemorativas próximas: ${datas.map((d) => `${d.nome} (${d.data})`).join(', ') || 'nenhuma'}.
Catálogo (use produto_id real quando o post for de produto):
${products.map((p) => `- ${p.id}: ${p.nome} (${brl(p.preco)}) [${(p.tags || []).join(', ')}]`).join('\n')}
${cfg.instrucoes ? `Instruções do dono: ${cfg.instrucoes}` : ''}
${extra ? `Pedido específico: ${extra}` : ''}
Legendas com gancho na 1ª linha, até 600 caracteres, terminando com CTA para o WhatsApp. Stories com legenda curta.`,
        schema: PLAN_SCHEMA,
        effort: 'medium',
      });
      plan = Array.isArray(r.posts) ? r.posts : [];
    } else {
      plan = demoPlan(products, datas, cfg, nFeed, nStory, nAds);
    }
    const times = { feed: slots(cfg, plan.filter((p) => p.formato === 'feed').length), story: slots({ ...cfg, horarios: ['09:00', '12:30', '17:00'] }, plan.filter((p) => p.formato === 'story').length), anuncio: [] };
    const created = plan.map((p) => {
      const product = products.find((x) => x.id === p.produto_id);
      const scheduled = p.formato === 'anuncio' ? null : times[p.formato].shift() || null;
      return createPost(tenant, cfg, { ...p, produto: product ? { id: product.id, nome: product.nome, preco: product.preco } : null, scheduled_at: scheduled });
    });
    logActivity(tenantId, 'social', 'plano_criado', `Criou ${created.length} peças (${reason}): ${nFeed} feed, ${nStory} stories, ${nAds} anúncios`, { posts: created.map((p) => p.id) }, 'success');
    return created;
  } finally {
    setAgentStatus(tenantId, 'social', 'online', '');
  }
}

export function createPost(tenant, cfg, p) {
  const id = uid('post_');
  const image = renderArt(id, {
    formato: p.formato, titulo: p.titulo_arte, subtitulo: p.subtitulo_arte, cta: p.cta,
    preco: p.mostrar_preco && p.produto ? brl(p.produto.preco) : '', loja: tenant.name, cores: cfg.cores_marca, layout: p.layout,
  });
  const status = initialStatus(tenant.id, cfg);
  const data = { ...p, image_url: image, revisoes: [] };
  run('INSERT INTO posts (id, tenant_id, format, status, scheduled_at, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    id, tenant.id, p.formato, status, p.scheduled_at, JSON.stringify(data), now(), now());
  return getPost(id);
}

/** Com revisão do Gerente ligada, a peça passa primeiro pelo Gerente. */
export function initialStatus(tenantId, cfg) {
  const ger = getAgentConfig(tenantId, 'gerente');
  if (ger.enabled && ger.revisar_posts_antes_de_publicar) return 'revisao_gerente';
  return cfg.publicacao_automatica ? 'agendado' : 'aguardando_aprovacao';
}

export const getPost = (id) => get('SELECT * FROM posts WHERE id = ?', id);
export const listPosts = (tenantId, status) => status
  ? all('SELECT * FROM posts WHERE tenant_id = ? AND status = ? ORDER BY COALESCE(scheduled_at, created_at) ASC', tenantId, status)
  : all('SELECT * FROM posts WHERE tenant_id = ? ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT 200', tenantId);

export function updatePost(id, patch, status) {
  const p = getPost(id);
  const { id: _i, tenant_id, format, status: st, scheduled_at, created_at, updated_at, ...data } = p;
  run('UPDATE posts SET status = ?, scheduled_at = ?, data = ?, updated_at = ? WHERE id = ?',
    status || st, patch.scheduled_at !== undefined ? patch.scheduled_at : scheduled_at, JSON.stringify({ ...data, ...patch }), now(), id);
  return getPost(id);
}

/** Refaz a arte/legenda com base no feedback (dono ou Gerente). */
export async function revisePost(tenantId, postId, feedback, by = 'gerente') {
  const tenant = getTenant(tenantId); const cfg = getAgentConfig(tenantId, 'social');
  const post = getPost(postId);
  let changes = {};
  if (aiEnabled()) {
    changes = await structured({
      system: `Você é ${cfg.nome_exibicao}, social media de floricultura. Revise a peça aplicando o feedback.`,
      prompt: `Peça atual: ${JSON.stringify({ titulo_arte: post.titulo_arte, subtitulo_arte: post.subtitulo_arte, cta: post.cta, legenda: post.legenda, hashtags: post.hashtags, layout: post.layout })}\nFeedback (${by}): ${feedback}`,
      schema: { type: 'object', additionalProperties: false, required: ['titulo_arte', 'subtitulo_arte', 'cta', 'legenda', 'hashtags', 'layout'], properties: { titulo_arte: { type: 'string' }, subtitulo_arte: { type: 'string' }, cta: { type: 'string' }, legenda: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' } }, layout: { type: 'string', enum: ['classico', 'destaque', 'minimal'] } } },
      effort: 'low',
    });
  } else {
    changes = { layout: post.layout === 'destaque' ? 'classico' : 'destaque', legenda: post.legenda };
  }
  const image = renderArt(postId + '_r' + ((post.revisoes || []).length + 1), {
    formato: post.formato, titulo: changes.titulo_arte || post.titulo_arte, subtitulo: changes.subtitulo_arte || post.subtitulo_arte, cta: changes.cta || post.cta,
    preco: post.mostrar_preco && post.produto ? brl(post.produto.preco) : '', loja: tenant.name, cores: cfg.cores_marca, layout: changes.layout || post.layout,
  });
  const updated = updatePost(postId, { ...changes, image_url: image, revisoes: [...(post.revisoes || []), { por: by, feedback, em: now() }] }, cfg.publicacao_automatica ? 'agendado' : 'aguardando_aprovacao');
  logActivity(tenantId, 'social', 'post_revisado', `Revisou a peça "${updated.titulo_arte}" após feedback do ${by}`, { post_id: postId, feedback });
  return updated;
}

/** Publica as peças agendadas cujo horário chegou. */
export async function publishDue(tenantId) {
  const tenant = getTenant(tenantId);
  const due = all("SELECT * FROM posts WHERE tenant_id = ? AND status = 'agendado' AND scheduled_at IS NOT NULL AND scheduled_at <= ?", tenantId, now());
  for (const post of due) {
    try {
      const base = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
      const res = await publishInstagram(tenant, { image_url: base + post.image_url, caption: `${post.legenda}\n\n${(post.hashtags || []).join(' ')}`, format: post.formato });
      updatePost(post.id, { publicado_em: now(), instagram_media_id: res.id, demo: !!res.demo }, 'publicado');
      logActivity(tenantId, 'social', 'post_publicado', `Publicou ${post.formato} "${post.titulo_arte}"${res.demo ? ' (modo demonstração)' : ' no Instagram'}`, { post_id: post.id }, 'success');
    } catch (err) {
      updatePost(post.id, { erro: err.message }, 'erro');
      logActivity(tenantId, 'social', 'erro', `Falha ao publicar "${post.titulo_arte}": ${err.message}`, { post_id: post.id }, 'error');
    }
  }
  return due.length;
}

function demoPlan(products, datas, cfg, nFeed, nStory, nAds) {
  const tag = cfg.hashtags_fixas;
  const data = datas[0];
  const pick = (i) => products[i % products.length];
  const feed = Array.from({ length: nFeed }, (_, i) => {
    const p = pick(i); const isDate = data && i === 0;
    return {
      formato: 'feed', tema: isDate ? data.nome : cfg.temas[i % cfg.temas.length], produto_id: p.id,
      titulo_arte: isDate ? data.nome : p.nome.split(' ').slice(0, 4).join(' '),
      subtitulo_arte: isDate ? `Garanta já o presente perfeito: ${p.nome}` : p.descricao.split('.')[0],
      cta: 'Peça pelo WhatsApp', mostrar_preco: i % 2 === 0,
      legenda: `${isDate ? `🌷 ${data.nome} está chegando!` : `✨ ${p.nome}`}\n\n${p.descricao}\n\nEntrega no mesmo dia para pedidos até 15h. Chame no WhatsApp e garanta o seu! 💌`,
      hashtags: [...tag, '#' + p.categoria], layout: ['classico', 'destaque', 'minimal'][i % 3],
    };
  });
  const stories = Array.from({ length: nStory }, (_, i) => {
    const p = pick(i + 2);
    return { formato: 'story', tema: 'produto do dia', produto_id: p.id, titulo_arte: i % 2 ? 'Peça hoje, receba hoje' : p.nome.replace(/\s*&.*$/, ''), subtitulo_arte: 'Toque para chamar no WhatsApp', cta: 'Arrasta pra cima', mostrar_preco: i % 2 === 0, legenda: p.nome, hashtags: tag, layout: i % 2 ? 'destaque' : 'classico' };
  });
  const ads = Array.from({ length: nAds }, (_, i) => {
    const p = pick(i);
    return { formato: 'anuncio', tema: 'conversão', produto_id: p.id, titulo_arte: i ? 'Surpreenda hoje' : 'Flores que emocionam', subtitulo_arte: `${p.nome} com entrega no mesmo dia`, cta: 'Compre agora', mostrar_preco: true, legenda: `${p.nome} por ${brl(p.preco)}. Entrega hoje!`, hashtags: [], layout: 'destaque' };
  });
  return [...feed, ...stories, ...ads];
}
