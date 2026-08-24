const { NumberAssignment } = require('../models');
const {
  AGENTS,
  FALLBACK_AGENT_ID,
  getAgent,
  numberVariants,
  digitsOnly,
  resolveAgentByNumber,
} = require('./agents.config');
const logger = require('../utils/logger');

/**
 * Resolve numero -> agente somando duas fontes:
 *
 *   1. atribuicoes feitas no painel (MongoDB)   <- tem precedencia
 *   2. listas do agents.config.js               <- cadastro base
 *
 * O cache em memoria existe porque a resolucao acontece a cada mensagem
 * recebida; ir ao banco nesse caminho seria caro e desnecessario.
 */
const cache = new Map(); // numero (digitos) -> agentId
let loaded = false;

async function load() {
  try {
    const docs = await NumberAssignment.find().lean();
    cache.clear();
    for (const doc of docs) cache.set(doc.number, doc.agentId);
    loaded = true;
    logger.info({ atribuicoes: cache.size }, 'Atribuicoes de numero carregadas');
  } catch (error) {
    logger.warn({ err: error.message }, 'Falha ao carregar atribuicoes; usando so a configuracao');
  }
  return cache.size;
}

/** Procura o numero (e suas variantes) entre as atribuicoes do painel. */
function fromAssignments(value) {
  for (const variant of numberVariants(value)) {
    const agentId = cache.get(variant);
    if (agentId) return getAgent(agentId);
  }
  return null;
}

/**
 * @returns {{agent: object, matched: boolean, source: 'painel'|'config'|'fallback'}}
 */
function resolve(value) {
  const assigned = fromAssignments(value);
  if (assigned) return { agent: assigned, matched: true, source: 'painel' };

  const { agent, matched } = resolveAgentByNumber(value);
  return { agent, matched, source: matched ? 'config' : 'fallback' };
}

async function assign({ number, agentId, assignedBy, note }) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Agente desconhecido: ${agentId}`);
  if (agentId === FALLBACK_AGENT_ID) {
    throw new Error('Nao e possivel atribuir um numero ao agente inerte');
  }

  const normalized = digitsOnly(number);
  if (!normalized) throw new Error('Numero invalido');

  await NumberAssignment.findOneAndUpdate(
    { number: normalized },
    { $set: { agentId, assignedBy, note } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  cache.set(normalized, agentId);
  logger.info({ number: normalized, agentId, assignedBy }, 'Numero atribuido a um agente');

  return { number: normalized, agent };
}

async function unassign(number) {
  const normalized = digitsOnly(number);
  await NumberAssignment.deleteOne({ number: normalized });
  cache.delete(normalized);
  return { number: normalized };
}

/** Lista tudo o que existe hoje: config + painel, para diagnostico. */
async function list() {
  const doConfig = Object.values(AGENTS)
    .filter((a) => a.id !== FALLBACK_AGENT_ID)
    .flatMap((a) => a.numbers.map((n) => ({ number: digitsOnly(n), agentId: a.id, source: 'config' })));

  const doPainel = [...cache.entries()].map(([number, agentId]) => ({
    number,
    agentId,
    source: 'painel',
  }));

  // O painel sobrepoe a config quando o numero aparece nos dois.
  const porNumero = new Map();
  for (const item of [...doConfig, ...doPainel]) porNumero.set(item.number, item);
  return [...porNumero.values()];
}

module.exports = { load, resolve, assign, unassign, list, isLoaded: () => loaded };
