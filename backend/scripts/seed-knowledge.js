#!/usr/bin/env node
/**
 * Popula a colecao knowledge_chunks no MongoDB com os verbetes + embeddings.
 *
 *   npm run seed:knowledge          # so o que mudou
 *   npm run seed:knowledge -- --force
 *
 * Depois, crie o indice vetorial no Atlas (nome = KNOWLEDGE_VECTOR_INDEX) e
 * mude KNOWLEDGE_BACKEND=mongo no .env.
 */
const { assertEnv, env } = require('../src/config/env');
const connectDB = require('../src/config/database');
const repository = require('../src/domain/knowledge.repository');
const logger = require('../src/utils/logger');

async function main() {
  assertEnv();
  await connectDB();

  const force = process.argv.includes('--force');
  const result = await repository.seed({ force });

  logger.info(result, 'Seed da base de conhecimento concluido');

  if (result.dimensions) {
    console.log(`
Indice vetorial a criar no Atlas (colecao "knowledgechunks", nome "${env.knowledge.vectorIndex}"):

{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": ${result.dimensions}, "similarity": "cosine" },
    { "type": "filter", "path": "topic" },
    { "type": "filter", "path": "ativo" }
  ]
}

Depois: KNOWLEDGE_BACKEND=mongo no .env.
`);
  }

  process.exit(0);
}

main().catch((error) => {
  logger.error({ err: error.message, stack: error.stack }, 'Seed falhou');
  process.exit(1);
});
