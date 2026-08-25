# whatsAgent — Barbosa, Loli e Oliveira Sociedade de Advogados

Atendimento por WhatsApp com múltiplos números conectados por QR (Baileys), agente
multimodal na **OpenAI** (texto + Whisper + visão), persistência em **MongoDB**,
contexto comprimido por **ontologia**, **guardrails** calibrados para os limites da
advocacia e proteção contra **bot × bot**.

## Agentes

| Agente | Status | Números | Papel |
|---|---|---|---|
| **Captação de Leads** (`lead_capture`) | 🟢 ativo | `+55 19 99638-3884`, `+55 11 94006-1595` | atendimento inicial e triagem |
| **Clientes** (`customer_agent`) | 🟢 ativo | `+55 19 98758-7782` | acompanhamento de caso em andamento |

O agente de clientes existe por inteiro — roteamento, papel, ontologia, persona —
e pode ser colocado em `standby` a qualquer momento: em standby ele continua
roteando e configurável, mas nunca assume atendimento. **O status é uma decisão
operacional, tomada em `/curadoria`, sem deploy.** O `agents.config.js` é o
cadastro base; o painel tem precedência sobre ele.

Para vincular um número novo, use o painel de Conexões (ou inclua-o na lista do
agente em [agents.config.js](backend/src/config/agents.config.js)). Não há
`if numero === X` em nenhum outro lugar do código.

**O vínculo é automático.** Ao ler o QR, o Baileys informa o número pareado, o
sistema resolve o agente e persiste. Não existe seleção manual, e o vínculo
sobrevive a restart e reconexão:

```
+55 19 99638-3884 → QR lido → número identificado → Captação de Leads → ativo
```

O casamento normaliza formato (com máscara, sem máscara, JID) e trata a variante
brasileira sem o nono dígito. Número não cadastrado cai no fallback em standby —
nunca começa a responder sozinho.

---

## Como rodar

```bash
docker compose up -d mongodb        # ou aponte MONGO_URI para o Atlas

cd backend
cp .env.example .env                # OPENAI_API_KEY, MONGO_URI e JWT_SECRET
npm install
npm run create:user -- voce@escritorio.com "sua-senha-forte" --admin
npm run dev                         # http://localhost:3001

cd ../frontend
cp .env.local.example .env.local
npm install && npm run dev          # http://localhost:3000
```

