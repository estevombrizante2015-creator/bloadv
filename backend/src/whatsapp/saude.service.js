const { Channel, Message, AgentRun, Conversation, GuardrailEvent } = require('../models');
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
  const [docs, mensagens, execucoes, pausadas, guardrails] = await Promise.all([
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
  ]);

  return { docs, mensagens, execucoes, pausadas, guardrails };
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
function diagnosticar({ estado, doc, volume, corrida, pausadas, bloqueios, erro }) {
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

  const { docs, mensagens, execucoes, pausadas, guardrails } = await coletar(desde, desdeHistorico);

  const porCanal = Object.fromEntries(docs.map((d) => [d.channelId, d]));
  const porPausa = Object.fromEntries(pausadas.map((p) => [p._id, p.total]));
  const porBloqueio = Object.fromEntries(guardrails.map((g) => [g._id, g.total]));
  const porCorrida = Object.fromEntries(execucoes.map((e) => [e._id, e]));

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
