# Comece aqui: conectando a Equipe dos Sonhos à sua floricultura

Guia para o lojista. Leva cerca de 15 minutos. Você não precisa de ajuda técnica.

## 1. Abra a Equipe dos Sonhos

Na iFlores, entre em **Equipe dos Sonhos** no menu. O painel abre dentro da própria iFlores, já ligado à sua loja.
Os agentes que você contratou aparecem coloridos; os outros aparecem com o botão **Contratar**.

## 2. Conecte as contas (aba **Conectar**)

A aba mostra um passo a passo com o que falta. Cada agente só precisa das contas que ele usa:

| Conta | Quem usa | Obrigatória? |
|---|---|---|
| Sistema iFlores | Todos os agentes | Sim. Normalmente já vem conectada. |
| WhatsApp Business | Flora e automações | Se a Flora estiver contratada |
| Instagram | Mari | Se a Mari estiver contratada |
| Meta Ads | Caio | Se o Caio estiver contratado |
| Google Ads | Caio | Opcional |

### WhatsApp Business (Flora)
1. Entre em business.facebook.com com a conta da loja.
2. Em **WhatsApp Manager → API**, copie o **Phone Number ID**.
3. Gere um **token permanente** de usuário do sistema com a permissão `whatsapp_business_messaging`.
4. Cole os dois em **Conectar → WhatsApp Business** e clique em **Conectar e testar**.
5. No app da Meta, em Webhooks, cole o endereço que aparece na tela (termina com o código da sua loja) e assine o campo **messages**.

### Instagram (Mari)
1. A conta precisa ser **Comercial** e estar ligada à página da loja no Facebook.
2. Gere um token com `instagram_basic` e `instagram_content_publish`.
3. Cole o ID da conta e o token em **Conectar → Instagram**.

### Meta Ads e Google Ads (Caio)
1. **Antes de conectar**, defina o teto de gasto em **Configurar → Caio**. O Caio nunca passa desse valor sem a sua autorização.
2. Meta: dê acesso da conta de anúncios a um usuário do sistema e gere um token com `ads_management`.
3. Google: copie o ID da conta (123-456-7890) e autorize o acesso com a conta administradora.

Cada botão **Conectar e testar** valida o acesso na hora. Se der erro, a mensagem diz o que corrigir.

## 3. Ajuste cada agente (aba **Configurar**)

- **Alex**: metas, horário do resumo diário, seu WhatsApp e o que ele pode alterar sozinho (permissões).
- **Flora**: tom de voz, desconto máximo (padrão: nenhum), quando passar para uma pessoa.
- **Mari**: quantos posts e stories por semana e se você aprova um a um, em lote ou deixa automático.
- **Caio**: teto diário e mensal, autonomia (só sugerir ou ajustar dentro do teto).
- **Sol** (aba **Finanças**): custos fixos, taxas e impostos. Sem isso os cálculos aparecem como "parciais".

## 4. Ligue as automações (aba **Automações**)

As mais importantes já vêm ligadas: conversa parada, pagamento pendente, confirmação de pagamento, saída para entrega, pós-venda, insumo acabando e resumo diário.
Mensagens de **marketing** (data especial, cliente inativo) só vão para quem autorizou receber, no máximo uma por semana, e nunca entre 21h e 8h.

## 5. Acompanhe

- **Equipe**: o que cada agente está fazendo agora e o que espera a sua decisão.
- **Tarefas**: tudo o que foi sugerido, pedido ou executado, com resultado.
- **CRM**: cada cliente, a etapa em que está e o histórico completo.
- **Resultados**: o que a equipe entregou no mês e o tempo economizado (estimado).

## Perguntas frequentes

**Os agentes podem ver dados de outra floricultura?** Não. Cada loja tem os próprios dados e o sistema recusa qualquer acesso cruzado. Veja `ISOLAMENTO.md`.

**A Flora pode dar desconto?** Só até o limite que você definir (padrão: zero).

**Se eu responder um cliente pelo painel, a Flora continua falando?** Não. Ela pausa naquela conversa até você clicar em "Devolver para a Flora".

**O link de pagamento enviado significa que o cliente pagou?** Não. O pedido só aparece como pago quando o sistema de pagamento confirma.

**E se a iFlores ficar fora do ar?** Nada se perde. As informações ficam numa fila e são enviadas automaticamente quando ela voltar.

**Posso desfazer algo que o Alex alterou?** Sim. Toda alteração fica em **Loja → Histórico de alterações** com o botão **Desfazer**.
