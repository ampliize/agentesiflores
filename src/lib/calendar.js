// Datas comemorativas mais fortes para floriculturas no Brasil.
function nthWeekday(year, month, weekday, n) {
  const d = new Date(year, month, 1);
  const offset = (weekday - d.getDay() + 7) % 7;
  return new Date(year, month, 1 + offset + (n - 1) * 7);
}

export function floristDates(year) {
  return [
    { nome: 'Dia Internacional da Mulher', date: new Date(year, 2, 8), peso: 3 },
    { nome: 'Dia das Mães', date: nthWeekday(year, 4, 0, 2), peso: 5 },
    { nome: 'Dia dos Namorados', date: new Date(year, 5, 12), peso: 5 },
    { nome: 'Dia dos Avós', date: new Date(year, 6, 26), peso: 2 },
    { nome: 'Dia dos Pais', date: nthWeekday(year, 7, 0, 2), peso: 2 },
    { nome: 'Dia da Secretária', date: new Date(year, 8, 30), peso: 2 },
    { nome: 'Dia dos Professores', date: new Date(year, 9, 15), peso: 2 },
    { nome: 'Finados', date: new Date(year, 10, 2), peso: 4 },
    { nome: 'Natal', date: new Date(year, 11, 25), peso: 4 },
  ];
}

export function upcomingDates(days = 45, from = new Date()) {
  const limit = new Date(from.getTime() + days * 864e5);
  return [...floristDates(from.getFullYear()), ...floristDates(from.getFullYear() + 1)]
    .filter((d) => d.date >= from && d.date <= limit)
    .map((d) => ({ nome: d.nome, data: d.date.toISOString().slice(0, 10), dias: Math.ceil((d.date - from) / 864e5), peso: d.peso }));
}
