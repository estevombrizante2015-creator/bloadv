const mongoose = require('mongoose');

/**
 * Usuario do painel. O painel permite parear contas de WhatsApp do escritorio,
 * entao o acesso e restrito por definicao - nao existe modo aberto.
 *
 * A senha nunca e guardada: so o hash scrypt, com salt por usuario.
 */
const UserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: { type: String, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['admin', 'operador'], default: 'operador' },
    active: { type: Boolean, default: true },
    lastLoginAt: Date,
    // Bloqueio temporario apos tentativas seguidas de senha errada.
    failedAttempts: { type: Number, default: 0 },
    lockedUntil: Date,
  },
  { timestamps: true }
);

UserSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    email: this.email,
    name: this.name || null,
    role: this.role,
    lastLoginAt: this.lastLoginAt || null,
  };
};

module.exports = mongoose.model('User', UserSchema);
