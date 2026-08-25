const mongoose = require('mongoose');

/**
 * TAREFA VINCULADA A UM CLIENTE
 * -----------------------------
 * "Ligar amanha", "cobrar o comprovante", "revisar a peca". O que hoje mora
 * numa coluna de planilha que ninguem olha depois de sexta-feira.
 *
 * O valor nao esta em guardar a tarefa: esta em ela APARECER na hora certa.
 * Por isso `prazo` e indexado junto com `status` — a consulta que importa e
 * sempre "o que esta vencido ou vence hoje", e ela roda no painel inteiro,
 * nao dentro de um cliente.
 */

const STATUS = ['aberta', 'concluida', 'cancelada'];
const PRIORIDADES = ['baixa', 'normal', 'alta', 'urgente'];

const TarefaSchema = new mongoose.Schema(
  {
    clienteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cliente', required: true, index: true },

    titulo: { type: String, required: true, trim: true },
    descricao: { type: String, default: '' },

    responsavel: {
      id: String,
      nome: String,
      email: String,
    },

    prazo: { type: Date, index: true },
    prioridade: { type: String, enum: PRIORIDADES, default: 'normal' },

    status: { type: String, enum: STATUS, default: 'aberta', index: true },
    concluidaEm: Date,
    concluidaPor: { id: String, nome: String },

    criadaPor: { id: String, nome: String },

    /**
     * Tarefa nascida de uma sugestao da IA. Guardado para que se possa medir
     * se as sugestoes ajudam — e desligar a funcao se nao ajudarem.
     */
    sugeridaPorIA: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// "O que vence hoje" e "o que ja venceu", no painel todo.
TarefaSchema.index({ status: 1, prazo: 1 });
TarefaSchema.index({ 'responsavel.id': 1, status: 1, prazo: 1 });

TarefaSchema.statics.STATUS = STATUS;
TarefaSchema.statics.PRIORIDADES = PRIORIDADES;

module.exports = mongoose.model('Tarefa', TarefaSchema);
