const {
  Channel,
  Message,
  AgentRun,
  Conversation,
  GuardrailEvent,
  ProcessedMessage,
} = require('../models');
const { PAUSED_STATUSES } = require('../conversation/conversation.service');
const { CANAL_TESTE } = require('../curadoria/sandbox.service');
const curadoria = require('../curadoria/config.service');
const { formatNumber } = require('../config/agents.config');

/**
 * SAUDE DOS NUMEROS
 * -----------------
 * A tela de Conexoes sempre respondeu "o numero esta conectado?". Essa nao e a
 * pergunta que importa: um numero pode estar conectado, verde, sem erro
 * nenhum — e nao responder ninguem. Aconteceu de tres jeitos diferentes ate
 * hoje: numero pareado sem agente atribuido, interruptor do agente desligado
 * por engano depois de um atendimento manual, e credencial perdida com o canal
 * tentando reconectar em silencio.
 *
 * Os tres tem o mesmo sintoma para quem opera (ninguem reclama, o WhatsApp
 * parece bem) e o mesmo custo (lead que escreveu e nao foi atendido).
 *
 * Este modulo responde a pergunta certa: **este numero esta atendendo?**
 * Junta o estado do socket, o vinculo com o agente e o que de fato aconteceu
 * nas ultimas 24h, e traduz em um nivel com MOTIVO — nunca um farol sem
 * explicacao, porque um alerta que nao diz o que fazer vira alerta ignorado.
 *
 * Nada aqui e escrito no banco: e leitura e julgamento sobre dados que outras
 * partes ja gravam.
 */

const JANELA_MS = 24 * 60 * 60 * 1000;
const HISTORICO_MS = 7 * 24 * 60 * 60 * 1000;

/** Ordem de gravidade. O nivel do canal e o pior sinal encontrado nele. */
const PESO = { critico: 3, atencao: 2, saudavel: 1, inativo: 0 };

const NIVEL_LABEL = {
  critico: 'Nao esta atendendo',
  atencao: 'Atende com ressalva',
  saudavel: 'Atendendo',
  inativo: 'Fora de operacao',
};

/**
 * Latencia media a partir da qual a conversa comeca a soar travada. Nao e
 * limite tecnico: e o ponto em que quem escreveu desiste e manda "?".
 */
const LATENCIA_ALTA_MS = 15_000;

/**
 * Motivos de descarte gravados pelo bridge em ProcessedMessage. O nome tecnico
 * nao serve para quem opera: "fora_expediente:fim_do_dia" nao explica por que a
 * pessoa nao recebeu resposta nenhuma.
 */
const MOTIVO_LEGIVEL = {
  fora_expediente: 'fora do expediente',
  atendimento_humano: 'contato em atendimento humano',
  agente_desligado_no_canal: 'agente desligado neste numero',
  agente_em_standby: 'agente em standby',
  loop_de_bot: 'suspeita de robo do outro lado',
  sem_conteudo: 'mensagem sem conteudo legivel',
  orcamento_contato_excedido: 'orcamento de tokens do contato',
  violacao_guardrail_saida: 'resposta barrada pelo guardrail',
};

/** "fora_expediente:fim_do_dia" -> "fora_expediente" */
const motivoBase = (reason) => String(reason || 'desconhecido').split(':')[0];

const sinal = (nivel, titulo, detalhe, comoResolver = null) => ({
  nivel,
  titulo,
  detalhe,
  comoResolver,
});

const pior = (sinais) =>
  sinais.reduce((atual, s) => (PESO[s.nivel] > PESO[atual] ? s.nivel : atual), 'saudavel');

// ------------------------------------------------------------------ coleta

/**
 * Uma passada por colecao, para os tres canais de uma vez. Consultar por canal
 * multiplicaria por tres o custo de uma tela que a equipe deixa aberta o dia
 * inteiro.
 *
 * A janela de mensagens e de 7 dias, nao aberta: precisamos do "ultima
 * mensagem em" mesmo quando o numero passou o dia calado, mas varrer a colecao
 * inteira para descobrir isso ficaria mais caro a cada mes de operacao. Sem
 * nada em 7 dias, o painel diz exatamente isso.
 */
