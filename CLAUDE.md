# Equipe dos Sonhos iFlores

Produto vendido para muitas floriculturas dentro da iFlores: 5 agentes (Alex, Flora, Mari, Caio, Sol), CRM,
automações, painel embutível e API aberta. Código em português.

## Regra inegociável: isolamento entre lojas

Nenhuma loja pode ver, alterar ou receber dados de outra. Antes de mudar qualquer código, leia `docs/ISOLAMENTO.md`.
- Todo acesso a dados passa por `db()` de `src/core/store.js`, sempre com `tenantId`; nunca `list(colecao, null)` dentro de uma loja.
- Trabalho de uma loja roda dentro de `comLoja(tenantId, fn)`.
- Ferramentas da IA recebem `tenantId` por fechamento, nunca por argumento.
- Toda funcionalidade nova precisa de teste com duas lojas (`test/isolamento.test.js` é o modelo).

## Outras regras do produto

- Flora: só informação real do catálogo; sem desconto além do autorizado; resumo antes de criar pedido; link de pagamento não é pagamento confirmado; reaproveitar pedido em aberto; pausar quando um funcionário assume.
- Caio nunca aumenta o teto de gasto sem autorização.
- Sol mostra premissas e marca cálculo parcial quando falta dado; resultado por produto não é lucro líquido.
- Alex registra histórico com desfazer e pergunta quando há ambiguidade.
- Marketing só com consentimento, no máximo 1 por semana, nunca entre 21h e 8h.

## Comandos

- `npm test`: testes (inclui 1000 lojas simultâneas)
- `npm start`: servidor
- `npm run build:demo`: gera `dist/painel-demo.html` (demo no navegador com o mesmo núcleo)
