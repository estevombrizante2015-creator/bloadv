const mongoose = require('mongoose');

/** Estado persistido de cada um dos 3 numeros. */
const ChannelSchema = new mongoose.Schema(
  {
    channelId: { type: String, required: true, unique: true, index: true },
    role: { type: String, enum: ['leads', 'clients'], required: true },
    label: String,
    status: {
      type: String,
      enum: ['disconnected', 'connecting', 'qr', 'connected', 'logged_out', 'error'],
      default: 'disconnected',
    },
    phoneNumber: String,
    pushName: String,

    // Vinculo numero -> agente, resolvido automaticamente apos a leitura do QR.
    agentId: { type: String, index: true },
    agentLabel: String,
    agentStatus: String,
    agentBoundAt: Date,
    agentMatchedByNumber: { type: Boolean, default: false },
    lastConnectedAt: Date,
    lastDisconnectedAt: Date,
    lastError: String,
    agentEnabled: { type: Boolean, default: true },
    stats: {
      messagesIn: { type: Number, default: 0 },
      messagesOut: { type: Number, default: 0 },
      tokensUsed: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Channel', ChannelSchema);
