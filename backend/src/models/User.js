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
    // `operador` e o papel legado, mantido para nao invalidar as contas que ja
    // existem. Ele vale como curador; ver auth/roles.js.
    role: {
      type: String,
      enum: ['admin', 'curador', 'visualizador', 'operador'],
      default: 'curador',
    },
    active: { type: Boolean, default: true },
    lastLoginAt: Date,
    // Bloqueio temporario apos tentativas seguidas de senha errada.
    failedAttempts: { type: Number, default: 0 },
    lockedUntil: Date,
  },
  { timestamps: true }
);

UserSchema.methods.toPublic = function toPublic() {
  // Carregado aqui dentro: roles.js nao depende do model, mas o model depende
  // de roles para traduzir papel em capacidades, e o require no topo fecharia
  // o ciclo.
  const { permissoes } = require('../auth/roles');

  return {
    id: this._id.toString(),
    email: this.email,
    name: this.name || null,
    role: this.role,
    lastLoginAt: this.lastLoginAt || null,
    // O painel usa isto para esconder o que a pessoa nao pode fazer. Esconder
    // botao nao e permissao: cada rota confere de novo no servidor.
    permissoes: permissoes(this),
  };
};

module.exports = mongoose.model('User', UserSchema);
