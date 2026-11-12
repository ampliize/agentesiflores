// Artes da Mari (e do Caio quando trabalha sozinho). A foto do produto entra inteira, sem corte,
// distorção ou retoque: o texto fica numa faixa separada para não mudar a aparência do que a loja entrega.
const SIZES = { feed: [1080, 1350], story: [1080, 1920], anuncio: [1080, 1080] };
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function wrap(text, max) {
  const out = []; let line = '';
  for (const w of String(text || '').split(/\s+/)) {
    if ((line + ' ' + w).trim().length > max) { if (line) out.push(line); line = w; } else line = (line + ' ' + w).trim();
  }
  if (line) out.push(line);
  return out;
}

/**
 * @param {{formato:'feed'|'story'|'anuncio', foto?:string, titulo:string, subtitulo?:string, preco?:string, cta?:string,
 *          loja:string, cores:string[], selo?:string, indice?:string}} p
 */
export function renderSlideSvg(p) {
  const [W, H] = SIZES[p.formato] || SIZES.feed;
  const [c1 = '#b8325e', c2 = '#24493d', bg = '#fbf6f1'] = p.cores || [];
  const story = p.formato === 'story';
  const band = story ? 620 : p.formato === 'anuncio' ? 330 : 420;
  const photoH = H - band - (story ? 220 : 60);
  const top = story ? 220 : 60;
  let titulo = wrap(p.titulo, story ? 20 : 24);
  if (titulo.length > 2) titulo = [titulo[0], `${titulo.slice(1).join(' ').slice(0, story ? 18 : 22).trim()}…`];
  const sub = wrap(p.subtitulo, 40).slice(0, story ? 3 : titulo.length > 1 ? 1 : 2).map((l, i, a) => (i === a.length - 1 && wrap(p.subtitulo, 40).length > a.length ? `${l.replace(/[,.;:]?$/, '')}…` : l));
  const by = H - band + 70;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${bg}"/>
  ${story ? `<text x="${W / 2}" y="140" text-anchor="middle" font-family="Georgia, 'DejaVu Serif', serif" font-size="46" font-style="italic" fill="${c2}">${esc(p.loja)}</text>` : ''}
  ${p.foto
    ? `<rect x="60" y="${top}" width="${W - 120}" height="${photoH}" rx="28" fill="#ffffff"/><image x="60" y="${top}" width="${W - 120}" height="${photoH}" href="${esc(p.foto)}" xlink:href="${esc(p.foto)}" preserveAspectRatio="xMidYMid meet"/>`
    : `<rect x="60" y="${top}" width="${W - 120}" height="${photoH}" rx="28" fill="${c2}"/><text x="${W / 2}" y="${top + photoH / 2}" text-anchor="middle" font-family="Georgia, serif" font-size="64" fill="${bg}">${esc(p.loja)}</text>`}
  ${p.selo ? `<g><rect x="90" y="${top + 30}" rx="26" width="${Math.max(220, p.selo.length * 22 + 60)}" height="64" fill="${c1}"/><text x="${120}" y="${top + 73}" font-family="'DejaVu Sans', Arial, sans-serif" font-size="32" font-weight="700" fill="#ffffff">${esc(p.selo)}</text></g>` : ''}
  ${p.indice ? `<text x="${W - 90}" y="${top + 70}" text-anchor="end" font-family="'DejaVu Sans', Arial, sans-serif" font-size="30" fill="${c2}">${esc(p.indice)}</text>` : ''}
  ${titulo.map((l, i) => `<text x="80" y="${by + i * 78}" font-family="Georgia, 'DejaVu Serif', serif" font-size="68" font-weight="700" fill="${c2}">${esc(l)}</text>`).join('')}
  ${sub.map((l, i) => `<text x="80" y="${by + titulo.length * 78 + 16 + i * 46}" font-family="'DejaVu Sans', Arial, sans-serif" font-size="36" fill="#4d4d4d">${esc(l)}</text>`).join('')}
  ${p.preco ? `<g><rect x="${W - 380}" y="${H - 170}" rx="44" width="300" height="88" fill="${c1}"/><text x="${W - 230}" y="${H - 112}" text-anchor="middle" font-family="'DejaVu Sans', Arial, sans-serif" font-size="44" font-weight="700" fill="#ffffff">${esc(p.preco)}</text></g>` : ''}
  ${p.cta ? `<text x="80" y="${H - 112}" font-family="'DejaVu Sans', Arial, sans-serif" font-size="34" font-weight="700" letter-spacing="2" fill="${c1}">${esc(p.cta.toUpperCase())}</text>` : ''}
  ${!story ? `<text x="${W - 80}" y="${H - 30}" text-anchor="end" font-family="Georgia, serif" font-size="28" font-style="italic" fill="${c2}">${esc(p.loja)}</text>` : ''}
</svg>`;
}

export const svgDataUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
