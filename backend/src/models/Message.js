const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema(
  {
    channelId: { type: String, required: true, index: true },
    jid: { type: String, required: true, index: true },
    waMessageId: String,
    seq: { type: Number, default: 0 },
    direction: { type: String, enum: ['in', 'out'], required: true },
    role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
    type: { type: String, default: 'text' },
    text: String,
    // Conteudo derivado de midia: transcricao (audio) ou descricao (imagem).
    transcription: String,
    imageDescription: String,
    caption: String,
    mediaMimeType: String,
    mediaBytes: Number,
    mediaError: String,
    // Quando a mensagem faz parte de um lote consolidado pelo buffer.
    batchId: { type: String, index: true },
    batchSize: Number,
    tier: String,
    // Quem escreveu a mensagem de saida: o agente ou uma pessoa do escritorio.
    sentBy: { type: String, enum: ['agent', 'human'], default: 'agent' },
    operatorEmail: String,
    tokens: {
      prompt: { type: Number, default: 0 },
      completion: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
    blockedBy: String,
    meta: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

MessageSchema.index({ channelId: 1, jid: 1, createdAt: -1 });

module.exports = mongoose.model('Message', MessageSchema);
