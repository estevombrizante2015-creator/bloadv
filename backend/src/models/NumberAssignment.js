const mongoose = require('mongoose');

/**
 * Vinculo numero -> agente feito pelo painel.
 *
 * O `agents.config.js` continua sendo o cadastro base. Esta colecao guarda
 * as atribuicoes feitas em runtime, para que parear um numero novo nao exija
 * editar codigo e reiniciar o servidor.
 *
 * Precedencia: atribuicao no banco > lista no arquivo de configuracao.
 */
const NumberAssignmentSchema = new mongoose.Schema(
  {
    // Sempre em digitos, ja normalizado.
    number: { type: String, required: true, unique: true, index: true },
    agentId: { type: String, required: true, index: true },
    assignedBy: String,
    note: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model('NumberAssignment', NumberAssignmentSchema);
