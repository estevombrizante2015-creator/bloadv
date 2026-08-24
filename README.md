# whatsAgent — Barbosa, Loli e Oliveira Sociedade de Advogados

Atendimento por WhatsApp com múltiplos números conectados por QR (Baileys), agente
multimodal na **OpenAI** (texto + Whisper + visão), persistência em **MongoDB**,
contexto comprimido por **ontologia**, **guardrails** calibrados para os limites da
advocacia e proteção contra **bot × bot**.

## Agentes

| Agente | Status | Números | Papel |
|---|---|---|---|
| **Captação de Leads** (`lead_capture`) | 🟢 ativo | `+55 19 99638-3884`, `+55 11 94006-1595` | atendimento inicial e triagem |
| **Clientes** (`customer_agent`) | 🟡 standby | — | acompanhamento de caso em andamento |

O agente de clientes existe por inteiro — roteamento, papel, ontologia, persona —
mas em `standby`: nunca assume atendimento até virar `active`. Para adicionar um
número, inclua-o na lista do agente em
[agents.config.js](backend/src/config/agents.config.js). Não há `if numero === X`
em nenhum outro lugar do código.

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
```

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

**Socket.IO** — servidor: `channels:snapshot`, `channel:update`, `buffer:update`,
`message:in`, `message:out`, `handoff`, `conversation:paused`.

---

## Dados sensíveis

Sigilo profissional e LGPD, não só higiene. `.gitignore` cobre:

- **`backend/sessions/`** — credenciais Baileys. Quem tem esses arquivos assume a
  conta e lê as conversas dos clientes.
- **`JWT_SECRET`** — quem tem o segredo forja token de qualquer usuário.
- `.env` e variantes (exceto `*.example`), chaves e certificados
- `data/`, `uploads/`, `media/`, `logs/`, dumps do Mongo, builds

CPF, CNPJ, PIS, cartão e e-mail são mascarados **antes** de a mensagem sair para a
OpenAI. Áudio e imagem são processados em memória — nada de mídia é gravado em disco.

---

## Testes

```bash
cd backend && npm test    # 93 testes
```

Autenticação (hash, token, rotas protegidas) · agentes e resolução por número ·
buffer/debounce (11 cenários) · anti-loop ·
normalização multimodal · ontologia · base de conhecimento · guardrails de entrada
e saída · roteador · contrato das rotas HTTP.

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
