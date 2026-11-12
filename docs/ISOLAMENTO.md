# Regra: nenhuma interferência entre lojas

A Equipe dos Sonhos é vendida para muitas floriculturas ao mesmo tempo. **Nenhuma loja pode ver, alterar ou
receber dados de outra, e nenhum agente pode responder um cliente com informação de outra loja.**
Esta regra não depende de cada programador lembrar de filtrar: ela é garantida pelo sistema e testada.

## Como está garantido

| Camada | Proteção | Onde |
|---|---|---|
| Dados | Todo documento tem `tenant_id`. Toda operação de uma loja roda em `comLoja(tenantId, ...)`. O store **recusa** (erro `IsolationError`) ler, listar, gravar ou apagar documento de outra loja, gravar sem `tenant_id`, "trocar" o dono de um documento ou mudar de loja dentro de um contexto. | `src/core/store.js` |
| Contexto | No servidor, cada requisição, webhook e rotina recebe o seu contexto (AsyncLocalStorage). O contexto acompanha todas as etapas assíncronas, inclusive chamadas à IA. | `src/server/contexto.js`, `src/server/index.js` |
| API | A loja vem da chave de API ou da sessão do painel, nunca de um parâmetro enviado pelo cliente. Acesso a um id de outra loja responde **404** (não revela que existe). | `src/core/api.js` |
| Agentes | Prompts, ferramentas e histórico são montados só com dados da loja do contexto. As ferramentas da IA recebem o `tenantId` por fechamento, não por argumento que a IA possa mudar. | `src/core/agents/*` |
| Conversas | Mensagens da mesma conversa são processadas em fila, uma de cada vez, para não misturar respostas quando o cliente manda várias mensagens seguidas. | `serial()` em `store.js` |
| Carga | Rotinas rodam por loja com concorrência limitada e tempo máximo; uma loja lenta ou com erro não trava as outras. Limite de requisições por minuto e de chamadas de IA por dia **por loja**. | `contexto.js`, `llm.js` |
| Integrações | Tokens de WhatsApp, Instagram, Meta, Google e iFlores ficam no registro da própria loja. Webhooks de saída usam o segredo da loja. Eventos da iFlores são deduplicados por loja. | `crm.js`, `server/index.js` |
| Tempo real | Cada painel recebe só o canal `t:<loja>`. | `events.js` |

## Como está testado (`npm test`)

`test/isolamento.test.js`:
- o store recusa leitura, listagem, gravação, remoção e "roubo" de documento de outra loja;
- a API de uma loja recebe 404 ao tentar abrir conversa, tarefa ou contato de outra;
- o Alex desativando produtos numa loja não muda nada na outra;
- **1000 lojas atendidas ao mesmo tempo**, todas com um produto de mesmo nome e preços diferentes, e o mesmo
  telefone de cliente: cada resposta tem só o preço e o nome da própria loja, e cada loja tem o próprio contato;
- o mesmo `event_id` da iFlores é processado uma vez por loja, e uma loja não confirma pagamento de pedido de outra.

## Checklist para qualquer código novo

1. Toda função do núcleo recebe `tenantId` e consulta com `db().list(colecao, tenantId, ...)`. Nunca use `null` (todas as lojas) dentro de uma loja.
2. Ids determinísticos começam com o id da loja (`${tenantId}:...`).
3. Rotina nova é chamada dentro de `comLoja(tenantId, ...)` (o agendador já faz isso).
4. Ferramenta nova da IA recebe `tenantId` por fechamento; nunca aceite id de loja vindo da IA ou do cliente.
5. Cache ou mapa em memória usa chave com o id da loja.
6. Escreva um teste com duas lojas para a funcionalidade nova.
