const mongoose = require('mongoose');

/** Auditoria de cada execucao do pipeline (roteamento, tokens, guardrails). */
const AgentRunSchema = new mongoose.Schema(
  {
    channelId: { type: String, index: true },
    jid: { type: String, index: true },
    tier: String,
    model: String,
    reason: String,
    knowledgeTopics: [String],
    webSearch: {
      fontes: [String],
      latencyMs: Number,
    },
    contextTokensSaved: Number,
    promptTokens: Number,
    completionTokens: Number,
    totalTokens: Number,
    latencyMs: Number,
    ok: { type: Boolean, default: true },
    error: String,
    guardrails: {
      input: [String],
      output: [String],
      retried: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AgentRun', AgentRunSchema);
