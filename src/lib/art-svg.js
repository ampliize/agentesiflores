// Layout das artes em SVG puro (sem dependências), usado no servidor e na demo do navegador.
const SIZES = { feed: [1080, 1080], story: [1080, 1920], anuncio: [1080, 1350] };
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function wrap(text, maxChars) {
  const words = String(text || '').split(/\s+/); const lines = []; let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars) { if (line) lines.push(line); line = w; } else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 5);
}

function flower(cx, cy, r, color, opacity = 1) {
  const petals = Array.from({ length: 6 }, (_, i) => {
    const a = (i * Math.PI) / 3;
    return `<ellipse cx="${cx + Math.cos(a) * r * 0.55}" cy="${cy + Math.sin(a) * r * 0.55}" rx="${r * 0.42}" ry="${r * 0.26}" transform="rotate(${(a * 180) / Math.PI} ${cx + Math.cos(a) * r * 0.55} ${cy + Math.sin(a) * r * 0.55})" fill="${color}"/>`;
  }).join('');
  return `<g opacity="${opacity}">${petals}<circle cx="${cx}" cy="${cy}" r="${r * 0.22}" fill="#ffd54f"/></g>`;
}

/**
 * @param {object} p { formato, titulo, subtitulo, cta, preco, loja, cores:[primaria, secundaria, fundo], layout }
 */
export function renderArtSvg(p) {
  const [W, H] = SIZES[p.formato] || SIZES.feed;
  const [c1 = '#c2185b', c2 = '#1b5e20', bg = '#fff7f2'] = p.cores || [];
  const layout = p.layout || 'classico';
  const titleLines = wrap(p.titulo, p.formato === 'story' ? 16 : 18);
  const subLines = wrap(p.subtitulo, 34);
  const ty = p.formato === 'story' ? 700 : p.formato === 'anuncio' ? 470 : 380;
  const dark = layout === 'destaque';
  const fg = dark ? '#ffffff' : c2;
  const decor = layout === 'minimal'
    ? flower(W - 140, 150, 110, c1, 0.9)
    : [flower(120, 140, 150, c1, 0.85), flower(W - 110, H - 160, 170, dark ? '#ffffff' : c1, 0.35), flower(W - 200, 210, 70, c2, 0.5), flower(170, H - 280, 60, c2, 0.4)].join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${dark ? c1 : bg}"/><stop offset="1" stop-color="${dark ? c2 : '#ffffff'}"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  ${decor}
  <rect x="60" y="60" width="${W - 120}" height="${H - 120}" rx="36" fill="none" stroke="${dark ? '#ffffff55' : c1 + '55'}" stroke-width="4"/>
  ${titleLines.map((l, i) => `<text x="${W / 2}" y="${ty + i * 104}" text-anchor="middle" font-family="Georgia, 'DejaVu Serif', serif" font-size="92" font-weight="700" fill="${fg}">${esc(l)}</text>`).join('')}
  ${subLines.map((l, i) => `<text x="${W / 2}" y="${ty + titleLines.length * 104 + 40 + i * 56}" text-anchor="middle" font-family="'DejaVu Sans', Arial, sans-serif" font-size="42" fill="${dark ? '#ffffffdd' : '#4a4a4a'}">${esc(l)}</text>`).join('')}
  ${p.preco ? `<g><rect x="${W / 2 - 200}" y="${H - (p.formato === 'story' ? 560 : 330)}" width="400" height="110" rx="55" fill="${dark ? '#ffffff' : c1}"/><text x="${W / 2}" y="${H - (p.formato === 'story' ? 560 : 330) + 74}" text-anchor="middle" font-family="'DejaVu Sans', Arial, sans-serif" font-size="56" font-weight="700" fill="${dark ? c1 : '#ffffff'}">${esc(p.preco)}</text></g>` : ''}
  ${p.cta ? `<text x="${W / 2}" y="${H - (p.formato === 'story' ? 380 : 180)}" text-anchor="middle" font-family="'DejaVu Sans', Arial, sans-serif" font-size="40" font-weight="700" letter-spacing="3" fill="${fg}">${esc(p.cta.toUpperCase())}</text>` : ''}
  <text x="${W / 2}" y="${H - 100}" text-anchor="middle" font-family="Georgia, 'DejaVu Serif', serif" font-size="34" font-style="italic" fill="${dark ? '#ffffffcc' : c1}">${esc(p.loja || '')}</text>
</svg>`;
}

