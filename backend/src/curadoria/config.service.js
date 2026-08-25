const { AgentConfig, AgentConfigVersion } = require('../models');
const { getAgent, listAgents, AGENT_STATUS } = require('../config/agents.config');
const { padraoDoAgente, sanitizar } = require('./config.schema');
const { validar } = require('./validator');
const { comparar, resumir } = require('./diff');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');

/**
 * SERVICO DA CURADORIA
 * --------------------
 * Guarda o estado das configuracoes e serve a versao publicada para o
 * atendimento em tempo real.
 *
 * CACHE. `publicada()` e chamada em todo turno de conversa, no caminho quente.
 * Ir ao Mongo ali somaria uma ida ao banco por mensagem, entao o resultado
 * fica em memoria e so e invalidado por publicacao, restauracao ou mudanca de
 * status - as tres operacoes que alteram o que esta no ar.
 *
 * O cache e por processo. Isso e seguro aqui porque o deploy roda com UMA
 * replica (exigencia da sessao do Baileys, ver README). Se um dia houver mais
 * de uma instancia, publicar precisara avisar as outras - um canal do Mongo ou
 * do socket resolve, e o unico ponto a mudar e invalidar().
 *
 * DEGRADACAO. Banco fora nao pode derrubar atendimento: `publicada()` cai para
 * o padrao do codigo, que e exatamente o comportamento anterior a esta
 * interface. Pior caso, o escritorio atende com a configuracao de fabrica.
 */

/** agentId -> configuracao publicada ja sanitizada */
const cache = new Map();
/** agentId -> 'active' | 'standby' definido no painel */
const cacheStatus = new Map();
let carregado = false;

const usuarioResumo = (usuario) => ({
  id: usuario?.id || null,
  email: usuario?.email || null,
  nome: usuario?.nome || usuario?.name || null,
});

// ------------------------------------------------------------------ leitura

/** Carrega tudo o que esta publicado. Roda uma vez no boot, antes de qualquer canal subir. */
async function carregar() {
  try {
    const docs = await AgentConfig.find().lean();
    cache.clear();
    cacheStatus.clear();

    for (const doc of docs) {
      if (doc.publicada) cache.set(doc.agentId, sanitizar(doc.publicada, doc.agentId));
      if (doc.status) cacheStatus.set(doc.agentId, doc.status);
    }

    carregado = true;
    logger.info({ configuracoes: cache.size }, 'Configuracoes de curadoria carregadas');
  } catch (error) {
    logger.warn(
      { err: error.message },
      'Falha ao carregar curadoria; agentes seguem com a configuracao de fabrica'
    );
  }
  return cache.size;
}

/**
 * A configuracao que o atendimento deve usar AGORA.
 * Sincrona de proposito: e chamada dentro do pipeline do agente.
 */
function publicada(agentId) {
  return cache.get(agentId) || padraoDoAgente(agentId);
}

/** Ativo/standby efetivo: o painel manda, o arquivo e o cadastro base. */
function statusEfetivo(agentId) {
  return cacheStatus.get(agentId) || getAgent(agentId)?.status || AGENT_STATUS.DISABLED;
}

const estaAtivo = (agentId) => statusEfetivo(agentId) === AGENT_STATUS.ACTIVE;

function invalidar(agentId, config, status) {
  if (config) cache.set(agentId, config);
  if (status) cacheStatus.set(agentId, status);
}

// ------------------------------------------------------------- documento

