// MARI — conteúdo e Instagram. Usa as fotos reais da loja (biblioteca + fotos do iFlores),
// preserva a aparência do produto, evita repetição, confere preço e disponibilidade antes de
// publicar e aproveita as dúvidas que chegam à Flora.
import { db } from '../store.js';
import { getConfig, active, hired, getTenant } from '../team.js';
import { log, working, domain } from '../events.js';
import { createTask } from '../tasks.js';
import { listProducts, getProduct, getSettings, disponibilidade, horarioDoDia } from '../catalog.js';
import { topPerguntas } from '../orders.js';
import { proximasDatas } from '../calendar.js';
import { renderSlideSvg, svgDataUrl } from '../art.js';
import { aiEnabled, structured } from '../llm.js';
import { publishInstagram } from '../integrations/meta.js';
import { brl, uid, now, localDate, addDays, weekday, fmtDia } from '../util.js';

// ---------------- biblioteca de fotos ----------------
export const listPhotos = (tenantId) => db().list('photos', tenantId).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
export function addPhoto(tenantId, { url, legenda = '', produto_id = null, origem = 'lojista', demo = false }) {
  if (!url) throw new Error('Envie a imagem');
  const ph = db().put('photos', { id: uid('foto_'), tenant_id: tenantId, url, legenda, produto_id, origem, demo, usos: 0, ultimo_uso: null });
  log(tenantId, 'mari', `Nova foto na biblioteca${legenda ? `: ${legenda}` : ''}`, { type: 'foto' });
  return ph;
}
export function removePhoto(tenantId, id) { const p = db().get('photos', id); if (p?.tenant_id === tenantId) db().del('photos', id); }

function fotoPara(tenantId, produtoId, cfg, usadas) {
  const fotos = listPhotos(tenantId).filter((f) => f.produto_id === produtoId && !usadas.has(f.id));
  if (!fotos.length) return null;
  const limite = addDays(localDate(), -cfg.repetir_foto_apos_dias);
  const frescas = fotos.filter((f) => !f.ultimo_uso || f.ultimo_uso < limite);
  const escolhida = (frescas.length ? frescas : fotos).sort((a, b) => (a.ultimo_uso || '') < (b.ultimo_uso || '') ? -1 : 1)[0];
  return { foto: escolhida, repetida: !frescas.length };
}
function marcarUso(ids) { for (const id of ids) { const f = db().get('photos', id); if (f) db().put('photos', { ...f, usos: (f.usos || 0) + 1, ultimo_uso: localDate() }); } }

// ---------------- peças ----------------
const STATUS_INICIAL = (cfg) => (cfg.aprovacao === 'automatica' ? 'agendado' : 'aguardando_aprovacao');

function slide(tenantId, cfg, formato, s) {
  return { ...s, imagem: svgDataUrl(renderSlideSvg({ formato, foto: s.foto_url, titulo: s.titulo, subtitulo: s.subtitulo, preco: s.preco, cta: s.cta, selo: s.selo, indice: s.indice, loja: getTenant(tenantId).name, cores: cfg.cores_marca })) };
}

export function criarPeca(tenantId, { formato, tema, produto_ids = [], slides, legenda, hashtags, scheduled_at = null, criado_por = 'mari', status }) {
  const cfg = getConfig(tenantId, 'mari');
  const fmtSlide = formato === 'story_sequencia' ? 'story' : formato === 'anuncio' ? 'anuncio' : 'feed';
  const post = db().put('posts', {
    id: uid('post_'), tenant_id: tenantId, formato, tema, produto_ids, scheduled_at, criado_por,
    slides: slides.map((s, i) => slide(tenantId, cfg, fmtSlide, { ...s, indice: slides.length > 1 ? `${i + 1}/${slides.length}` : '' })),
    legenda, hashtags: hashtags || cfg.hashtags, status: status || STATUS_INICIAL(cfg), checagens: [],
    precos_usados: Object.fromEntries(produto_ids.map((id) => [id, getProduct(id)?.preco])),
  });
  marcarUso(slides.map((s) => s.foto_id).filter(Boolean));
  return post;
}

export const getPost = (id) => db().get('posts', id);
export const listPosts = (tenantId, status) => db().list('posts', tenantId, (p) => !status || p.status === status).sort((a, b) => ((a.scheduled_at || a.created_at) < (b.scheduled_at || b.created_at) ? -1 : 1));
const savePost = (p) => db().put('posts', p);

