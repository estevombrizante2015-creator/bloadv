const mongoose = require('mongoose');

/**
 * Idempotencia: garante que o mesmo evento do WhatsApp nunca gere duas respostas.
 * O indice unico e o mecanismo - a insercao falha na segunda vez.
 * TTL de 7 dias porque reentrega do WhatsApp acontece em minutos, nao em semanas.
 */
const ProcessedMessageSchema = new mongoose.Schema(
  {
    channelId: { type: String, required: true },
    waMessageId: { type: String, required: true },
    chatId: String,
    receivedAt: { type: Date, default: Date.now },
    processedAt: Date,
    status: {
      type: String,
      enum: ['received', 'buffered', 'processed', 'ignored', 'failed'],
      default: 'received',
    },
    reason: String,
  },
  { timestamps: true }
);

ProcessedMessageSchema.index({ channelId: 1, waMessageId: 1 }, { unique: true });
ProcessedMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

module.exports = mongoose.model('ProcessedMessage', ProcessedMessageSchema);
