const openaiService = require('../agent/openai.service');
const { getTier } = require('../agent/models.registry');
const { buildInstructions } = require('../agent/prompt.builder');
const router = require('../agent/router');
const ontologyService = require('../ontology/ontology.service');
const knowledgeRepository = require('../domain/knowledge.repository');
const knowledgeService = require('../domain/knowledge.service');
const inputGuard = require('../guardrails/input.guard');
const outputGuard = require('../guardrails/output.guard');
const { getAgent } = require('../config/agents.config');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');

/**
 * AMBIENTE DE TESTE ("Testar agente")
 * -----------------------------------
 * Conversa com o agente usando o RASCUNHO, antes de publicar, sem tocar em
 * nenhum contato real.
 *
 * O que torna o teste confiavel e o que ele NAO faz por conta propria: nao
 * monta prompt, nao aplica regra, nao decide tier. Tudo isso vem dos mesmos
 * modulos da producao - prompt.builder, router, guardrails, base de
 * conhecimento. Um ensaio com pipeline proprio responderia bonito e mentiria
 * sobre o que vai acontecer no WhatsApp.
 *
 * As diferencas em relacao ao atendimento real sao tres, e todas de fora do
 * comportamento:
 *
 *   1. nada e gravado em Contact, Message, AgentRun ou Conversation;
 *   2. nada e enviado por WhatsApp;
 *   3. os tokens nao entram na cota diaria do contato (nao existe contato).
 *
 * ESTADO. A sessao de teste vive no NAVEGADOR: o painel devolve historico e
 * ontologia a cada turno. Guardar sessao em memoria no servidor traria
 * vazamento lento e sessao perdida a cada deploy, para nada - a conversa de
 * teste e curta e so interessa a quem esta com a tela aberta.
 */

/**
 * Canal ficticio. Existe para que os eventos de guardrail gerados em teste
 * sejam identificaveis e possam ser excluidos das metricas do painel - um
 * teste nao pode aparecer como violacao do atendimento real.
 */
const CANAL_TESTE = 'curadoria-teste';

const MAX_HISTORICO = 20;

/** Historico vindo do navegador: forma e tamanho conferidos antes de qualquer uso. */
function normalizarHistorico(historico) {
  if (!Array.isArray(historico)) return [];
  return historico
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .slice(-MAX_HISTORICO)
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      text: String(m.text).slice(0, 4000),
    }));
}

/**
 * Um turno de conversa de teste.
 *
 * @param {object} args
 * @param {string} args.agentId
 * @param {object} args.config     configuracao a testar (rascunho ou publicada)
 * @param {string} args.mensagem   o que o curador escreveu
 * @param {Array}  args.historico  [{role, text}] dos turnos anteriores
 * @param {object} args.ontologia  estado acumulado nesta sessao de teste
 * @param {object} args.usuario    quem esta testando (so para log)
 * @returns {object} resposta, tier, ontologia atualizada e diagnostico
 */