function horarios(cfg, n, tipo, inicio = localDate()) {
  const hs = tipo === 'story' ? cfg.horarios_stories : cfg.horarios_feed; const out = [];
  for (let d = 1; out.length < n && d < 40; d++) {
    const dia = addDays(inicio, d);
    if (!cfg.dias.includes(weekday(dia))) continue;
    for (const h of hs) { if (out.length < n) out.push(`${dia}T${h}:00-03:00`); }
  }
  return out.map((x) => new Date(x).toISOString());
}

async function textos(tenantId, cfg, briefs) {
  if (!aiEnabled()) return briefs.map((b) => b.padrao);
  const r = await structured({
    system: `Você é a Mari, social media de floricultura. Tom: ${cfg.tom}. Escreva em português do Brasil. Não prometa nada que não esteja nos dados (preço, prazo, composição). ${cfg.instrucoes || ''}`,
    prompt: `Escreva os textos destas peças para o Instagram da loja "${getTenant(tenantId).name}". Para cada uma: titulo (até 5 palavras), subtitulo (até 12 palavras), cta (até 4 palavras) e legenda (gancho na 1ª linha, até 500 caracteres, terminando com chamada para o WhatsApp ou link da loja).\n${JSON.stringify(briefs.map((b) => b.brief))}`,
    schema: { type: 'object', additionalProperties: false, required: ['pecas'], properties: { pecas: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['titulo', 'subtitulo', 'cta', 'legenda'], properties: { titulo: { type: 'string' }, subtitulo: { type: 'string' }, cta: { type: 'string' }, legenda: { type: 'string' } } } } } },
    effort: 'low',
  });
  return briefs.map((b, i) => ({ ...b.padrao, ...(r.pecas[i] || {}) }));
}

