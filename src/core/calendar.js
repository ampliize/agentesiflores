// Datas comemorativas mais fortes para floriculturas no Brasil.
import { addDays, diffDays, localDate } from './util.js';

function nthSunday(year, month, n) {
  const d = new Date(Date.UTC(year, month, 1, 12));
  const off = (7 - d.getUTCDay()) % 7;
  return new Date(Date.UTC(year, month, 1 + off + (n - 1) * 7, 12)).toISOString().slice(0, 10);
}

export function datasDoAno(y) {
  return [
    { nome: 'Dia da Mulher', data: `${y}-03-08`, peso: 3 },
    { nome: 'Dia das Mães', data: nthSunday(y, 4, 2), peso: 5 },
    { nome: 'Dia dos Namorados', data: `${y}-06-12`, peso: 5 },
    { nome: 'Dia dos Pais', data: nthSunday(y, 7, 2), peso: 2 },
    { nome: 'Dia dos Professores', data: `${y}-10-15`, peso: 2 },
    { nome: 'Finados', data: `${y}-11-02`, peso: 4 },
    { nome: 'Natal', data: `${y}-12-25`, peso: 4 },
  ];
}

export function proximasDatas(dias = 45, hoje = localDate()) {
  const y = Number(hoje.slice(0, 4));
  return [...datasDoAno(y), ...datasDoAno(y + 1)]
    .filter((d) => d.data >= hoje && d.data <= addDays(hoje, dias))
    .map((d) => ({ ...d, faltam: diffDays(d.data, hoje) }));
}