async function conversar({ agentId, config, mensagem, historico, ontologia, usuario }) {
  const iniciadoEm = Date.now();
  const agente = getAgent(agentId);
  if (!agente) return { ok: false, erro: 'Agente desconhecido' };

  const texto = String(mensagem || '').trim();
  if (!texto) return { ok: false, erro: 'Escreva uma mensagem para testar' };

  const role = agente.role;
  const turnos = normalizarHistorico(historico);

  // Sessao propria por curador: o limite de mensagens por minuto do guardrail
  // de entrada e por conversa, e duas pessoas testando ao mesmo tempo nao
  // podem se atrapalhar.
  const jid = `teste-${usuario?.id || 'anonimo'}@curadoria`;

  const estadoAnterior = ontologia && typeof ontologia === 'object' ? ontologia : { version: 1, slots: {}, facts: [] };
  const contatoFicticio = { messageCount: turnos.length, ontology: estadoAnterior, tokenUsage: null };

  // ---------- 1. guardrail de entrada (o mesmo da producao) ----------
  const guard = await inputGuard.check({
    channelId: CANAL_TESTE,
    jid,
    text: texto,
    type: 'text',
    contact: contatoFicticio,
  });

  if (!guard.allow) {
    return {
      ok: true,
      bloqueado: true,
      resposta: guard.silent ? null : guard.reply,
      motivoBloqueio: guard.flags,
      ontologia: estadoAnterior,
      diagnostico: {
        explicacao:
          'O guardrail de entrada barrou esta mensagem antes de chegar ao agente. ' +
          'No atendimento real aconteceria o mesmo.',
        sinais: guard.flags,
      },
    };
  }

  const safeText = guard.text;

  // ---------- 2. ontologia ----------
  // Mesmo criterio da producao: uma saudacao pura nao paga uma chamada de
  // modelo para extrair nada. Se o teste extraisse sempre, ele mostraria um
  // estado que a conversa real nao teria.
  const { delta } = ontologyService.valeExtrair(safeText)
    ? await ontologyService
        .extract({
          openaiService,
          role,
          currentOntology: estadoAnterior,
          recentMessages: turnos,
          userText: safeText,
        })
        .catch(() => ({ delta: null }))
    : { delta: null };

  const estadoAtual = delta ? ontologyService.merge(estadoAnterior, delta, role) : estadoAnterior;

  // ---------- 3. roteamento ----------
  const decisao = router.route({
    role,
    baseTier: agente.tier,
    ontology: estadoAnterior,
    inputFlags: guard.flags,
    messageCount: turnos.length + 1,
    text: safeText,
  });

  // ---------- 4. contexto ----------
  const { contextBlock, turns, missing } = ontologyService.buildContext({
    ontology: estadoAnterior,
    role,
    rollingSummary: null,
    recentMessages: turnos,
    allMessagesCount: turnos.length,
  });

  const tipoCaso = estadoAnterior?.slots?.tipo_caso;
  const knowledge = await knowledgeRepository
    .search({ query: safeText, tipoCaso })
    .catch(() => ({ block: null, topics: [] }));

  // ---------- 5. prompt: exatamente o mesmo construtor da producao ----------
  const instructions = buildInstructions({
    config,
    primeiroContato: turnos.length === 0,
    contextBlock,
    missing,
    sugestaoPergunta: missing.length ? knowledgeRepository.suggestedQuestion(tipoCaso) : null,
    knowledge,
    // Busca na internet fica de fora do teste: ela depende do que a internet
    // responde hoje, e uma resposta que muda sozinha entre dois testes faz o
    // curador achar que a configuracao dele e instavel.
    web: null,
    unidadesBlock: knowledgeService.asksLocation(safeText) ? knowledgeService.locationBlock() : null,
    partsCount: 1,
    tipos: ['text'],
    falhaMidia: false,
    injection: guard.injection,
    escalonado: decisao.tier === 'terra' && agente.tier !== 'terra',
    textoDoContato: safeText,
  });

  const system = instructions.join('\n\n');
  const chatMessages = turns.map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.text,
  }));

  // ---------- 6. geracao ----------
  let geracao;
  try {
    geracao = await openaiService.complete({
      tier: decisao.tier,
      purpose: 'curadoria_teste',
      system,
      messages: chatMessages,
      user: safeText,
    });
  } catch (error) {
    logger.warn({ ev: EV.CURADORIA_TESTE, agentId, err: error.message }, 'Teste de curadoria falhou');
    return {
      ok: false,
      erro:
        'Nao consegui gerar a resposta agora. Isso e uma falha do servico de IA, nao da sua ' +
        'configuracao. Tente de novo em alguns segundos.',
    };
  }

  // ---------- 7. guardrail de saida (o mesmo da producao) ----------
  const veredito = await outputGuard.check({
    channelId: CANAL_TESTE,
    jid,
    text: geracao.text,
    regenerate: async (corretivo) => {
      const segunda = await openaiService.complete({
        tier: decisao.tier,
        purpose: 'curadoria_teste_retry',
        system: `${system}\n\n[CORRECAO]\n${corretivo}`,
        messages: chatMessages,
        user: safeText,
      });
      return segunda.text;
    },
  });

  logger.info(
    {
      ev: EV.CURADORIA_TESTE,
      agentId,
      tier: decisao.tier,
      por: usuario?.email,
      violacoes: veredito.violations,
    },
    'Teste de curadoria executado'
  );

  return {
    ok: true,
    resposta: veredito.text,
    ontologia: estadoAtual,
    diagnostico: {
      // Nada aqui e nome de modelo, chave ou endpoint: e o que ajuda a
      // entender POR QUE o agente respondeu assim.
      cuidadoRedobrado: decisao.tier === 'terra',
      motivoDoCuidado: decisao.tier === 'terra' ? decisao.reason : null,
      faltaDescobrir: missing,
      baseConsultada: knowledge.topics || [],
      reescrita: veredito.retried,
      violacoes: veredito.violations,
      encaminhado: veredito.handoff,
      latenciaMs: Date.now() - iniciadoEm,
    },
    instrucoes: system,
  };
}

module.exports = { conversar, CANAL_TESTE };
