const { env } = require('../config/env');
const { KnowledgeChunk } = require('../models');
const { KNOWLEDGE } = require('./knowledge.base');
const localSearch = require('./knowledge.service');
const embeddings = require('./embeddings.service');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');

/**
 * REPOSITORIO DA BASE DE CONHECIMENTO
 * -----------------------------------
 * Dois backends por tras da mesma interface `search()`:
 *
 *   memory (padrao) -> verbetes locais + casamento por tipo_caso/palavra-chave.
 *                      Zero infra, zero latencia, zero custo. Funciona hoje.
 *
 *   mongo           -> Atlas Vector Search sobre a colecao knowledge_chunks.
 *                      Ativa com KNOWLEDGE_BACKEND=mongo depois de rodar o seed.
 *
 * O pipeline do agente nao sabe qual esta ativo. Trocar de backend e mudar
 * uma variavel de ambiente - se a busca vetorial falhar (indice ainda nao
 * construido, cluster fora, embedding indisponivel), cai sozinha para a local
 * em vez de deixar o agente sem contexto.
 */

const usingMongo = () => env.knowledge.backend === 'mongo';

/** Formata os verbetes escolhidos no bloco que entra no prompt. */
function renderBlock(entries) {
  return entries.map((e) => `- ${e.titulo}: ${e.resumo}`).join('\n');
}

/**
 * Busca semantica no Atlas.
 * @returns {Promise<Array|null>} null sinaliza "nao deu, use o fallback"
 */
async function vectorSearch({ query, tipoCaso, limit }) {
  const vector = await embeddings.embed(query);
  if (!vector) return null;

  try {
    const pipeline = [
      {
        $vectorSearch: {
          index: env.knowledge.vectorIndex,
          path: 'embedding',
          queryVector: vector,
          numCandidates: Math.max(50, limit * 20),
          limit: limit * 2,
          filter: { ativo: true },
        },
      },
      {
        $project: {
          topic: 1,
          titulo: 1,
          resumo: 1,
          perguntaChave: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ];

    const results = await KnowledgeChunk.aggregate(pipeline);
    if (!results.length) return [];

    // O tipo_caso ja extraido pela ontologia e evidencia forte: promove o verbete.
    const boosted = results.map((r) => ({
      ...r,
      score: r.topic === tipoCaso ? r.score + 0.15 : r.score,
    }));

    return boosted
      .filter((r) => r.score >= env.knowledge.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } catch (error) {
    logger.warn(
      { err: error.message, index: env.knowledge.vectorIndex },
      'Busca vetorial falhou; usando a base local'
    );
    return null;
  }
}

/**
 * Interface unica usada pelo agente.
 * @returns {Promise<{topics: string[], block: string, backend: string, scores?: number[]}>}
 */
async function search({ query, tipoCaso, limit = env.knowledge.topK }) {
  if (usingMongo()) {
    const hits = await vectorSearch({ query, tipoCaso, limit });

    if (hits && hits.length) {
      logger.debug(
        {
          ev: EV.KNOWLEDGE_SEARCH,
          backend: 'mongo',
          topics: hits.map((h) => h.topic),
          scores: hits.map((h) => Number(h.score?.toFixed(3))),
        },
        'Verbetes recuperados por busca semantica'
      );
      return {
        topics: hits.map((h) => h.topic),
        block: renderBlock(hits),
        backend: 'mongo',
        scores: hits.map((h) => h.score),
      };
    }

    // hits === [] significa "buscou e nao achou nada relevante": respeita o vazio.
    if (hits) return { topics: [], block: '', backend: 'mongo', scores: [] };
    // hits === null significa "a busca falhou": cai para o local.
  }

  const local = localSearch.select({ tipoCaso, text: query, limit });
  logger.debug(
    { ev: EV.KNOWLEDGE_SEARCH, backend: 'memory', topics: local.topics },
    'Verbetes recuperados da base local'
  );
  return { ...local, backend: 'memory' };
}

/** Pergunta de aprofundamento do tema (vale para os dois backends). */
function suggestedQuestion(topic) {
  return KNOWLEDGE[topic]?.perguntaChave || null;
}

/**
 * Popula o Atlas a partir dos verbetes locais. Idempotente: so re-embeda o
 * que mudou de conteudo (contentHash).
 */
async function seed({ force = false } = {}) {
  const entries = Object.entries(KNOWLEDGE).map(([topic, entry]) => ({
    topic,
    titulo: entry.titulo,
    resumo: entry.resumo,
    perguntaChave: entry.perguntaChave,
    gatilhos: entry.gatilhos || [],
    contentHash: embeddings.contentHash(entry),
  }));

  const existing = await KnowledgeChunk.find({}, { topic: 1, contentHash: 1 }).lean();
  const byTopic = Object.fromEntries(existing.map((e) => [e.topic, e.contentHash]));

  const toEmbed = force
    ? entries
    : entries.filter((e) => byTopic[e.topic] !== e.contentHash);

  if (!toEmbed.length) {
    return { total: entries.length, embedded: 0, skipped: entries.length };
  }

  // O texto embedado junta titulo, resumo e gatilhos: a pergunta do lead
  // costuma parecer mais com o gatilho ("fui mandado embora") do que com o titulo.
  const vectors = await embeddings.embedMany(
    toEmbed.map((e) => [e.titulo, e.resumo, (e.gatilhos || []).join(', ')].join('\n'))
  );

  const ops = toEmbed.map((entry, i) => ({
    updateOne: {
      filter: { topic: entry.topic },
      update: {
        $set: {
          ...entry,
          ativo: true,
          embedding: vectors[i],
          embeddingModel: env.knowledge.embeddingModel,
        },
      },
      upsert: true,
    },
  }));

  await KnowledgeChunk.bulkWrite(ops);

  return {
    total: entries.length,
    embedded: toEmbed.length,
    skipped: entries.length - toEmbed.length,
    dimensions: vectors[0]?.length || 0,
  };
}

/** Diagnostico para o painel: qual backend responde e se a colecao esta pronta. */
async function status() {
  const info = { backend: env.knowledge.backend, localEntries: Object.keys(KNOWLEDGE).length };
  if (!usingMongo()) return { ...info, ready: true };

  try {
    info.indexedChunks = await KnowledgeChunk.countDocuments({ ativo: true });
    info.vectorIndex = env.knowledge.vectorIndex;
    info.ready = info.indexedChunks > 0;
  } catch (error) {
    info.ready = false;
    info.error = error.message;
  }
  return info;
}

module.exports = { search, suggestedQuestion, seed, status, renderBlock, usingMongo };