/** Planeja a próxima semana conforme a frequência escolhida pelo lojista. */
export async function planejarSemana(tenantId, { motivo = 'agenda semanal' } = {}) {
  if (!active(tenantId, 'mari')) return [];
  const cfg = getConfig(tenantId, 'mari'); const s = getSettings(tenantId);
  return working(tenantId, 'mari', 'Planejando o conteúdo da semana', async () => {
    const disponiveis = listProducts(tenantId).filter((p) => (p.tipo || 'produto') === 'produto' && disponibilidade(p, s).ok);
    const usadas = new Set(); const pecas = []; const semFoto = [];
    // produtos que apareceram menos recentemente vêm primeiro (evita repetir)
    const recentes = new Map(listPosts(tenantId).filter((p) => p.created_at > addDays(localDate(), -14)).flatMap((p) => p.produto_ids).map((id) => [id, true]));
    const fila = [...disponiveis].sort((a, b) => (recentes.has(a.id) ? 1 : 0) - (recentes.has(b.id) ? 1 : 0) || (b.destaque ? 1 : 0) - (a.destaque ? 1 : 0));
    const pegar = () => { while (fila.length) { const p = fila.shift(); const f = fotoPara(tenantId, p.id, cfg, usadas); if (f) { usadas.add(f.foto.id); return { p, ...f }; } semFoto.push(p.nome); } return null; };
    const data = proximasDatas(30).find((d) => d.peso >= 3);
    const duvida = topPerguntas(tenantId, 1)[0];
    const briefs = [];

    const feedT = horarios(cfg, cfg.feed_semana, 'feed');
    for (let i = 0; i < cfg.feed_semana; i++) {
      const x = pegar(); if (!x) break;
      const ehData = i === 0 && data;
      briefs.push({ tipo: 'feed', x, quando: feedT[i], brief: { formato: 'post de feed', produto: x.p.nome, preco: x.p.preco, descricao: x.p.descricao, tema: ehData ? `${data.nome} (${fmtDia(data.data)})` : 'produto em destaque' },
        padrao: { titulo: ehData ? data.nome : x.p.nome, subtitulo: ehData ? `Garanta o presente: ${x.p.nome}` : x.p.descricao.split('.')[0], cta: 'Peça pelo WhatsApp', legenda: `${ehData ? `🌷 ${data.nome} está chegando (${fmtDia(data.data)}).` : `✨ ${x.p.nome}`}\n\n${x.p.descricao}\n\nPor ${brl(x.p.preco)}. Entrega no mesmo dia para pedidos até ${s.corte_mesmo_dia}. Chame no WhatsApp ou peça pela loja! 💌` } });
    }
    for (let i = 0; i < cfg.carrosseis_semana; i++) {
      const xs = [pegar(), pegar(), pegar()].filter(Boolean); if (xs.length < 2) break;
      briefs.push({ tipo: 'carrossel', xs, quando: horarios(cfg, cfg.feed_semana + i + 1, 'feed').pop(), brief: { formato: 'carrossel', tema: data ? `opções de presente para ${data.nome}` : 'opções de presente por faixa de preço', produtos: xs.map((x) => `${x.p.nome} (${brl(x.p.preco)})`) },
        padrao: { titulo: data ? `Ideias para ${data.nome}` : 'Qual combina com você?', subtitulo: 'Arraste para ver as opções', cta: 'Escolha a sua', legenda: `${data ? `Ideias de presente para ${data.nome} 🌷` : 'Três jeitos de surpreender alguém hoje 🌷'}\n\n${xs.map((x, k) => `${k + 1}. ${x.p.nome}: ${brl(x.p.preco)}`).join('\n')}\n\nQual você escolheria? Peça pelo WhatsApp.` } });
    }
    const nStories = Math.min(cfg.stories_dia, 3);
    const storyT = horarios(cfg, 3, 'story');
    for (let d = 0; d < Math.min(3, storyT.length); d++) {
      const dia = storyT[d].slice(0, 10); const h = horarioDoDia(s, dia);
      const x = pegar();
      const quadros = [{ titulo: h ? `Abertos hoje das ${h[0]} às ${h[1]}` : 'Hoje estamos fechados', subtitulo: h ? `Entrega no mesmo dia até ${s.corte_mesmo_dia}` : 'Pedidos para os próximos dias pela loja', cta: 'Chame no WhatsApp', foto_url: x?.foto.url, foto_id: x?.foto.id, info_loja: true }];
      if (x && nStories > 1) quadros.push({ titulo: x.p.nome, subtitulo: x.p.descricao.split('.')[0], preco: brl(x.p.preco), cta: 'Responda este story', foto_url: x.foto.url, produto_id: x.p.id });
      if (duvida && nStories > 2 && d === 0) quadros.push({ titulo: 'Dúvida da semana', subtitulo: `${duvida.exemplos[0] || duvida.tema}`, cta: 'Pergunte pra gente', foto_url: x?.foto.url, selo: duvida.tema });
      briefs.push({ tipo: 'story_sequencia', quadros, x, dia, quando: storyT[d], brief: { formato: 'sequência de stories', dia, horario: h, produto: x?.p.nome }, padrao: { legenda: `Stories de ${fmtDia(dia)}`, titulo: quadros[0].titulo, subtitulo: quadros[0].subtitulo, cta: quadros[0].cta } });
    }

    const tx = await textos(tenantId, cfg, briefs.filter((b) => b.tipo !== 'story_sequencia'));
    let k = 0;
    for (const b of briefs) {
      if (b.tipo === 'feed') {
        const t = tx[k++];
        pecas.push(criarPeca(tenantId, { formato: 'feed', tema: b.brief.tema, produto_ids: [b.x.p.id], scheduled_at: b.quando, legenda: t.legenda, slides: [{ foto_url: b.x.foto.url, foto_id: b.x.foto.id, titulo: t.titulo, subtitulo: t.subtitulo, cta: t.cta, preco: brl(b.x.p.preco), produto_id: b.x.p.id }] }));
      } else if (b.tipo === 'carrossel') {
        const t = tx[k++];
        pecas.push(criarPeca(tenantId, { formato: 'carrossel', tema: b.brief.tema, produto_ids: b.xs.map((x) => x.p.id), scheduled_at: b.quando, legenda: t.legenda,
          slides: [{ foto_url: b.xs[0].foto.url, foto_id: b.xs[0].foto.id, titulo: t.titulo, subtitulo: t.subtitulo, cta: '' }, ...b.xs.map((x) => ({ foto_url: x.foto.url, foto_id: x.foto.id, titulo: x.p.nome, subtitulo: x.p.descricao.split('.')[0], preco: brl(x.p.preco), cta: t.cta, produto_id: x.p.id }))] }));
      } else {
        pecas.push(criarPeca(tenantId, { formato: 'story_sequencia', tema: `stories de ${fmtDia(b.dia)}`, produto_ids: b.x ? [b.x.p.id] : [], scheduled_at: b.quando, legenda: b.padrao.legenda, slides: b.quadros }));
      }
    }
    if (semFoto.length || pecas.some((p) => p.slides.some((sl) => !sl.foto_url && !sl.info_loja))) {
      createTask(tenantId, { responsavel: 'mari', solicitante: 'mari', tipo: 'pedido', titulo: `Enviar fotos novas: ${[...new Set(semFoto)].slice(0, 3).join(', ') || 'produtos em destaque'}`, detalhes: 'Orientação rápida: 3 fotos por produto, com luz natural perto da janela, fundo liso, uma de frente, uma de perto mostrando as flores e uma com a embalagem. Não precisa editar.' });
    }
    log(tenantId, 'mari', `Preparou ${pecas.length} peça(s) (${motivo}): ${pecas.filter((p) => p.formato === 'feed').length} feed, ${pecas.filter((p) => p.formato === 'carrossel').length} carrossel, ${pecas.filter((p) => p.formato === 'story_sequencia').length} sequência(s) de stories${cfg.aprovacao === 'automatica' ? ', já agendadas' : ', aguardando aprovação'}`, { type: 'plano', kind: cfg.aprovacao === 'automatica' ? 'acao' : 'sugestao', level: 'success' });
    return pecas;
  });
}

