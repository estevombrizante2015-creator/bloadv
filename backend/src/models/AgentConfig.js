const mongoose = require('mongoose');

/**
 * CONFIGURACAO CURADA DE UM AGENTE
 * --------------------------------
 * Um documento por agente, com dois estados vivos:
 *
 *   publicada -> o que o atendimento real usa AGORA
 *   rascunho  -> o que a equipe esta escrevendo, invisivel para o contato
 *
 * Manter os dois no mesmo documento (em vez de uma colecao de rascunhos) e o
 * que torna "descartar alteracoes" uma operacao de um campo, e o que garante
 * que nunca exista mais de um rascunho concorrente por agente.
 *
 * O conteudo e `Mixed` de proposito: a forma e definida e validada em
 * curadoria/config.schema.js, que sabe explicar cada campo em portugues. Um
 * schema do Mongoose aqui duplicaria essa verdade em linguagem tecnica e as
 * duas iriam divergir na primeira mudanca.
 */
const AgentConfigSchema = new mongoose.Schema(
  {
    agentId: { type: String, required: true, unique: true, index: true },

    /** Configuracao no ar. `null` significa: ainda rodando com os padroes do codigo. */
    publicada: { type: mongoose.Schema.Types.Mixed, default: null },
    versaoPublicada: { type: Number, default: 0 },
    publicadaEm: Date,
    publicadaPor: {
      id: String,
      email: String,
      nome: String,
    },

    /** Rascunho aberto. `null` significa: nao ha alteracao pendente. */
    rascunho: { type: mongoose.Schema.Types.Mixed, default: null },
    rascunhoEm: Date,
    rascunhoPor: {
      id: String,
      email: String,
      nome: String,
    },

    /**
     * Ativo/standby vem do painel, nao do agents.config.js. O arquivo continua
     * sendo o cadastro base; aqui fica a decisao operacional, que a equipe
     * precisa poder tomar sem deploy.
     */
    status: { type: String, enum: ['active', 'standby'], default: null },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.model('AgentConfig', AgentConfigSchema);