Gere o `JWT_SECRET` com
`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.

`npm run create:user` sem argumentos lista quem ja tem acesso.

---

## Acesso ao painel

O painel permite parear contas de WhatsApp do escritorio e alcanca conversas de
clientes. Por isso **nao existe modo aberto**: toda rota sob `/api` exige token,
e o Socket.IO recusa handshake sem ele. As unicas rotas publicas sao `/health` e
`/api/auth/*`.

- Senha guardada como **scrypt** (do proprio Node, sem dependencia nativa), com
  salt por usuario e comparacao em tempo constante.
- Erro de login e sempre o mesmo texto, exista o email ou nao — dizer "email nao
  encontrado" entrega quais contas sao validas.
- Cinco tentativas erradas bloqueiam a conta por 15 minutos.
- Token JWT de 12h; revogar um usuario (`active: false`) tem efeito imediato,
  mesmo com token ainda vigente.

```
/            -> login (email + senha)
/connections -> painel de QR, protegido
/conversas   -> conversas e atendimento humano, protegido
/clientes    -> gestao operacional da carteira, protegido
/curadoria   -> configuracao dos agentes, protegido
```

### Niveis de acesso

| Papel | Pode |
|---|---|
| **Administrador** | tudo: alterar, publicar, restaurar versoes, ligar/desligar agente, configurar o pipeline de clientes, excluir ficha e gerenciar acessos |
| **Curador** | editar, testar e publicar a configuracao dos agentes; editar fichas de cliente, mover no quadro, criar tarefas e usar a IA |
| **Visualizador** | consultar configuracao, carteira, historico e metricas |

O papel antigo `operador` continua valendo como **curador** — renomear papel de
usuario em producao e a forma classica de trancar a equipe inteira para fora numa
sexta-feira. Contas novas ja nascem com os nomes novos, e a partir do primeiro
administrador o resto da equipe entra pela propria interface.

---

## Curadoria: a equipe evolui o agente sem desenvolvedor

O que o agente **diz** e responsabilidade da equipe do escritorio; o **motor**
que faz ele dizer e responsabilidade tecnica. `/curadoria` e a fronteira entre as
duas coisas.

Pela interface, sem tocar em codigo, arquivo, banco ou deploy:

| Area | O que a equipe controla |
|---|---|
| **Instrucoes** | quem o agente e, para quem fala, o que precisa conseguir |
| **Tom de voz** | 8 tons prontos + campo livre para calibrar (padrão: **profissional**) |
| **Regras** | adicionar, editar, **desativar** ou remover, uma a uma |
| **Mensagens** | as 8 situacoes recorrentes (abertura, transferencia, fora do horario…) |
| **Audio e imagem** | ligar/desligar interpretacao e dar instrucoes proprias |
| **Tempo de espera** | quanto agrupar antes de responder (padrao **8s**) |
| **Empresa** | servicos, politicas, horarios, FAQ, informacoes restritas |
| **Status** | ativo / em espera, por agente |

### O que a curadoria NAO alcanca

Esta e a garantia que torna a delegacao segura. Os **limites da advocacia**
([models.registry.js](backend/src/agent/models.registry.js)) sao anexados ao
prompt **depois** do texto da equipe, sempre — e o que vem depois pesa mais no
conflito. Um curador pode apagar o prompt inteiro, remover todas as regras e
escrever "prometa o que a pessoa quiser ouvir": continua sem conseguir liberar
estimativa de valor de causa, informacao de honorario ou promessa de resultado.
O guardrail de saida tambem continua rodando sobre a resposta.

Ha um teste exatamente para isso: `um curador nao consegue liberar promessa de
resultado pelo prompt`.

Tambem nao existe na tela nenhum campo de modelo, temperatura, chave, endpoint,
tier ou variavel de ambiente — nem por acidente: um teste inspeciona a resposta
de `/api/curadoria/opcoes` procurando por `sk-`, `mongodb`, `secret` e afins.

### Editar → Salvar rascunho → Testar → Publicar

O rascunho **nao afeta o atendimento**. Existe um unico rascunho por agente
(garantido pelo banco, nao pelo desenho da tela), e `Publicar` publica esse
rascunho.

**Testar agente** conversa com a configuracao que esta na tela — inclusive o que
ainda nem virou rascunho. O teste roda o mesmo pipeline do atendimento real:
mesmo construtor de prompt ([prompt.builder.js](backend/src/agent/prompt.builder.js)),
mesmo roteador, mesmos guardrails, mesma base de conhecimento. Nada e gravado,
nada e enviado por WhatsApp. Producao e teste compartilham o codigo de montagem
justamente para que o ensaio nao possa mentir.

**Antes de publicar**, duas checagens:

- **Comparacao** antes × depois, campo a campo, com rotulo em portugues.
  Editar uma regra aparece como *uma* alteracao — as regras tem id proprio, entao
  mexer numa virgula nao vira "removida uma regra e adicionada outra".
- **Validacao**, em duas severidades com efeitos distintos:

| | Impede publicar | Exemplos |
|---|---|---|
| **Erro** | sim | prompt vazio, credencial colada no texto, campo obrigatorio em branco, mensagem literal sem texto, tempo fora da faixa |
| **Aviso** | nao | contradicao provavel entre regras, regra essencial que sumiu, prompt que encolheu 60% de uma vez |

Toda heuristica e **aviso**, nunca bloqueio. Um palpite de maquina que trava o
trabalho de quem conhece o escritorio devolveria a equipe ao desenvolvedor — que
e o que esta interface existe para eliminar. Todo problema traz o que esta
errado, por que importa e **como corrigir**.

### Versionamento e restauracao

Toda publicacao vira uma versao com snapshot completo, data, autor e o diff
legivel. Restaurar a versao 12 **nao apaga** as versoes 13 a 20: cria a 21,
marcada como restauracao. Esconder o intervalo esconderia justamente o erro que
motivou a volta. Um rascunho em aberto sobrevive a restauracao — quem restaura
costuma estar apagando um incendio, e destruir de quebra o trabalho de outra
pessoa seria um segundo incidente.

O snapshot e guardado inteiro, e nao como cadeia de patches, para que voltar a
uma versao antiga funcione mesmo que as intermediarias sumam.

### Degradacao

A configuracao publicada fica em cache no processo e so e invalidada por
publicacao, restauracao ou mudanca de status — `publicada()` roda a cada turno de
conversa, e ir ao banco ali custaria uma consulta por mensagem. Banco fora nao
derruba atendimento: cai para a configuracao de fabrica, que e exatamente o
comportamento anterior a esta interface.

O cache e por processo, o que e seguro porque o deploy roda com **uma replica**
(exigencia da sessao do Baileys). Com mais de uma instancia, publicar precisaria
avisar as outras — o unico ponto a mudar seria `invalidar()`.

---

## Pipeline

```
WhatsApp
   ↓ evento
identificar sessão → identificar número → identificar agente → agente ativo?
   ↓
fromMe? → duplicado? → conversa pausada? → sinais de bot?
   ↓
              ┌─────────┬──────────────┬──────────────┐
              │  texto  │ áudio→Whisper│ imagem→visão │
              └─────────┴──────────────┴──────────────┘
   ↓ normalizar
buffer da conversa ── aguarda 8s de silêncio ──▶ consolidar (ordem preservada)
   ↓
histórico + ontologia + base de conhecimento
   ↓
agente (sol / luna / terra) → guardrail de saída → anti-loop de saída
   ↓
enviar em texto → persistir
```

Uma sequência de mensagens gera **uma** resposta. O usuário pode escrever, falar e
fotografar — o agente espera ele terminar.

---

## Buffer de 8 segundos

[buffer.service.js](backend/src/conversation/buffer.service.js) — debounce por
conversa, chaveado em `channelId:chatId`. Nunca um `sleep` global.

- cada mensagem nova **estende** a janela daquela conversa, e só dela
- **ordem cronológica preservada**; nunca reagrupado por tipo, porque o sentido
  depende da ordem (`"vou mandar uma foto"` → foto → `"é esse aqui"`)
- **teto absoluto** (`BUFFER_MAX_WAIT_MS`, 45s): quem digita sem parar também é
  respondido
- **lote cheio** (`BUFFER_MAX_MESSAGES`): consolida sem esperar
- **lock por conversa**: nunca duas execuções do agente no mesmo contato
- mensagem que chega **durante** o processamento não se perde — abre o próximo ciclo
- timers com `unref()`: a fila nunca segura o processo de pé

Onze testes cobrem exatamente esses casos, incluindo o cenário do enunciado:
quatro mensagens em seis segundos → uma execução.

---

## Multimodal

| Entrada | Tratamento | Saída |
|---|---|---|
| texto | direto | texto |
| áudio | download → **Whisper** (`WHISPER_MODEL`) | **texto** |
| imagem | download → **visão** (`VISION_MODEL`) | texto |
| imagem + legenda | analisadas **juntas**, com dica do histórico recente | texto |
| vídeo, documento, figurinha | marcador legível no contexto | texto |

O Whisper recebe um `prompt` com vocabulário do domínio (rescisão, FGTS, CTPS,
insalubridade…) porque nomes técnicos são o que ele mais erra. A visão recebe a
legenda e um resumo de três mensagens do histórico — `"é esse aqui?"` só faz
sentido com a conversa ao lado — e é instruída a **descrever, nunca interpretar
juridicamente**.

O agente responde sempre em texto, mesmo a áudio.

**Falha não derruba atendimento.** Whisper fora, imagem ilegível ou download
expirado viram uma parte marcada (`[audio recebido, não foi possível transcrever]`)
e o agente é instruído a pedir reenvio com naturalidade. Ver
[message.normalizer.js](backend/src/whatsapp/message.normalizer.js).

---

## Proteção bot × bot

Nenhum sinal isolado pausa nada. [antiloop.service.js](backend/src/guardrails/antiloop.service.js)
acumula evidência em camadas:

| Camada | O que observa |
|---|---|
| 1 | `fromMe` — descartado no manager, nunca chega ao pipeline |
| 2 | texto com cara de automático: "mensagem automática", "fora do horário", menu numerado |
| 3 | cadência sobre-humana: respostas em menos de 1,5s, repetidas vezes |
| 4 | repetição: mesma entrada nossa/dele se repetindo (A→B→A→B) |
| 5 | `loopCounter`: interações consecutivas sem evidência humana |

Ao atingir `ANTILOOP_MAX_AUTO_INTERACTIONS` a conversa vira
`BOT_LOOP_DETECTED` e o agente para naquele contato. Uma segunda checagem roda
**antes de enviar**: se estamos repetindo a mesma resposta
(`ANTILOOP_MAX_REPEATS`), pausa também.

Uma mensagem claramente humana **zera** a suspeita acumulada.

> **Conta Business não bloqueia.** `verifiedBizName` é registrado como contexto e
> nunca entra na avaliação que pausa — muita empresa legítima usa Business, e
> perder esses leads custaria mais que o loop. Há um teste garantindo isso.

Conversas pausadas aparecem no painel com o motivo e os sinais, e têm botão de
**Retomar** (que zera os contadores).

---

## Gestão operacional de clientes

`/clientes` substitui a planilha de acompanhamento. Três visões do **mesmo
recorte de filtros** — painel (os números), lista (os clientes) e quadro (o
fluxo) — porque refiltrar a cada troca de aba faz a equipe desistir de usar mais
de uma.

### A ficha se alimenta sozinha

É a diferença em relação à planilha, onde o registro depende de alguém lembrar —
e por isso está desatualizada justamente nos casos que mais importam.

| Acontece | O sistema registra |
|---|---|
| contato escreve pelo WhatsApp | ficha criada, conversa vinculada, timeline |
| alguém muda status, etapa, responsável | linha na timeline com quem mudou, de que para que |
| pendência criada ou resolvida | linha na timeline |
| tarefa criada ou concluída | linha na timeline |

**A chave é o telefone**, não o `chatId` nem o LID: a mesma pessoa escrevendo
para dois números do escritório continua sendo um cliente só, e quem é
cadastrado à mão antes da primeira mensagem já nasce no lugar certo.

O nome do WhatsApp só preenche o vazio — sobrescrever apagaria o nome civil
("Maria Souza") pelo apelido da conta ("Mah 💜"), e ninguém procura cliente por
apelido.

### Importar a planilha

Sem isso, adotar o módulo custa preencher a carteira inteira à mão — e nenhum
escritório faz isso. Em `/clientes` → **Importar planilha**, três passos, e os
dois primeiros **não gravam nada**: escolher o arquivo, conferir o que cada
coluna vira, importar.

O arquivo vai ao servidor em **bytes** (base64), não como texto. Se o navegador
decodificasse, ele escolheria a codificação sozinho e os acentos de uma planilha
do Excel chegariam estragados.

O que o leitor resolve sozinho, cada item vindo de um defeito do arquivo real:

| Problema | Tratamento |
|---|---|
| cabeçalho na linha 2, atrás de um título solto | acha a linha com mais células preenchidas |
| `FUNÃÃO` no lugar de `FUNÇÃO` | detecta UTF-8, Windows-1252 e o mojibake clássico |
| `"CONTRATO, PROCURAÇÃO, DOC PESSOAL"` numa célula | parser RFC 4180: aspas, vírgulas e quebras dentro do campo |
| 18 colunas `Coluna 2`…`Coluna 20` vazias | descartadas |
| `;` em vez de `,` (Excel pt-BR) | separador detectado fora das aspas |
| linhas só com o nome do cliente | viram ficha; linha sem nome é ignorada e contada |

**Nada é descartado em silêncio.** Coluna sem destino conhecido — *parte
contrária*, *número do processo*, *documentos entregues* — vira **campo da
planilha** na ficha, com o título original. Perder isso só seria descoberto
semanas depois, com a planilha já arquivada.

**Nada é inventado.** `AJUIZADO: SIM` não corresponde a status nenhum do quadro;
em vez de escolher um por semelhança, a ficha fica no status inicial e o valor
original é preservado. A prévia diz quantas linhas caíram nesse caso e por quê.
Mesma regra para etapa, prioridade, datas e responsável — um "MATHEUS" que não
é usuário do painel não vira responsável fantasma.

**Reimportar não duplica.** A chave é o telefone quando existe, o nome
normalizado quando não. *Completar fichas existentes* preenche apenas campos
**vazios**: a planilha costuma ser mais antiga que o sistema, e sobrescrever
apagaria o trabalho feito no painel.

> O telefone deixou de ser obrigatório por causa desta planilha: dos 6 clientes
> do arquivo real, só 1 tinha número. O índice único virou **parcial** — vale
> apenas para quem tem telefone, então muitas fichas sem número convivem sem
> colidir. Quem não tem telefone não é vinculado automaticamente ao WhatsApp.

---

### Status, etapas e kanban configuráveis

Os status vêm do enunciado e são editáveis pela equipe, sem deploy. **O kanban
não é a lista de status**: cinco colunas agrupam os oito status, porque um
quadro só serve enquanto cabe na tela. A distinção fina continua na ficha e nos
filtros, e um teste garante que nenhum status fique fora de coluna alguma —
cartão invisível é a pior falha possível num quadro.

### Resumo inteligente: duas versões, dois materiais

A versão para a equipe pode ser franca. A versão para o cliente é gerada por
**outra chamada, com outro dossiê** — o modelo que escreve para o cliente
simplesmente não recebe observações internas, tarefas nem nome de responsável.

Seria mais barato pedir as duas de uma vez e instruir o modelo a não copiar o
que é interno. Aí a única coisa separando a anotação *"cliente complicado,
cobrar antes"* de uma mensagem enviada a essa pessoa seria uma frase no prompt.

> Um teste encontrou esse vazamento por outro caminho: o dossiê externo já
> excluía `observacoesInternas`, mas o mesmo texto voltava pela **linha do
> tempo**, como descrição de um evento de observação. Hoje a timeline pública
> filtra por tipo e descarta as descrições — ver `TIPOS_PUBLICOS`.

O texto para o cliente ainda passa pelo **guardrail de saída** do agente: é
conteúdo destinado a sair do escritório, então vale a mesma regra de qualquer
mensagem. Reprovado, não é oferecido para copiar.

O resumo só é regerado quando a **assinatura** do caso muda (status, etapa,
aguardando, próxima ação, pendências, último evento relevante). Abrir a ficha de
um cliente parado há duas semanas não custa duas chamadas de modelo — e uma
mensagem de "bom dia" não envelhece resumo nenhum, porque mensagem não é evento
relevante.

### "Como está meu processo?"

Quando o próprio cliente pergunta pelo WhatsApp, o agente responde com o que
está **registrado na ficha**. Duas travas, ambas estruturais:

1. A detecção é por padrão de texto, sem chamada de modelo — ir ao banco em toda
   mensagem para um dado quase nunca usado custaria caro.
2. Sem material suficiente, o bloco entra **assim mesmo**, com a instrução
   oposta: *"NÃO HÁ INFORMAÇÃO REGISTRADA. Diga que vai verificar. Não invente."*
   Omitir o bloco deixaria o modelo livre para reconstruir um andamento a partir
   da conversa, que é exatamente o que não pode acontecer.

> Detalhe que custou um teste: `\b` em JavaScript é ASCII, então `/está\b/` nunca
> casa com "está meu processo" — entre "á" e o espaço não existe borda. Em
> português isso deixaria a detecção quase inútil.

### Sugestões automáticas

A IA lê a conversa e propõe status, etapa, pendência, próxima ação, prioridade e
prazo, com uma justificativa citando o fato concreto. **Nada é aplicado
sozinho.** Uma ficha que muda de status por conta própria é pior que uma
desatualizada: ninguém confia mais em nenhum campo. O colaborador marca o que
aceita, e cada campo aceito passa pelo mesmo caminho de uma edição manual —
inclusive gerando linha na timeline.

Ids de status inventados pelo modelo são descartados: um status fantasma
deixaria o cliente invisível no quadro.

---

## Por que o pareamento sobrevive ao restart

As credenciais do Baileys ficam no **MongoDB**, não em arquivos.

Elas moravam em `backend/sessions/`. Em container isso é disco efêmero: cada
deploy, cada restart e cada troca de máquina começa com o sistema de arquivos
zerado — e o escritório tem de ler o QR de novo em cada número. A solução
anterior era um volume montado em `/app/sessions`. Funciona, mas depende de
alguém lembrar de configurar, e o sintoma de esquecer aparece dias depois, na
forma de *"o WhatsApp caiu outra vez"*.

O banco já é obrigatório, já é durável e já tem backup.
[auth.store.js](backend/src/whatsapp/auth.store.js) implementa o mesmo contrato
que o `useMultiFileAuthState` do Baileys (`{ state, saveCreds }`), então o
gerenciador não sabe a diferença.

| | Antes | Agora |
|---|---|---|
| Onde | `backend/sessions/<canal>/` | coleção `wasessions` |
| Sobrevive a deploy | só com volume | sempre |
| Leitura de chaves | um arquivo por chave | uma consulta em lote |
| Trava contra escrita concorrente | mutex por arquivo | atômica por documento |

**Quem já estava pareado não lê o QR de novo.** No primeiro boot, o que ainda
estiver em `sessions/` é migrado para o banco automaticamente e o arquivo antigo
deixa de ser consultado.

**Sigilo.** Isto é material sensível de verdade: quem tem esses documentos assume
a conta e lê as conversas dos clientes. Valem para o banco os mesmos cuidados que
valiam para a pasta — acesso restrito, nunca compartilhado com terceiros.

### Se mesmo assim pedir o QR

O boot registra `WA_CREDENCIAIS_PERDIDAS` quando um canal tem número pareado no
banco mas nenhuma credencial. Com as credenciais no Mongo isso só acontece se o
banco for outro, a coleção tiver sido apagada ou um dump antigo restaurado — e o
log diz qual das três checar.

Duas outras causas, ambas com teste travando o comportamento:

- **`sock.logout()` no lugar de `sock.end()`** ao encerrar. `logout` derruba a
  sessão *no aparelho* e exige QR novo; `end` apenas fecha o socket. Trocar um
  pelo outro produz exatamente esse sintoma e nada no log denuncia.
- **Duas réplicas.** Duas instâncias na mesma sessão Signal derrubam a conta.

---

## O telefone por trás do LID

O WhatsApp endereça muitos chats por **LID** (`12036159274582@lid`) em vez do
telefone. O LID é opaco e **não contém** o número — tratá-lo como telefone
produzia coisas como `+40351318433948` no painel.

O número real existe, só não está no endereço. O WhatsApp o entrega **quando
quer**, por quatro caminhos, e [lid.resolver.js](backend/src/whatsapp/lid.resolver.js)
escuta todos:

| Fonte | Quando |
|---|---|
| `messaging-history.set` | sincronização inicial: a agenda inteira, com `lid` e `jid` juntos |
| `key.senderPn` no stanza | quando o WhatsApp inclui — **não é toda mensagem** |
| `chats.phoneNumberShare` | o contato compartilha o telefone |
| `contacts.upsert` / `update` | atualização de agenda |

Nenhuma é garantida sozinha, então **o vínculo é gravado** (`LidMapping`) na
primeira vez que aparece. Sem essa memória, o painel perderia o telefone no
turno seguinte.

Um LID nunca é gravado no lugar do telefone: `jidToNumber` devolve `null` para
`@lid`, e há um teste para isso — gravar o identificador como se fosse número é
o bug original, só que com a confiança de estar no banco.

O aprendizado é **síncrono no cache e assíncrono no banco**: descobrir o
telefone de um contato não pode atrasar a resposta a ele. Com o banco fora, a
gravação falha em silêncio (com log) e a sessão continua funcionando.

### Quando o WhatsApp não entrega

Acontece: `senderPn` não vem em toda mensagem, o compartilhamento depende do
contato e a agenda só ajuda se a pessoa estiver nela. Duas saídas, nessa ordem:

**1. O log diz o que chegou.** Cada mensagem de chat por LID ainda sem telefone
registra `LID_SEM_TELEFONE` com os campos que o WhatsApp mandou. Sem isso, "o
painel mostra o ID" é um sintoma sem causa e a única alternativa seria adivinhar.
O evento para de sair no instante em que qualquer fonte revelar o número.

**2. A equipe informa.** Em `/conversas`, um chat sem telefone oferece
*"ou informe agora"*. Quem está no painel vê o número no próprio aplicativo, e
digitar é melhor do que conviver com um `ID 40351318433948` que não diz nada.
O vínculo passa a valer para aquele **contato** em todos os números do
escritório — não só naquela conversa — e sobrevive a restart.

Conversas antigas se resolvem sozinhas quando qualquer fonte entregar o número.
Para adiantar o que já dá:

```bash
npm run fix:lid -- --lista   # mostra o que dá para resolver, sem gravar
npm run fix:lid              # preenche
```

`grep LID_RESOLVIDO` mostra cada descoberta com a origem; `grep LID_SEM_TELEFONE`
mostra o que continua sem.

---

## Dois interruptores, dois alcances

O agente pode ser desligado em dois lugares, e confundi-los é caro:

| Onde | Alcance | Quando usar |
|---|---|---|
| **Conversas** → botão no cabeçalho | **uma pessoa** | assumir um atendimento sem tirar o agente dos outros |
| **Conexões** → interruptor do cartão | **todas** as conversas daquele número | manutenção, fora do ar, desligar o número |

O controle por pessoa sempre existiu no backend — `pause` filtra por
`(sessionId, chatId)` — mas **a tela não o mostrava**: ele só aparecia depois
que a conversa já estava pausada, num aviso pequeno acima da caixa de texto.
Quem assumia um atendimento e queria devolvê-lo não achava o caminho e acabava
no interruptor de Conexões, que desliga para todo mundo.

Agora o cabeçalho da conversa diz **quem responde aquela pessoa** — *"Agente
atende"* ou *"Você atende"* — e alterna com um clique. Na lista, um ícone por
linha mostra o mesmo de relance: sem isso, uma carteira com dez atendimentos
assumidos vira dez cliques para descobrir quais o agente ainda cobre.

**Enviar assume a conversa** por padrão: pessoa e agente respondendo juntos
confunde o contato. Mas há um interruptor ao lado da caixa de texto para enviar
**sem** assumir — às vezes o atendente só quer complementar uma informação e
devolver a conversa, e sem essa opção teria de religar o agente toda vez.

Cinco testes travam o alcance, inspecionando o **filtro** da consulta em vez de
um caso: é o filtro que define quem é atingido, e um `updateMany` acidental ali
derrubaria o atendimento do escritório inteiro sem nada na tela denunciar.

---

## Estado e idempotência

[Conversation](backend/src/models/Conversation.js) guarda por conversa: `chatId`,
`sessionId`, `phoneNumber`, `channelNumber`, `agentId`, `agentType`, `status`,
`lastUserMessageAt`, `lastAgentMessageAt`, `bufferStatus`, `processing`,
`possibleBot`, `loopCounter`, `botSignals`, `pausedReason`.

Estados: `WAITING_MESSAGES` · `READY_TO_PROCESS` · `PROCESSING` · `WAITING_USER` ·
`PAUSED` · `BOT_LOOP_DETECTED` · `CLOSED`.

[ProcessedMessage](backend/src/models/ProcessedMessage.js) resolve idempotência por
índice único em `(channelId, waMessageId)` — a segunda inserção falha, e o evento é
descartado. TTL de 7 dias. Se o controle de idempotência falhar, o sistema **atende
mesmo assim**: perder um lead é pior que responder duas vezes.

Tudo persiste. Reiniciar não perde vínculo de agente, marcação de pausa nem
histórico.

---

## Base de conhecimento

Dois backends atrás da mesma interface `search()`, em
[knowledge.repository.js](backend/src/domain/knowledge.repository.js):

- **`memory`** (padrão) — 17 verbetes locais, casados por `tipo_caso` e palavra-chave.
  Zero infra, zero latência, funciona hoje.
- **`mongo`** — Atlas Vector Search sobre `knowledgechunks`.

Para ativar a busca semântica:

```bash
npm run seed:knowledge     # embeda os verbetes e imprime o índice a criar
```

Depois crie o índice vetorial no Atlas com o nome de `KNOWLEDGE_VECTOR_INDEX` e
mude `KNOWLEDGE_BACKEND=mongo`. O pipeline do agente não muda em nada.

Se a busca vetorial falhar — índice ainda construindo, cluster fora, embedding
indisponível — **cai sozinha para a base local** em vez de deixar o agente sem
contexto. O `tipo_caso` já extraído pela ontologia dá um boost de score ao verbete
correspondente.

---

## Os quatro tiers

`mini`, `sol`, `luna` e `terra` não são IDs de modelo — são *tiers de agente*
(persona + política + limites), cada um apontando para um modelo real via env.

| Tier | Função | Variável |
|---|---|---|
| **Mini** | ontologia, resumo, classificação (nunca fala com o contato) | `MODEL_MINI` |
| **Sol** | atendimento inicial: acolhe e faz a triagem | `MODEL_SOL` |
| **Luna** | clientes: acompanhamento | `MODEL_LUNA` |
| **Terra** | escalonamento: casos sensíveis e conversas travadas | `MODEL_TERRA` |

O tier base vem do **agente vinculado ao número**; o [roteador](backend/src/agent/router.js)
escala para `terra` em caso sensível (assédio, gestante, rescisão indireta),
pergunta sobre honorário ou valor, pessoa fragilizada, cliente insatisfeito, risco
de prescrição, ou triagem que arrasta.

---

## O limite que estrutura tudo

O agente **não é advogado e não dá consulta**. Pode explicar que, em regra, a lei
prevê multa de 40% do FGTS. Não pode dizer que *você* tem direito a ela.

| Não faz | Por quê |
|---|---|
| Concluir sobre o caso da pessoa | análise é do advogado, com os documentos |
| Estimar valor de causa ou indenização | depende de documentos e cálculo |
| Informar honorário ou "de graça" | tratado pelo advogado na consulta |
| Prometer resultado ou prazo de processo | ninguém pode garantir |
| Mandar agir (pedir demissão, não assinar, faltar, gravar) | pode prejudicar a pessoa |
| Comparar com outros escritórios, superlativo | publicidade indevida (Prov. 205/2021 CFOAB) |
| Atender a empresa ou parte contrária | conflito de interesses → handoff |

Regras em [rules.js](backend/src/guardrails/rules.js). O teste
`PERMITE informacao juridica geral com hedge` existe para garantir que o guardrail
não sufoque o negócio do escritório.

Duas calibrações a revisar com o escritório: **percentual legal é liberado**
(multa de 40% passa, "honorários de 30%" não); e **"não assine nada" é bloqueado**
— se preferirem que o agente diga isso, remova `orientacao_de_risco`.

---

## O custo de uma resposta

Uma saudação simples chegou a consumir **2.919 tokens**. Medido, o gasto era:

| | antes | depois |
|---|---|---|
| extração de ontologia (mini) | 887 | **0** |
| prompt de sistema (sol) | 1.722 | 1.685 |
| saída | ~310 | ~310 |
| **total** | **~2.919** | **~1.700** |

**A base de conhecimento não era o custo.** Com o backend `memory` (o padrão)
ela é busca local por palavra-chave: para "Bom dia!!" devolve zero e não injeta
nada. E `sol` não é um modelo caro — por padrão é `gpt-4o-mini`, o mesmo do
`mini`. O que pesava era **quantos tokens** iam, não qual modelo os recebia.

### Dois portões, o mesmo critério

O gasto real era uma **chamada de modelo inteira** para extrair estado de "Bom
dia!!" — e concluir, com certeza, que não havia nada a extrair.

`ontologyService.valeExtrair()` decide por **subtração**: retira do texto tudo
que é cumprimento e pontuação; se sobrar palavra, ela pode ser o caso da pessoa.
`"Bom dia, fui demitido"` deixa `"fui demitido"` e extrai; `"Bom dia!!"` não
deixa nada e pula.

O mesmo portão fecha a busca na base. Com `memory` isso é só prompt poupado;
com `KNOWLEDGE_BACKEND=mongo`, cada consulta gera um **embedding pago** — e uma
saudação pagaria por um verbete que não existe.

> O viés é deliberado: **na dúvida, extrai**. Perder um slot custa uma pergunta
> repetida ao cliente; economizar tokens não vale isso.

Mais duas podas, ambas de blocos que iam inteiros a cada turno:

- **`[SITUACOES]` não vai no primeiro contato.** Encerrar, transferir e
  qualificar são situações que ainda não existem naquele turno.
- **A FAQ não vai inteira.** É o único campo da curadoria que cresce sem teto —
  40 entradas. Entram no máximo duas, e só as que a mensagem sustenta. Sem isso,
  o custo da conversa subiria junto com o zelo da equipe em preencher a base.

---

## Ontologia: economia de tokens

Domínio como conjunto **fechado** de slots
([ontology.schema.js](backend/src/ontology/ontology.schema.js)). Vai o *estado*, não
a *transcrição*:

1. **Vocabulário fechado** — slot ou valor fora do schema é descartado; `tipo_caso`
   só aceita os 18 temas trabalhistas. Guardrail estrutural, não só economia.
2. **Delta** — o extrator devolve só o que mudou.
3. **Renderização densa** — `chave=valor`, não JSON identado.
4. **Resumo rolante** — a cada `ONTOLOGY_SUMMARY_EVERY` mensagens.
5. **Base sob demanda** — no máximo 2 verbetes (~120 tokens) em vez dos ~1.500 da
   base inteira. Um teste trava isso em menos de 15%.

`faltam=` impede repetir pergunta já respondida — o que encurta a conversa e poupa
mais que qualquer compressão. A economia estimada aparece no painel como
**Tokens poupados**.

---

## Observabilidade

Todo evento do pipeline tem tag fixa em [events.js](backend/src/utils/events.js):

```
WHATSAPP_MESSAGE_RECEIVED   FROM_ME_IGNORED         DUPLICATE_MESSAGE_IGNORED
AGENT_BOUND                 AGENT_STANDBY_SKIPPED   BUFFER_STARTED
BUFFER_UPDATED              BUFFER_PROCESSING       BUFFER_MAX_WAIT_FLUSH
BUFFER_REQUEUED             AUDIO_TRANSCRIPTION_*   IMAGE_ANALYSIS_*
MEDIA_DOWNLOAD_FAILED       AGENT_EXECUTION_*       AGENT_RESPONSE_SENT
POSSIBLE_BOT_DETECTED       BOT_LOOP_DETECTED       AGENT_PAUSED
KNOWLEDGE_SEARCH
```

`grep BOT_LOOP_DETECTED` acha todos os casos, sem variação de escrita. O logger tem
`redact` para `authorization`, `apiKey`, `creds` e `auth`; PII é mascarada antes de
sair da máquina.

---

## API

| Método | Rota |
|---|---|
| `GET` | `/api/channels` — canais com status e agente vinculado |
| `POST` | `/api/channels/:id/connect` · `/disconnect` · `/logout` · `/agent` |
| `GET` | `/api/channels/:id/contacts` · `/conversations` |
| `GET` | `/api/agents` — registro de agentes e números |
| `GET` | `/api/agent/tiers` · `/api/agent/usage` |
| `GET` | `/api/conversations/paused` |
| `POST` | `/api/conversations/:channelId/:chatId/resume` |
| `GET` | `/api/knowledge/status` · `/api/config` |
| `POST` | `/api/auth/login` — publica |
| `GET` | `/api/auth/me` · `/api/auth/status` · `/health` — publicas |

Curadoria — o que escreve exige papel de curador ou administrador:

| Método | Rota |
|---|---|
| `GET` | `/api/curadoria/opcoes` — tons, mensagens, campos, limites e permissoes |
| `GET` | `/api/curadoria/agentes` · `/api/curadoria/agentes/:id` · `/:id/padrao` |
| `PUT` | `/api/curadoria/agentes/:id/rascunho` |
| `POST` | `/api/curadoria/agentes/:id/validar` · `/publicar` · `/descartar` · `/testar` |
| `GET` | `/api/curadoria/agentes/:id/diferencas` · `/versoes` · `/versoes/:n` |
| `POST` | `/api/curadoria/agentes/:id/versoes/:n/restaurar` — só administrador |
| `POST` | `/api/curadoria/agentes/:id/status` — só administrador |
| `GET/POST/PATCH` | `/api/curadoria/usuarios` — só administrador |

Clientes — leitura para todos; escrita exige curador, e excluir/configurar exige
administrador:

| Método | Rota |
|---|---|
| `GET` | `/api/clientes` · `/kanban` · `/painel` · `/agenda` · `/responsaveis` |
| `GET/PUT` | `/api/clientes/pipeline` — status, etapas e colunas configuráveis |
| `POST` | `/api/clientes` — cadastro manual |
| `GET/PATCH/DELETE` | `/api/clientes/:id` |
| `POST` | `/api/clientes/:id/mover` · `/observacao` · `/pendencias` · `/tarefas` |
| `GET` | `/api/clientes/:id/timeline` |
| `POST` | `/api/clientes/:id/resumo` · `/assistente` · `/sugestoes` · `/sugestoes/aplicar` |

**Socket.IO** — servidor: `channels:snapshot`, `channel:update`, `buffer:update`,
`message:in`, `message:out`, `handoff`, `conversation:paused`.

---

## Dados sensíveis

Sigilo profissional e LGPD, não só higiene. `.gitignore` cobre:

- **`backend/sessions/`** — resquício das credenciais Baileys, que hoje vivem no
  MongoDB. A pasta continua ignorada porque instalações antigas ainda a têm, e
  quem tem esses arquivos assume a conta e lê as conversas dos clientes.
- **`JWT_SECRET`** — quem tem o segredo forja token de qualquer usuário.
- `.env` e variantes (exceto `*.example`), chaves e certificados
- `data/`, `uploads/`, `media/`, `logs/`, dumps do Mongo, builds

CPF, CNPJ, PIS, cartão e e-mail são mascarados **antes** de a mensagem sair para a
OpenAI. Áudio e imagem são processados em memória — nada de mídia é gravado em disco.

---

## Testes

```bash
cd backend && npm test    # 277 testes
```

Autenticação (hash, token, rotas protegidas) · agentes e resolução por número ·
buffer/debounce (11 cenários) · anti-loop ·
normalização multimodal · ontologia · base de conhecimento · guardrails de entrada
e saída · roteador · contrato das rotas HTTP.

Importação de planilha (21 testes) · três codificações com o mesmo resultado ·
cabeçalho fora da primeira linha · aspas e vírgulas dentro do campo · "SIM" não
vira status nem pendência · nenhuma coluna some sem destino.

Clientes (25 testes) · pipeline e kanban (nenhum status fora de coluna) ·
detecção de "como está meu processo" (inclusive com acento) · filtros da
carteira · a fronteira entre o que é interno e o que pode chegar ao cliente.

Sessão do WhatsApp (6 testes) · encerrar o servidor nunca desloga a conta ·
desconectar preserva a credencial · o painel decide "preciso de QR?" pelo banco.

LID (16 testes) · o telefone real sai de `senderPn`, nunca do identificador ·
sufixo de dispositivo · memória entre mensagens.

Curadoria (48 testes) · o tom de fábrica é formal e proíbe gíria · a regra de
cumprimentar uma vez só · saudação pura não paga extração de ontologia · a FAQ
não vai inteira em toda mensagem.

Curadoria · sanitização do que chega do navegador · validação antes de
publicar · comparação de versões · papéis e permissões · e o que mais importa: que
os **limites da advocacia sobrevivem** a qualquer configuração publicada, e que o
tempo de espera padrão de 8s preserva exatamente o comportamento anterior do
buffer — quem nunca abrir a curadoria continua com o atendimento que já tinha.

---

## Configuração

| Variável | Padrão | Efeito |
|---|---|---|
| `BUFFER_WINDOW_MS` | `8000` | silêncio antes de consolidar |
| `BUFFER_MAX_WAIT_MS` | `45000` | teto absoluto de espera |
| `BUFFER_MAX_MESSAGES` | `20` | máximo de mensagens por lote |
| `ANTILOOP_MAX_AUTO_INTERACTIONS` | `6` | interações automáticas antes de pausar |
| `ANTILOOP_MAX_REPEATS` | `3` | respostas nossas repetidas antes de pausar |
| `ANTILOOP_MIN_HUMAN_GAP_MS` | `1500` | piso de intervalo humano |
| `WHISPER_MODEL` | `whisper-1` | transcrição de áudio |
| `VISION_MODEL` | `gpt-4o-mini` | leitura de imagem |
| `KNOWLEDGE_BACKEND` | `memory` | `mongo` liga a busca semântica |
| `ONTOLOGY_RECENT_TURNS` | `6` | mensagens cruas no contexto |
| `GUARD_DAILY_TOKEN_BUDGET` | `40000` | teto por contato/dia |

Restante em [backend/.env.example](backend/.env.example).

O horário de atendimento em [firm.config.js](backend/src/domain/firm.config.js) está
como *segunda a sexta, 9h–18h* — ajuste para a rotina real antes de subir.

---

## Deploy no Railway

O repositório é um monorepo: não há `package.json` na raiz, então o Railpack não
consegue adivinhar o que construir a partir dela. **São dois serviços**, cada um
apontando para uma pasta.

### Backend

| Ajuste | Valor |
|---|---|
| **Root Directory** | `backend` |
| Build / Start | vêm de [backend/railway.json](backend/railway.json) |
| Healthcheck | `/health` |
| Porta do domínio | `3001` — não o `3000` que o Railway chuta |
| Replicas | **1** — ver abaixo |
| Volume | **não é necessário** |

**Não é preciso volume.** As credenciais do Baileys ficam no MongoDB
([auth.store.js](backend/src/whatsapp/auth.store.js)), não em disco — ver
[Por que o pareamento sobrevive ao restart](#por-que-o-pareamento-sobrevive-ao-restart).

**Uma réplica, ainda assim.** O motivo não é mais o disco: duas instâncias
falando pela mesma sessão Signal derrubam a conta de WhatsApp. Isso não mudou.

**O `backend/.env` não sobe.** Ele é gitignorado — corretamente, porque guarda a
chave da OpenAI e o segredo do JWT. Nada dali chega ao Railway: cada variável
precisa ser recriada em *Variables*, no serviço, inclusive a `MONGO_URI` que já
funciona na sua máquina.

Variáveis (as demais em [backend/.env.example](backend/.env.example)):

```
NODE_ENV=production
OPENAI_API_KEY=sk-...
MONGO_URI=...                      # Atlas ou o serviço Mongo do Railway
JWT_SECRET=...                     # node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
CORS_ORIGIN=https://SEU-FRONTEND.up.railway.app
```

A `MONGO_URI` do Atlas exige `0.0.0.0/0` em *Network Access*: o IP de saída do
Railway não é fixo, não há endereço para liberar. A senha passa a ser a única
defesa do cluster — longa, aleatória, exclusiva, e URL-encoded se tiver
caractere especial.

`PORT` o Railway injeta sozinho. `CORS_ORIGIN` é a origem exata do painel, com
`https://` e sem barra final: em produção a liberação de rede local está
desligada, então errar aqui vira `Failed to fetch` no navegador.

Depois do primeiro deploy, crie o acesso ao painel pelo shell do serviço:

```bash
npm run create:user -- voce@escritorio.com "sua-senha-forte" --admin
```

### Frontend

| Ajuste | Valor |
|---|---|
| **Root Directory** | `frontend` |
| Build / Start | vêm de [frontend/railway.json](frontend/railway.json) |
| Porta do domínio | `3000` |

O start é `next start -H ::`, não `npm start`. A rede privada do Railway é
IPv6-only e o `next start` sozinho escuta apenas em `0.0.0.0`: o proxy não acha
o socket e devolve 502 com o serviço marcado como online. É o mesmo motivo do
`host: '::'` no backend.

```
NEXT_PUBLIC_API_URL=https://SEU-BACKEND.up.railway.app
```

`NEXT_PUBLIC_*` entra no bundle **no build**, não em tempo de execução: mudar essa
variável exige redeploy do frontend, não só restart.

### Ordem

Suba o backend primeiro para conhecer a URL dele, aponte o frontend, e então volte
ao backend para preencher `CORS_ORIGIN` com a URL do painel.