/** Criativo de anúncio (usado pelo Caio quando a Mari está contratada). */
export function criativoAnuncio(tenantId, produtoId, mensagem) {
  const cfg = getConfig(tenantId, 'mari'); const p = getProduct(produtoId);
  const f = fotoPara(tenantId, produtoId, cfg, new Set());
  return criarPeca(tenantId, { formato: 'anuncio', tema: `anúncio: ${mensagem}`, produto_ids: [produtoId], criado_por: 'mari', status: 'aguardando_aprovacao', legenda: `${mensagem}. ${p.nome} por ${brl(p.preco)}.`, slides: [{ foto_url: f?.foto.url, foto_id: f?.foto.id, titulo: mensagem.split(' ').slice(0, 5).join(' '), subtitulo: p.nome, preco: brl(p.preco), cta: 'Compre agora', produto_id: p.id }] });
}

// ---------------- aprovação ----------------
export function aprovar(tenantId, ids, por = 'dono') {
  const out = [];
  for (const id of ids) {
    const p = getPost(id); if (!p || p.tenant_id !== tenantId) continue;
    if (!['aguardando_aprovacao', 'pausado_indisponivel'].includes(p.status)) continue;
    const st = p.formato === 'anuncio' ? 'aprovado' : 'agendado';
    out.push(savePost({ ...p, status: st, aprovado_por: por, aprovado_em: now(), scheduled_at: p.scheduled_at || new Date(Date.now() + 15 * 60e3).toISOString() }));
  }
  if (out.length) log(tenantId, 'mari', `${out.length > 1 ? `${out.length} peças aprovadas em lote` : `Peça "${out[0].slides[0].titulo}" aprovada`} pelo dono`, { type: 'aprovacao', kind: 'acao', level: 'success' });
  return out;
}

export function ajustar(tenantId, id, pedido) {
  const p = getPost(id); const cfg = getConfig(tenantId, 'mari');
  const slides = p.slides.map((s) => ({ ...s, titulo: /titulo|título/i.test(pedido) && pedido.includes(':') ? pedido.split(':').slice(1).join(':').trim() : s.titulo }));
  const legenda = /legenda/i.test(pedido) && pedido.includes(':') ? pedido.split(':').slice(1).join(':').trim() : p.legenda;
  const fmtSlide = p.formato === 'story_sequencia' ? 'story' : p.formato === 'anuncio' ? 'anuncio' : 'feed';
  const upd = savePost({ ...p, legenda, slides: slides.map((s) => slide(tenantId, cfg, fmtSlide, s)), ajustes: [...(p.ajustes || []), { pedido, em: now() }], status: 'aguardando_aprovacao' });
  log(tenantId, 'mari', `Ajustou a peça "${upd.slides[0].titulo}": ${pedido}`, { type: 'ajuste' });
  return upd;
}

export function descartar(tenantId, id) { const p = getPost(id); if (p?.tenant_id === tenantId) savePost({ ...p, status: 'descartado' }); }

