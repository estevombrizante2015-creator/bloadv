const mongoose = require('mongoose');

/**
 * Contato + snapshot da ONTOLOGIA.
 * A ontologia e o que economiza tokens: em vez de reenviar o historico bruto,
 * o agente recebe este objeto compacto (slots preenchidos) + poucas mensagens recentes.
 */
const ContactSchema = new mongoose.Schema(
  {
    jid: { type: String, required: true, index: true },
    channelId: { type: String, required: true, index: true },
    role: { type: String, enum: ['leads', 'clients'], required: true },
    phone: String,
    pushName: String,

    // --- Ontologia (slots) ---
    ontology: {
      version: { type: Number, default: 1 },
      intent: String,
      stage: String,
      sentiment: String,
      language: { type: String, default: 'pt-BR' },
      slots: { type: mongoose.Schema.Types.Mixed, default: {} },
      facts: { type: [String], default: [] },
      openQuestions: { type: [String], default: [] },
      updatedAt: Date,
    },

    // --- Memoria comprimida ---
    rollingSummary: { type: String, default: '' },
    summaryUpToSeq: { type: Number, default: 0 },
    messageCount: { type: Number, default: 0 },

    // --- Controle ---
    optedOut: { type: Boolean, default: false },
    humanHandoff: { type: Boolean, default: false },
    handoffReason: String,
    blocked: { type: Boolean, default: false },
    tokenUsage: {
      day: String, // YYYY-MM-DD
      tokens: { type: Number, default: 0 },
    },
    lastMessageAt: Date,
  },
  { timestamps: true }
);

ContactSchema.index({ channelId: 1, jid: 1 }, { unique: true });

module.exports = mongoose.model('Contact', ContactSchema);
