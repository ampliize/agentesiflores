// Ilustrações usadas como "fotos" na loja de demonstração (a loja real usa as fotos dela).
const ESTILOS = {
  rosas_vermelhas: { flores: ['#c1121f', '#a4161a', '#d62839'], tipo: 'rosa', embrulho: '#d9c3a5', laco: '#7f1d1d' },
  rosas_brancas: { flores: ['#f8f4ec', '#efe7da', '#ffffff'], tipo: 'rosa', embrulho: '#8fa89a', laco: '#24493d' },
  girassois: { flores: ['#f2b705', '#f5c518', '#e8a202'], tipo: 'girassol', embrulho: '#c8b28a', laco: '#5a3e1b' },
  campestre: { flores: ['#e76f9a', '#9b5de5', '#f6bd60', '#ffffff'], tipo: 'margarida', embrulho: '#e9dcc9', laco: '#8a5a44' },
  orquidea: { flores: ['#f7f0fa', '#efe1f5'], tipo: 'orquidea', embrulho: '#e8e2da', laco: '#6d597a' },
  cesta: { flores: ['#e63946', '#f4a261', '#ffb4a2'], tipo: 'cesta', embrulho: '#b08968', laco: '#7f5539' },
  box: { flores: ['#d62839', '#c1121f'], tipo: 'box', embrulho: '#1d1d1d', laco: '#c9a227' },
  chocolate: { tipo: 'chocolate' },
  cartao: { tipo: 'cartao' },
  pelucia: { tipo: 'pelucia' },
};

function flor(x, y, r, cor, tipo) {
  if (tipo === 'girassol') return `<g>${Array.from({ length: 14 }, (_, i) => `<ellipse cx="${x}" cy="${y - r * 0.75}" rx="${r * 0.2}" ry="${r * 0.45}" fill="${cor}" transform="rotate(${i * 25.7} ${x} ${y})"/>`).join('')}<circle cx="${x}" cy="${y}" r="${r * 0.42}" fill="#5a3e1b"/></g>`;
  if (tipo === 'margarida') return `<g>${Array.from({ length: 10 }, (_, i) => `<ellipse cx="${x}" cy="${y - r * 0.6}" rx="${r * 0.18}" ry="${r * 0.4}" fill="${cor}" transform="rotate(${i * 36} ${x} ${y})"/>`).join('')}<circle cx="${x}" cy="${y}" r="${r * 0.22}" fill="#f2b705"/></g>`;
  if (tipo === 'orquidea') return `<g>${[0, 72, 144, 216, 288].map((a) => `<ellipse cx="${x}" cy="${y - r * 0.55}" rx="${r * 0.35}" ry="${r * 0.55}" fill="${cor}" stroke="#d8c3e3" stroke-width="2" transform="rotate(${a} ${x} ${y})"/>`).join('')}<circle cx="${x}" cy="${y}" r="${r * 0.18}" fill="#c9184a"/></g>`;
  return `<g><circle cx="${x}" cy="${y}" r="${r}" fill="${cor}"/><path d="M${x - r * 0.6} ${y} q${r * 0.6} ${-r * 0.9} ${r * 1.2} 0 q${-r * 0.6} ${r * 0.5} ${-r * 1.2} 0z" fill="#00000022"/><circle cx="${x}" cy="${y}" r="${r * 0.45}" fill="none" stroke="#00000033" stroke-width="${r * 0.1}"/></g>`;
}

export function demoPhotoSvg(estilo, seed = 1) {
  const e = ESTILOS[estilo] || ESTILOS.campestre;
  const rnd = (i) => { const x = Math.sin(seed * 97 + i * 13.7) * 10000; return x - Math.floor(x); };
  const bg = `<rect width="800" height="800" fill="#f3ede6"/><rect y="560" width="800" height="240" fill="#e6ddd2"/>`;
  if (e.tipo === 'chocolate') return wrapSvg(`${bg}<rect x="220" y="330" width="360" height="260" rx="18" fill="#5b3a29"/><rect x="220" y="330" width="360" height="70" rx="18" fill="#c9a227"/>${Array.from({ length: 6 }, (_, i) => `<circle cx="${280 + (i % 3) * 120}" cy="${450 + Math.floor(i / 3) * 80}" r="34" fill="#3d2418"/>`).join('')}`);
  if (e.tipo === 'cartao') return wrapSvg(`${bg}<rect x="230" y="260" width="340" height="400" rx="10" fill="#fffaf2" stroke="#d6c7b2" stroke-width="4" transform="rotate(-6 400 460)"/><text x="400" y="460" text-anchor="middle" font-family="Georgia" font-size="44" font-style="italic" fill="#b8325e" transform="rotate(-6 400 460)">Com amor</text>`);
  if (e.tipo === 'pelucia') return wrapSvg(`${bg}<circle cx="400" cy="470" r="150" fill="#b08968"/><circle cx="400" cy="300" r="110" fill="#b08968"/><circle cx="315" cy="215" r="45" fill="#b08968"/><circle cx="485" cy="215" r="45" fill="#b08968"/><circle cx="365" cy="290" r="12" fill="#222"/><circle cx="435" cy="290" r="12" fill="#222"/><ellipse cx="400" cy="335" rx="34" ry="24" fill="#e6ccb2"/>`);
  const n = e.tipo === 'orquidea' ? 7 : e.tipo === 'box' ? 9 : 12;
  const flores = Array.from({ length: n }, (_, i) => {
    const ang = (i / n) * Math.PI * 2 + rnd(i); const rad = 40 + rnd(i + 5) * 120;
    return flor(400 + Math.cos(ang) * rad, (e.tipo === 'box' ? 380 : 300) + Math.sin(ang) * rad * 0.7, e.tipo === 'orquidea' ? 48 : 52, e.flores[i % e.flores.length], e.tipo);
  }).join('');
  const folhas = Array.from({ length: 8 }, (_, i) => `<ellipse cx="${400 + (rnd(i + 20) - 0.5) * 380}" cy="${330 + (rnd(i + 30) - 0.5) * 200}" rx="22" ry="70" fill="#4f7c5a" transform="rotate(${rnd(i) * 180} ${400} ${330})"/>`).join('');
  let base;
  if (e.tipo === 'box') base = `<rect x="200" y="380" width="400" height="260" rx="12" fill="${e.embrulho}"/><rect x="190" y="370" width="420" height="40" rx="8" fill="#2b2b2b"/><rect x="385" y="380" width="30" height="260" fill="${e.laco}"/>`;
  else if (e.tipo === 'cesta') base = `<path d="M210 420 h380 l-40 230 h-300z" fill="${e.embrulho}"/><path d="M230 470 h340 M240 530 h320 M250 590 h300" stroke="#7f5539" stroke-width="10"/>`;
  else if (e.tipo === 'orquidea') base = `<path d="M330 520 h140 l-20 150 h-100z" fill="${e.embrulho}"/><path d="M400 520 C 390 400 420 300 400 220" stroke="#4f7c5a" stroke-width="10" fill="none"/>`;
  else base = `<path d="M260 360 L400 720 L540 360 Z" fill="${e.embrulho}"/><path d="M360 600 l40 -30 l40 30 l-40 20z" fill="${e.laco}"/>`;
  return wrapSvg(`${bg}${folhas}${e.tipo === 'box' || e.tipo === 'cesta' ? base + flores : flores + base}`);
}

const wrapSvg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">${inner}</svg>`;
export const demoPhotoUrl = (estilo, seed) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(demoPhotoSvg(estilo, seed))}`;