// ---------------- publicação com checagens ----------------
export async function publicarDevidos(tenantId, agora = new Date()) {
  if (!active(tenantId, 'mari')) return 0;
  const s = getSettings(tenantId); const cfg = getConfig(tenantId, 'mari');
  const devidos = listPosts(tenantId, 'agendado').filter((p) => p.scheduled_at && p.scheduled_at <= agora.toISOString());
  for (const p0 of devidos) {
    let p = p0;
    const indis = p.produto_ids.map(getProduct).filter((x) => !disponibilidade(x, s).ok);
    if (indis.length) { savePost({ ...p, status: 'pausado_indisponivel', motivo: `${indis.map((x) => x.nome).join(', ')} indisponível` }); log(tenantId, 'mari', `Não publicou "${p.slides[0].titulo}": ${indis.map((x) => x.nome).join(', ')} está indisponível`, { type: 'checagem', level: 'warning' }); continue; }
    const mudou = p.produto_ids.filter((id) => p.precos_usados?.[id] != null && getProduct(id).preco !== p.precos_usados[id]);
    if (mudou.length) {
      const fmtSlide = p.formato === 'story_sequencia' ? 'story' : 'feed';
      p = savePost({ ...p, slides: p.slides.map((sl) => (sl.produto_id && mudou.includes(sl.produto_id) ? slide(tenantId, cfg, fmtSlide, { ...sl, preco: brl(getProduct(sl.produto_id).preco) }) : sl)), legenda: mudou.reduce((l, id) => l.split(brl(p.precos_usados[id])).join(brl(getProduct(id).preco)), p.legenda), precos_usados: Object.fromEntries(p.produto_ids.map((id) => [id, getProduct(id).preco])) });
      log(tenantId, 'mari', `Atualizou o preço na peça "${p.slides[0].titulo}" antes de publicar`, { type: 'checagem', kind: 'acao' });
    }
    try {
      const base = (typeof process !== 'undefined' && process.env?.PUBLIC_URL) || '';
      const r = await publishInstagram(getTenant(tenantId), { image_url: `${base}/media/posts/${p.id}/1.png`, caption: `${p.legenda}\n\n${(p.hashtags || []).join(' ')}`, format: p.formato });
      savePost({ ...p, status: 'publicado', publicado_em: now(), instagram_id: r.id, demo: !!r.demo });
      log(tenantId, 'mari', `Publicou ${p.formato === 'story_sequencia' ? 'os stories' : p.formato === 'carrossel' ? 'o carrossel' : 'o post'} "${p.slides[0].titulo}"${r.demo ? ' (demonstração: Instagram não conectado)' : ' no Instagram'}`, { type: 'publicacao', kind: 'acao', level: 'success' });
    } catch (e) {
      savePost({ ...p, status: 'erro', erro: e.message });
      log(tenantId, 'mari', `Falha ao publicar "${p.slides[0].titulo}": ${e.message}`, { level: 'error' });
    }
  }
  return devidos.length;
}

// ---------------- reação a mudanças na base compartilhada ----------------
export function registrar() {
  domain.on('produto.indisponivel', ({ tenantId, ids }) => {
    if (!hired(tenantId, 'mari')) return;
    const afetados = listPosts(tenantId).filter((p) => ['agendado', 'aguardando_aprovacao', 'aprovado'].includes(p.status) && p.produto_ids.some((id) => ids.includes(id)));
    for (const p of afetados) savePost({ ...p, status: 'pausado_indisponivel', motivo: 'produto ficou indisponível' });
    if (afetados.length) log(tenantId, 'mari', `Pausou ${afetados.length} publicação(ões) programada(s) com produtos que ficaram indisponíveis`, { type: 'checagem', kind: 'acao', level: 'warning' });
  });
  domain.on('produto.disponivel', ({ tenantId, ids }) => {
    if (!hired(tenantId, 'mari')) return;
    const afetados = listPosts(tenantId, 'pausado_indisponivel').filter((p) => p.produto_ids.every((id) => !ids.includes(id) ? disponibilidade(getProduct(id), getSettings(tenantId)).ok : true) && p.produto_ids.some((id) => ids.includes(id)));
    for (const p of afetados) savePost({ ...p, status: 'aguardando_aprovacao', motivo: null });
    if (afetados.length) log(tenantId, 'mari', `${afetados.length} peça(s) voltaram para aprovação: os produtos estão disponíveis de novo`, { type: 'checagem', kind: 'sugestao' });
  });
}

