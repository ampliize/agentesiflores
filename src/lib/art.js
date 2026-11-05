// Gerador de artes (feed 1080x1080, story 1080x1920, anúncio 1080x1350) em SVG -> PNG.
// Usa as cores da marca da loja e layouts prontos. Funciona sem nenhum serviço externo;
// pode ser trocado/complementado por um gerador de imagens por IA no futuro.
import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { renderArtSvg } from './art-svg.js';

export { renderArtSvg };

export const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || 'data/media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

/** Renderiza e salva PNG + SVG. Retorna o caminho relativo servido em /media. */
export function renderArt(id, params) {
  const svg = renderArtSvg(params);
  fs.writeFileSync(path.join(MEDIA_DIR, `${id}.svg`), svg);
  try {
    const png = new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng();
    fs.writeFileSync(path.join(MEDIA_DIR, `${id}.png`), png);
    return `/media/${id}.png`;
  } catch {
    return `/media/${id}.svg`;
  }
}
