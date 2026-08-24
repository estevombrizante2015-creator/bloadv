const mongoose = require('mongoose');

const GuardrailEventSchema = new mongoose.Schema(
  {
    channelId: { type: String, index: true },
    jid: { type: String, index: true },
    stage: { type: String, enum: ['input', 'output'], required: true },
    rule: { type: String, required: true },
    severity: { type: String, enum: ['info', 'warn', 'block'], default: 'warn' },
    action: String,
    excerpt: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model('GuardrailEvent', GuardrailEventSchema);