async function documento(agentId) {
  const doc = await AgentConfig.findOneAndUpdate(
    { agentId },
    { $setOnInsert: { agentId } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return doc;
}

/**
 * Estado completo de um agente para a tela de curadoria.
 *
 * `publicada` nunca volta null: quando nada foi publicado ainda, volta o
 * padrao do codigo. Assim a comparacao "antes x depois" funciona desde a
 * primeira edicao, em vez de mostrar um lado vazio.
 */
async function obter(agentId) {
  const agente = getAgent(agentId);
  if (!agente) return null;

  const doc = await documento(agentId);
  const noAr = doc.publicada ? sanitizar(doc.publicada, agentId) : padraoDoAgente(agentId);
  const rascunho = doc.rascunho ? sanitizar(doc.rascunho, agentId) : null;

  return {
    agente: {
      id: agente.id,
      label: agente.label,
      descricao: agente.description,
      numeros: agente.numbers,
      status: statusEfetivo(agentId),
      statusOrigem: cacheStatus.has(agentId) ? 'painel' : 'config',
    },
    publicada: noAr,
    nuncaPublicada: !doc.publicada,
    versao: doc.versaoPublicada || 0,
    publicadaEm: doc.publicadaEm || null,
    publicadaPor: doc.publicadaPor || null,
    rascunho,
    temRascunho: Boolean(rascunho),
    rascunhoEm: doc.rascunhoEm || null,
    rascunhoPor: doc.rascunhoPor || null,
    alteracoes: rascunho ? comparar(noAr, rascunho) : [],
  };
}

/** Lista para a tela inicial da curadoria. */
async function listar() {
  const docs = await AgentConfig.find().lean();
  const porId = Object.fromEntries(docs.map((d) => [d.agentId, d]));

  return listAgents().map((agente) => {
    const doc = porId[agente.id];
    return {
      id: agente.id,
      label: agente.label,
      descricao: agente.description,
      numeros: agente.numbers,
      status: statusEfetivo(agente.id),
      versao: doc?.versaoPublicada || 0,
      nuncaPublicada: !doc?.publicada,
      temRascunho: Boolean(doc?.rascunho),
      rascunhoEm: doc?.rascunhoEm || null,
      rascunhoPor: doc?.rascunhoPor?.nome || doc?.rascunhoPor?.email || null,
      publicadaEm: doc?.publicadaEm || null,
      publicadaPor: doc?.publicadaPor?.nome || doc?.publicadaPor?.email || null,
    };
  });
}

// -------------------------------------------------------------- rascunho

async function salvarRascunho(agentId, entrada, usuario) {
  const limpa = sanitizar(entrada, agentId);

  const doc = await AgentConfig.findOneAndUpdate(
    { agentId },
    {
      $set: { rascunho: limpa, rascunhoEm: new Date(), rascunhoPor: usuarioResumo(usuario) },
      $setOnInsert: { agentId },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const noAr = doc.publicada ? sanitizar(doc.publicada, agentId) : padraoDoAgente(agentId);

  logger.info(
    { ev: EV.CURADORIA_RASCUNHO_SALVO, agentId, por: usuario?.email },
    'Rascunho de curadoria salvo'
  );

  return {
    rascunho: limpa,
    alteracoes: comparar(noAr, limpa),
    rascunhoEm: doc.rascunhoEm,
    validacao: validar(limpa, doc.publicada ? noAr : null),
  };
}

async function descartarRascunho(agentId, usuario) {
  await AgentConfig.updateOne(
    { agentId },
    { $set: { rascunho: null, rascunhoEm: null, rascunhoPor: null } }
  );

  logger.info(
    { ev: EV.CURADORIA_RASCUNHO_DESCARTADO, agentId, por: usuario?.email },
    'Rascunho de curadoria descartado'
  );

  return obter(agentId);
}

// ------------------------------------------------------------- publicacao

/**
 * Grava a versao com numero proprio, tolerando corrida.
 *
 * Duas publicacoes simultaneas leem o mesmo `versaoPublicada` e tentam gravar
 * o mesmo numero; o indice unico (agentId, versao) reprova a segunda, que
 * tenta de novo com o proximo. Sem isso, uma das duas sumiria do historico -
 * e historico com buraco e pior que historico nenhum, porque ninguem
 * desconfia dele.
 */
async function gravarVersao({ agentId, config, alteracoes, nota, usuario, restauradaDe, tentativa = 0 }) {
  const ultima = await AgentConfigVersion.findOne({ agentId }).sort({ versao: -1 }).lean();
  const versao = (ultima?.versao || 0) + 1;

  try {
    return await AgentConfigVersion.create({
      agentId,
      versao,
      config,
      alteracoes,
      nota: nota || resumir(alteracoes),
      publicadaPor: usuarioResumo(usuario),
      restauradaDe: restauradaDe ?? null,
    });
  } catch (error) {
    if (error.code === 11000 && tentativa < 5) {
      return gravarVersao({
        agentId,
        config,
        alteracoes,
        nota,
        usuario,
        restauradaDe,
        tentativa: tentativa + 1,
      });
    }
    throw error;
  }
}

/**
 * Rascunho -> producao.
 *
 * @returns {{ok: boolean, validacao?: object, versao?: number}}
 *          `ok: false` traz a validacao para a tela explicar o que corrigir.
 */
async function publicar(agentId, usuario, nota) {
  const doc = await documento(agentId);
  if (!doc.rascunho) return { ok: false, semRascunho: true };

  const config = sanitizar(doc.rascunho, agentId);
  const anterior = doc.publicada ? sanitizar(doc.publicada, agentId) : padraoDoAgente(agentId);

  const validacao = validar(config, doc.publicada ? anterior : null);
  if (!validacao.ok) return { ok: false, validacao };

  const alteracoes = comparar(anterior, config);
  const versao = await gravarVersao({ agentId, config, alteracoes, nota, usuario });

  await AgentConfig.updateOne(
    { agentId },
    {
      $set: {
        publicada: config,
        versaoPublicada: versao.versao,
        publicadaEm: versao.createdAt,
        publicadaPor: usuarioResumo(usuario),
        rascunho: null,
        rascunhoEm: null,
        rascunhoPor: null,
      },
    }
  );

  invalidar(agentId, config);

  logger.info(
    {
      ev: EV.CURADORIA_PUBLICADA,
      agentId,
      versao: versao.versao,
      alteracoes: alteracoes.length,
      por: usuario?.email,
    },
    'Configuracao de agente publicada'
  );

  return { ok: true, versao: versao.versao, alteracoes, validacao };
}

// -------------------------------------------------------------- historico

async function versoes(agentId, limite = 50) {
  const docs = await AgentConfigVersion.find({ agentId })
    .sort({ versao: -1 })
    .limit(Math.min(200, Math.max(1, limite)))
    .select('-config') // a lista nao precisa do snapshot inteiro
    .lean();

  return docs.map((d) => ({
    versao: d.versao,
    nota: d.nota,
    alteracoes: d.alteracoes,
    publicadaEm: d.createdAt,
    publicadaPor: d.publicadaPor?.nome || d.publicadaPor?.email || 'desconhecido',
    restauradaDe: d.restauradaDe,
  }));
}

async function versao(agentId, numero) {
  const doc = await AgentConfigVersion.findOne({ agentId, versao: Number(numero) }).lean();
  if (!doc) return null;

  return {
    versao: doc.versao,
    config: sanitizar(doc.config, agentId),
    alteracoes: doc.alteracoes,
    nota: doc.nota,
    publicadaEm: doc.createdAt,
    publicadaPor: doc.publicadaPor?.nome || doc.publicadaPor?.email || 'desconhecido',
    restauradaDe: doc.restauradaDe,
  };
}

/**
 * Volta o agente a uma versao anterior, publicando o snapshot como versao nova.
 *
 * Restaurar NAO reescreve o historico: a versao 12 continua sendo a 12, e a
 * volta a ela vira a 15, marcada com `restauradaDe: 12`. Apagar o que veio
 * depois esconderia justamente o erro que motivou a restauracao.
 *
 * O rascunho em aberto e preservado. Quem restaura costuma estar apagando um
 * incendio; destruir de quebra o trabalho de outra pessoa seria um segundo
 * incidente.
 */
async function restaurar(agentId, numero, usuario) {
  const alvo = await versao(agentId, numero);
  if (!alvo) return { ok: false, naoEncontrada: true };

  const doc = await documento(agentId);
  const atual = doc.publicada ? sanitizar(doc.publicada, agentId) : padraoDoAgente(agentId);

  const alteracoes = comparar(atual, alvo.config);
  const nova = await gravarVersao({
    agentId,
    config: alvo.config,
    alteracoes,
    nota: `Restauracao da versao ${alvo.versao}`,
    usuario,
    restauradaDe: alvo.versao,
  });

  await AgentConfig.updateOne(
    { agentId },
    {
      $set: {
        publicada: alvo.config,
        versaoPublicada: nova.versao,
        publicadaEm: nova.createdAt,
        publicadaPor: usuarioResumo(usuario),
      },
    }
  );

  invalidar(agentId, alvo.config);

  logger.info(
    { ev: EV.CURADORIA_RESTAURADA, agentId, de: alvo.versao, versao: nova.versao, por: usuario?.email },
    'Configuracao de agente restaurada'
  );

  return { ok: true, versao: nova.versao, restauradaDe: alvo.versao, alteracoes };
}

// ----------------------------------------------------------------- status

async function definirStatus(agentId, status, usuario) {
  if (![AGENT_STATUS.ACTIVE, AGENT_STATUS.STANDBY].includes(status)) {
    throw new Error('Status invalido');
  }

  await AgentConfig.updateOne(
    { agentId },
    { $set: { status }, $setOnInsert: { agentId } },
    { upsert: true }
  );

  invalidar(agentId, null, status);

  logger.info(
    { ev: EV.CURADORIA_STATUS_ALTERADO, agentId, status, por: usuario?.email },
    'Status de agente alterado no painel'
  );

  return { agentId, status };
}

module.exports = {
  carregar,
  publicada,
  statusEfetivo,
  estaAtivo,
  obter,
  listar,
  salvarRascunho,
  descartarRascunho,
  publicar,
  versoes,
  versao,
  restaurar,
  definirStatus,
  isCarregado: () => carregado,
};
