const crypto = require('crypto');
const { env } = require('../config/env');
const { getClient } = require('../agent/openai.service');
const logger = require('../utils/logger');

/**
 * Embeddings para a busca semantica da base de conhecimento.
 *
 * Cache em memoria por hash do texto: a mesma pergunta feita por leads
 * diferentes nao paga o embedding duas vezes. Cache pequeno e limitado -
 * o objetivo e cortar repeticao imediata, nao ser um store.
 */

const CACHE_MAX = 500;
const cache = new Map();

const hashText = (text) => crypto.createHash('sha1').update(text).digest('hex');

function remember(key, value) {
  if (cache.size >= CACHE_MAX) {
    // descarta o mais antigo (Map preserva ordem de insercao)
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, value);
}

/**
 * @returns {Promise<number[]|null>} vetor, ou null se falhar (nunca lanca)
 */
async function embed(text) {
  const input = (text || '').trim();
  if (!input) return null;

  const key = hashText(input);
  if (cache.has(key)) return cache.get(key);

  try {
    const response = await getClient().embeddings.create({
      model: env.knowledge.embeddingModel,
      input,
    });
    const vector = response.data?.[0]?.embedding || null;
    if (vector) remember(key, vector);
    return vector;
  } catch (error) {
    logger.warn({ err: error.message }, 'Falha ao gerar embedding; caindo para busca local');
    return null;
  }
}

/** Lote, usado pelo seed da base. */
async function embedMany(texts) {
  const inputs = texts.map((t) => (t || '').trim()).filter(Boolean);
  if (!inputs.length) return [];

  const response = await getClient().embeddings.create({
    model: env.knowledge.embeddingModel,
    input: inputs,
  });
  return response.data.map((d) => d.embedding);
}

const contentHash = (entry) =>
  hashText(`${entry.titulo}|${entry.resumo}|${entry.perguntaChave || ''}`);

module.exports = { embed, embedMany, contentHash, hashText };
