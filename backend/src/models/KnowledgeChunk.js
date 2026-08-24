const mongoose = require('mongoose');

/**
 * Verbete da base de conhecimento com embedding, para busca semantica
 * no MongoDB Atlas Vector Search.
 *
 * Enquanto KNOWLEDGE_BACKEND=memory, esta colecao fica ociosa e a base local
 * (knowledge.base.js) responde. Trocar para "mongo" ativa a busca vetorial
 * sem mudar nada no pipeline do agente.
 *
 * Indice esperado no Atlas (nome em KNOWLEDGE_VECTOR_INDEX):
 *   {
 *     "fields": [
 *       { "type": "vector", "path": "embedding", "numDimensions": 1536, "similarity": "cosine" },
 *       { "type": "filter", "path": "topic" },
 *       { "type": "filter", "path": "ativo" }
 *     ]
 *   }
 */
const KnowledgeChunkSchema = new mongoose.Schema(
  {
    topic: { type: String, required: true, index: true },
    titulo: { type: String, required: true },
    resumo: { type: String, required: true },
    perguntaChave: String,
    gatilhos: { type: [String], default: [] },
    fonte: { type: String, default: 'knowledge.base.js' },
    ativo: { type: Boolean, default: true },
    embedding: { type: [Number], select: false },
    embeddingModel: String,
    contentHash: { type: String, index: true },
  },
  { timestamps: true }
);

KnowledgeChunkSchema.index({ topic: 1, ativo: 1 });

module.exports = mongoose.model('KnowledgeChunk', KnowledgeChunkSchema);
