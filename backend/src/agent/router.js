const { DEFAULT_TIER_BY_ROLE } = require('./models.registry');
const { missingSlots } = require('../ontology/ontology.service');

/**
 * ROTEADOR DE TIERS
 * -----------------
 * Regra de custo: comece sempre no tier barato do papel (sol/luna) e escale
 * para TERRA apenas quando ha sinal objetivo de sensibilidade ou travamento.
 * A decisao usa a ontologia ja extraida pelo MINI, entao nao custa chamada extra.
 *
 * Num escritorio de advocacia o criterio nao e so complexidade: e o custo humano
 * de errar. Relato de assedio, gestante demitida ou pessoa fragilizada vao para
 * o tier caro mesmo sendo conversas curtas.
 */

/** Intencoes que pedem cuidado redobrado na formulacao da resposta. */
const ESCALATION_INTENTS = new Set([
  'pergunta_honorarios',
  'pergunta_valor_causa',
  'reclamacao_atendimento',
  'quer_falar_advogado',
]);

/** Tipos de caso sensiveis: envolvem saude, dignidade ou vulnerabilidade. */
const SENSITIVE_CASES = new Set([
  'assedio',
  'estabilidade_gestante',
  'estabilidade',
  'insalubridade',
  'justa_causa',
  'rescisao_indireta',
]);

function route({ role, baseTier, ontology = {}, inputFlags = [], messageCount = 0, text = '' }) {
  // O tier base vem do agente vinculado ao numero; o mapa por papel e o fallback.
  const base = baseTier || DEFAULT_TIER_BY_ROLE[role] || 'sol';
  const reasons = [];

  const intent = ontology.intent;
  const sentiment = ontology.sentiment;
  const slots = ontology.slots || {};

  if (intent && ESCALATION_INTENTS.has(intent)) reasons.push(`intencao:${intent}`);
  if (slots.tipo_caso && SENSITIVE_CASES.has(slots.tipo_caso)) {
    reasons.push(`caso_sensivel:${slots.tipo_caso}`);
  }
  if (sentiment === 'irritado' || sentiment === 'fragilizado') reasons.push(`humor:${sentiment}`);
  if (slots.satisfacao === 'baixa') reasons.push('cliente_insatisfeito');
  if (slots.risco_prescricao === 'proximo' || slots.risco_prescricao === 'possivel_prescrito') {
    reasons.push(`prescricao:${slots.risco_prescricao}`);
  }
  if ((slots.objecoes || []).length >= 2) reasons.push('objecoes_multiplas');
  if (text.length > 600) reasons.push('relato_extenso');
  if (inputFlags.includes('prompt_injection')) reasons.push('entrada_suspeita');

  // Conversa arrastando sem completar a triagem: algo travou, vale o tier caro.
  if (messageCount >= 14 && missingSlots(ontology, role).length > 0) {
    reasons.push('conversa_longa_sem_triagem');
  }

  if (reasons.length > 0) {
    return { tier: 'terra', reason: `escalonado(${reasons.join(',')})` };
  }

  // Saudacao pura no inicio: basta o tier do papel.
  if (intent === 'saudacao' && messageCount <= 1) {
    return { tier: base, reason: 'abertura' };
  }

  return { tier: base, reason: 'padrao' };
}

module.exports = { route, ESCALATION_INTENTS, SENSITIVE_CASES };