async function coletar(desde, desdeHistorico) {
  const [docs, mensagens, execucoes, pausadas, guardrails, limites, descartadas] = await Promise.all([
    Channel.find().lean(),

    Message.aggregate([
      { $match: { createdAt: { $gte: desdeHistorico } } },
      {
        $group: {
          _id: { channelId: '$channelId', direction: '$direction' },
          ultima: { $max: '$createdAt' },
          total24h: { $sum: { $cond: [{ $gte: ['$createdAt', desde] }, 1, 0] } },
          porPessoa24h: {
            $sum: {
              $cond: [
                { $and: [{ $gte: ['$createdAt', desde] }, { $eq: ['$sentBy', 'human'] }] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),

    AgentRun.aggregate([
      { $match: { createdAt: { $gte: desde } } },
      {
        $group: {
          _id: '$channelId',
          execucoes: { $sum: 1 },
          falhas: { $sum: { $cond: [{ $eq: ['$ok', false] }, 1, 0] } },
          latenciaMediaMs: { $avg: '$latencyMs' },
          tokens: { $sum: '$totalTokens' },
        },
      },
    ]),

    Conversation.aggregate([
      { $match: { status: { $in: [...PAUSED_STATUSES] } } },
      { $group: { _id: '$sessionId', total: { $sum: 1 } } },
    ]),

    // Mesmo criterio do painel de uso: o canal ficticio da curadoria nao conta.
    // Guardrail disparado em teste e o sistema funcionando.
    GuardrailEvent.aggregate([
      { $match: { createdAt: { $gte: desde }, channelId: { $ne: CANAL_TESTE }, action: 'fallback' } },
      { $group: { _id: '$channelId', total: { $sum: 1 } } },
    ]),

    /**
     * Mensagens em que o agente foi CALADO por um limite de protecao, antes de
     * chegar a rodar: orcamento de tokens do contato, orcamento global do dia,
     * rate limit.
     *
     * Era o unico modo de falha completamente invisivel do sistema. O contato
     * recebe "vou pedir para alguem do time continuar com voce" e a conversa
     * morre ali; no painel, o numero segue conectado, verde, com o agente
     * ligado. Foi assim que uma pergunta perfeitamente atendivel virou um
     * atendimento perdido sem que ninguem soubesse por que.
     */
    GuardrailEvent.aggregate([
      {
        $match: {
          createdAt: { $gte: desde },
          channelId: { $ne: CANAL_TESTE },
          stage: 'input',
          rule: { $in: ['orcamento_contato', 'orcamento_global', 'rate_limit', 'handoff_humano_ativo'] },
        },
      },
      { $group: { _id: { channelId: '$channelId', rule: '$rule' }, total: { $sum: 1 } } },
    ]),

    /**
     * Mensagens que chegaram e foram DESCARTADAS antes do agente, com o motivo
     * exato — fora do expediente, contato em atendimento humano, agente
     * desligado no canal, standby, loop de bot.
     *
     * Este e o registro que responde "por que aquela mensagem nao foi
     * respondida?" sem depender de ler log de servidor. Cada caminho de
     * descarte no bridge ja gravava o motivo aqui; ninguem nunca leu.
     */
    ProcessedMessage.aggregate([
      { $match: { createdAt: { $gte: desde }, status: 'ignored' } },
      { $group: { _id: { channelId: '$channelId', reason: '$reason' }, total: { $sum: 1 } } },
    ]),
  ]);

  return { docs, mensagens, execucoes, pausadas, guardrails, limites, descartadas };
}

/** Texto do ultimo erro do agente, buscado so nos canais que de fato falharam. */
async function ultimoErro(channelId, desde) {
  const run = await AgentRun.findOne({ channelId, ok: false, createdAt: { $gte: desde } })
    .sort({ createdAt: -1 })
    .select('error createdAt')
    .lean()
    .catch(() => null);

  return run ? { mensagem: run.error, em: run.createdAt } : null;
}

// ---------------------------------------------------------------- diagnostico

/**
 * Traduz numeros em sinais que uma pessoa do escritorio entende e consegue
 * agir. Cada sinal responde tres coisas: o que esta acontecendo, por que isso
 * importa e o que fazer. Sinal sem a terceira parte e so barulho.
 */
function diagnosticar({
  estado,
  doc,
  volume,
  corrida,
  pausadas,
  bloqueios,
  calados = {},
  descartes = {},
  erro,
}) {
  const sinais = [];
  const conectado = estado.status === 'connected';
  const temCredenciais = Boolean(estado.hasCredentials);
  const agenteLigado = doc?.agentEnabled !== false;
  const agente = estado.agent || null;

  // ---------- conexao ----------
  if (estado.status === 'error') {
    sinais.push(
      sinal(
        'critico',
        'Canal em erro',
        estado.lastError || 'O canal parou apos varias tentativas de reconexao.',
        'Gere um QR novo. Se o erro voltar, verifique se o mesmo numero foi pareado em outro lugar.'
      )
    );
  }

  if (estado.status === 'logged_out') {
    sinais.push(
      sinal(
        'critico',
        'Sessao encerrada no celular',
        'Alguem removeu este aparelho em WhatsApp > Aparelhos conectados. O numero parou de atender no mesmo instante.',
        'Leia o QR novamente para reconectar.'
      )
    );
  }

  if (estado.status === 'connecting' || estado.status === 'qr') {
    sinais.push(
      sinal(
        'atencao',
        estado.status === 'qr' ? 'Aguardando leitura do QR' : 'Reconectando',
        'Enquanto isso o numero nao recebe nem responde mensagem.',
        estado.status === 'qr' ? 'Leia o QR no aparelho para concluir o pareamento.' : null
      )
    );
  }

  if (estado.status === 'disconnected' && temCredenciais) {
    sinais.push(
      sinal(
        'atencao',
        'Desconectado, mas ainda pareado',
        'As credenciais continuam salvas: reconectar nao exige QR novo.',
        'Use Reconectar no cartao do canal.'
      )
    );
  }

  if (estado.status === 'disconnected' && !temCredenciais && !doc?.phoneNumber) {
    sinais.push(
      sinal('inativo', 'Nunca pareado', 'Nenhum aparelho foi conectado a este canal ate agora.', 'Gere o QR quando quiser colocar o numero no ar.')
    );
  }

  /**
   * Numero que ja esteve pareado e nao tem mais credencial. Com as credenciais
   * no banco isso NAO deveria acontecer — se acontece, alguem trocou de banco
   * ou restaurou um dump antigo. O manager ja registra no log; aqui o aviso
   * chega a quem opera, que e quem percebe o silencio primeiro.
   */
  if (!temCredenciais && doc?.phoneNumber) {
    sinais.push(
      sinal(
        'critico',
        'Credenciais perdidas',
        `O numero ${formatNumber(doc.phoneNumber)} ja esteve pareado, mas nao ha mais credencial salva.`,
        'Leia o QR de novo e avise o time tecnico: pode ser troca ou restauracao de banco.'
      )
    );
  }

  // ---------- vinculo e interruptor ----------
  if (conectado && estado.phoneNumber && !agente?.matchedByNumber) {
    sinais.push(
      sinal(
        'critico',
        'Numero sem agente responsavel',
        'O numero conectou, mas nao esta atribuido a nenhum agente. Ele recebe as mensagens e nao responde nenhuma.',
        'Atribua o numero a um agente no proprio cartao do canal.'
      )
    );
  }

  if (conectado && !agenteLigado) {
    sinais.push(
      sinal(
        'critico',
        'Agente desligado neste numero',
        'O interruptor do cartao esta desligado: todas as conversas deste numero estao sem resposta automatica.',
        'Se foi para assumir um atendimento so, use o interruptor por pessoa em Conversas e religue este.'
      )
    );
  }

  if (conectado && agenteLigado && agente?.status === 'standby') {
    sinais.push(
      sinal(
        'atencao',
        'Agente em standby',
        `"${agente.label}" esta em standby na curadoria e nao responde, mesmo com o numero conectado.`,
        'Mude o status do agente em Curadoria quando quiser coloca-lo no ar.'
      )
    );
  }

  // ---------- o que aconteceu de verdade ----------
  const recebidas = volume.recebidas24h;
  const enviadas = volume.enviadas24h;

  if (conectado && recebidas > 0 && enviadas === 0) {
    sinais.push(
      sinal(
        'critico',
        'Recebe e nao responde',
        `${recebidas} mensagem(ns) chegaram nas ultimas 24h e nenhuma resposta saiu deste numero.`,
        'Confira o agente atribuido, o interruptor e as conversas pausadas abaixo.'
      )
    );
  }

  if (corrida.falhas > 0) {
    const taxa = corrida.execucoes ? corrida.falhas / corrida.execucoes : 1;
    sinais.push(
      sinal(
        taxa >= 0.2 ? 'critico' : 'atencao',
        `${corrida.falhas} falha(s) do agente em 24h`,
        `${corrida.falhas} de ${corrida.execucoes} respostas nao puderam ser geradas` +
          (erro?.mensagem ? `. Ultimo erro: ${erro.mensagem}` : '.') +
          ' Nessas conversas o contato recebeu a mensagem de erro e ficou marcado para atendimento humano.',
        'Erro de OpenAI costuma ser chave, credito ou instabilidade. Verifique com o time tecnico.'
      )
    );
  }

  /**
   * O agente foi calado por um limite de protecao ANTES de rodar. Para quem
   * escreveu, a conversa acabou ali; para o painel, o numero continuava
   * saudavel. E o modo de falha mais caro justamente por ser silencioso.
   */
  if (calados.orcamento_contato > 0) {
    sinais.push(
      sinal(
        'critico',
        `${calados.orcamento_contato} mensagem(ns) sem resposta por orcamento do contato`,
        'O limite diario de tokens por contato foi atingido e o agente parou de responder essas ' +
          'pessoas — elas receberam apenas o aviso de que alguem do time continuaria o atendimento.',
        'Aumente GUARD_DAILY_TOKEN_BUDGET. Como referencia: com as instrucoes atuais, cada resposta ' +
          'custa cerca de 8 mil tokens, entao uma triagem inteira nao cabe em 40 mil.'
      )
    );
  }

  if (calados.orcamento_global > 0) {
    sinais.push(
      sinal(
        'critico',
        `${calados.orcamento_global} mensagem(ns) sem resposta por orcamento do dia`,
        'O teto diario de tokens de TODA a operacao foi atingido: nenhum numero responde ate a ' +
          'virada do dia.',
        'Aumente GUARD_GLOBAL_DAILY_TOKEN_BUDGET ou verifique com o time tecnico o que consumiu o teto.'
      )
    );
  }

  /**
   * Contatos marcados como "atendimento humano" que continuam escrevendo e nao
   * recebem nada — nem do agente, nem de ninguem. So vira sinal quando NENHUMA
   * pessoa do escritorio respondeu por este numero nas ultimas 24h: com alguem
   * atendendo a mao, o silencio do agente e o comportamento correto.
   */
  if (calados.handoff_humano_ativo > 0 && volume.enviadasPorPessoa24h === 0) {
    sinais.push(
      sinal(
        'critico',
        `${calados.handoff_humano_ativo} mensagem(ns) sem resposta de ninguem`,
        'Sao contatos marcados como atendimento humano: o agente fica calado por definicao, mas ' +
          'nenhuma pessoa respondeu por este numero em 24h. Do lado de quem escreveu, o atendimento ' +
          'simplesmente parou.',
        'Abra as conversas pausadas e use Retomar para devolver o agente, ou assuma o atendimento.'
      )
    );
  }

  /**
   * Mensagens que chegaram e o agente nem tentou responder, com o motivo de
   * cada uma. E a resposta direta para "mandei mensagem e ninguem respondeu" —
   * a pergunta que ate agora so tinha resposta no log do servidor.
   *
   * Um sinal so, com a lista, em vez de um por motivo: a pessoa quer saber
   * quantas ficaram sem resposta e por que, nao ler cinco alertas parecidos.
   */
  const totalDescartes = Object.values(descartes).reduce((a, b) => a + b, 0);

  if (totalDescartes > 0) {
    const detalhado = Object.entries(descartes)
      .sort((a, b) => b[1] - a[1])
      .map(([motivo, total]) => `${MOTIVO_LEGIVEL[motivo] || motivo}: ${total}`)
      .join('; ');

    const soExpediente = Object.keys(descartes).every((m) => m === 'fora_expediente');

    sinais.push(
      sinal(
        soExpediente ? 'saudavel' : 'atencao',
        `${totalDescartes} mensagem(ns) recebidas sem resposta do agente`,
        `Motivos: ${detalhado}.` +
          (descartes.fora_expediente
            ? ' Fora do expediente o aviso de ausencia sai UMA vez por periodo — as mensagens ' +
              'seguintes ficam sem resposta nenhuma ate o expediente abrir.'
            : ''),
        soExpediente
          ? null
          : 'Cada motivo tem uma acao diferente: retomar a conversa, religar o interruptor do ' +
            'agente, tirar o agente de standby ou ampliar o expediente.'
      )
    );
  }

  if (calados.rate_limit > 0) {
    sinais.push(
      sinal(
        'atencao',
        `${calados.rate_limit} mensagem(ns) silenciadas por excesso de envios`,
        'Protecao contra rajada de mensagens do mesmo contato. Ocasional e normal; repetido pode ' +
          'ser alguem escrevendo muitas linhas seguidas e ficando sem resposta.',
        'Se acontecer com frequencia, reveja GUARD_RATE_LIMIT_MSGS e a janela do buffer.'
      )
    );
  }

  if (pausadas > 0) {
    sinais.push(
      sinal(
        'atencao',
        `${pausadas} conversa(s) pausada(s)`,
        'Pausa por suspeita de robo do outro lado ou por repasse ao time. O agente nao responde nelas ate alguem retomar.',
        'Reveja a lista de conversas pausadas e retome as que forem de pessoas.'
      )
    );
  }

  if (bloqueios > 0) {
    sinais.push(
      sinal(
        'atencao',
        `${bloqueios} resposta(s) bloqueada(s) pelo guardrail`,
        'A resposta violou os limites da advocacia mesmo apos a reescrita, e o contato recebeu a mensagem de encaminhamento.',
        'Se repetir, revise as instrucoes do agente na Curadoria: normalmente e o prompt pedindo algo que os limites proibem.'
      )
    );
  }

  if (corrida.latenciaMediaMs && corrida.latenciaMediaMs > LATENCIA_ALTA_MS) {
    sinais.push(
      sinal(
        'atencao',
        'Respostas lentas',
        `Media de ${Math.round(corrida.latenciaMediaMs / 100) / 10}s por resposta nas ultimas 24h. Acima de ${LATENCIA_ALTA_MS / 1000}s a pessoa costuma achar que ninguem viu.`,
        'Se persistir, e o modelo do tier ou a busca na internet. Assunto do time tecnico.'
      )
    );
  }

  if (conectado && recebidas === 0 && agenteLigado) {
    // Nao e defeito: numero novo, fim de semana, campanha parada. Entra como
    // observacao para a equipe nao ler "atendendo" e supor movimento que nao houve.
    sinais.push(
      sinal(
        'saudavel',
        'Sem mensagens nas ultimas 24h',
        volume.ultimaRecebidaEm
          ? `A ultima mensagem chegou em ${new Date(volume.ultimaRecebidaEm).toLocaleString('pt-BR')}.`
          : 'Nenhuma mensagem nos ultimos 7 dias.',
        null
      )
    );
  }

  return sinais;
}

// ------------------------------------------------------------------- avaliar

/**
 * @param {Array} estados projecoes publicas do manager (manager.listPublicStates())
 * @returns {Promise<{janela: string, resumo: object, canais: Array}>}
 */
async function avaliar(estados) {
  const agora = Date.now();
  const desde = new Date(agora - JANELA_MS);
  const desdeHistorico = new Date(agora - HISTORICO_MS);

  const { docs, mensagens, execucoes, pausadas, guardrails, limites, descartadas } = await coletar(
    desde,
    desdeHistorico
  );

  const porCanal = Object.fromEntries(docs.map((d) => [d.channelId, d]));
  const porPausa = Object.fromEntries(pausadas.map((p) => [p._id, p.total]));
  const porBloqueio = Object.fromEntries(guardrails.map((g) => [g._id, g.total]));
  const porCorrida = Object.fromEntries(execucoes.map((e) => [e._id, e]));

  /** channelId -> { orcamento_contato: n, rate_limit: n, ... } */
  const porCalado = {};
  for (const linha of limites) {
    const { channelId, rule } = linha._id;
    porCalado[channelId] = porCalado[channelId] || {};
    porCalado[channelId][rule] = linha.total;
  }

  /** channelId -> { fora_expediente: n, atendimento_humano: n, ... } */
  const porDescarte = {};
  for (const linha of descartadas) {
    const { channelId, reason } = linha._id;
    const motivo = motivoBase(reason);
    porDescarte[channelId] = porDescarte[channelId] || {};
    porDescarte[channelId][motivo] = (porDescarte[channelId][motivo] || 0) + linha.total;
  }

  const porMensagem = {};
  for (const linha of mensagens) {
    const { channelId, direction } = linha._id;
    porMensagem[channelId] = porMensagem[channelId] || {};
    porMensagem[channelId][direction] = linha;
  }

  const canais = [];

  for (const estado of estados) {
    const doc = porCanal[estado.id];
    const entrada = porMensagem[estado.id]?.in;
    const saida = porMensagem[estado.id]?.out;

    const volume = {
      recebidas24h: entrada?.total24h || 0,
      enviadas24h: saida?.total24h || 0,
      enviadasPorPessoa24h: saida?.porPessoa24h || 0,
      ultimaRecebidaEm: entrada?.ultima || null,
      ultimaRespondidaEm: saida?.ultima || null,
    };

    const corrida = {
      execucoes: porCorrida[estado.id]?.execucoes || 0,
      falhas: porCorrida[estado.id]?.falhas || 0,
      latenciaMediaMs: porCorrida[estado.id]?.latenciaMediaMs || null,
      tokens: porCorrida[estado.id]?.tokens || 0,
    };

    const erro = corrida.falhas > 0 ? await ultimoErro(estado.id, desde) : null;

    const sinais = diagnosticar({
      estado,
      doc,
      volume,
      corrida,
      pausadas: porPausa[estado.id] || 0,
      bloqueios: porBloqueio[estado.id] || 0,
      calados: porCalado[estado.id] || {},
      descartes: porDescarte[estado.id] || {},
      erro,
    });

    const nivel = pior(sinais);

    canais.push({
      id: estado.id,
      label: estado.label,
      role: estado.role,
      status: estado.status,
      phoneNumber: estado.phoneNumber,
      phoneFormatted: estado.phoneFormatted,
      pushName: estado.pushName,
      nivel,
      nivelLabel: NIVEL_LABEL[nivel],
      sinais,
      agente: estado.agent
        ? {
            ...estado.agent,
            // O status que vale e o da curadoria: o painel pode ter colocado o
            // agente em standby depois que o vinculo foi resolvido.
            status: curadoria.statusEfetivo(estado.agent.id),
            ligado: doc?.agentEnabled !== false,
          }
        : null,
      conexao: {
        temCredenciais: Boolean(estado.hasCredentials),
        conectadoDesde: doc?.lastConnectedAt || null,
        desconectadoEm: doc?.lastDisconnectedAt || null,
        tempoConectadoMs:
          estado.status === 'connected' && doc?.lastConnectedAt
            ? agora - new Date(doc.lastConnectedAt).getTime()
            : null,
        ultimoErro: estado.lastError || null,
      },
      volume24h: {
        ...volume,
        execucoes: corrida.execucoes,
        falhas: corrida.falhas,
        tokens: corrida.tokens,
        latenciaMediaMs: corrida.latenciaMediaMs,
      },
      conversasPausadas: porPausa[estado.id] || 0,
      respostasBloqueadas24h: porBloqueio[estado.id] || 0,
      // Mensagens que nem chegaram ao agente, por limite de protecao.
      caladasPorLimite24h: Object.values(porCalado[estado.id] || {}).reduce((a, b) => a + b, 0),
      // ...e as descartadas antes dele, com o motivo de cada uma. E aqui que se
      // responde "mandei mensagem e ninguem respondeu" sem abrir log nenhum.
      semRespostaPorMotivo24h: porDescarte[estado.id] || {},
    });
  }

  const resumo = { saudavel: 0, atencao: 0, critico: 0, inativo: 0 };
  for (const canal of canais) resumo[canal.nivel] += 1;

  return {
    janela: '24h',
    verificadoEm: new Date(agora).toISOString(),
    resumo,
    // Pior primeiro: quem abre a tela precisa ver o problema antes do resto.
    canais: canais.sort((a, b) => PESO[b.nivel] - PESO[a.nivel]),
  };
}

module.exports = { avaliar, diagnosticar, NIVEL_LABEL, LATENCIA_ALTA_MS, PESO };
