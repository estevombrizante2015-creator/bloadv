const mongoose = require('mongoose');

/**
 * LINHA DO TEMPO DO CLIENTE
 * -------------------------
 * Tudo o que aconteceu com aquela pessoa, em ordem, numa colecao so.
 *
 * Colecao propria em vez de um array dentro de Cliente: a timeline cresce sem
 * teto (uma conversa longa gera dezenas de eventos) e um documento do Mongo
 * tem limite de 16 MB. Alem disso, a ficha e lida a todo momento e a timeline
 * quase nunca inteira — separar evita carregar o historico completo so para
 * mostrar o nome e o status.
 *
 * A maior parte dos eventos e registrada AUTOMATICAMENTE pelo sistema: e o que
 * o enunciado pede e o que faz a diferenca em relacao a planilha, onde o
 * registro depende de alguem lembrar de escrever.
 */

const TIPOS = {
  ENTRADA: 'entrada', // cliente entrou na operacao
  MENSAGEM: 'mensagem', // conversa no WhatsApp
  STATUS: 'status', // mudanca de status
  ETAPA: 'etapa', // mudanca de etapa
  RESPONSAVEL: 'responsavel', // troca de responsavel
  OBSERVACAO: 'observacao', // anotacao de um colaborador
  PENDENCIA: 'pendencia', // pendencia criada ou resolvida
  TAREFA: 'tarefa', // tarefa criada, concluida ou vencida
  DOCUMENTO: 'documento', // documento recebido
  CAMPO: 'campo', // qualquer outro campo da ficha alterado
  RESUMO: 'resumo', // resumo inteligente gerado
  SISTEMA: 'sistema', // o resto
};

const ClienteEventoSchema = new mongoose.Schema(
  {
    clienteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cliente', required: true, index: true },

    tipo: { type: String, enum: Object.values(TIPOS), required: true, index: true },

    /** Uma linha, legivel sozinha: "Status alterado para Aguardando cliente". */
    titulo: { type: String, required: true },

    /** Detalhe opcional — o texto da observacao, o trecho da mensagem. */
    descricao: String,

    autor: {
      // `sistema` e o autor mais comum, e isso e o objetivo.
      tipo: { type: String, enum: ['usuario', 'sistema', 'cliente', 'agente'], default: 'sistema' },
      id: String,
      nome: String,
    },

    /** Contexto estruturado do evento (de/para, ids), para a tela e auditoria. */
    dados: { type: mongoose.Schema.Types.Mixed, default: null },

    /**
     * Marca eventos que mudam o entendimento do caso. O resumo inteligente so
     * e considerado desatualizado quando um destes aparece — assim uma
     * mensagem de "bom dia" nao dispara uma chamada de IA.
     */
    relevante: { type: Boolean, default: true, index: true },

    em: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

// A timeline e sempre lida por cliente, do mais recente para o mais antigo.
ClienteEventoSchema.index({ clienteId: 1, em: -1 });

ClienteEventoSchema.statics.TIPOS = TIPOS;

module.exports = mongoose.model('ClienteEvento', ClienteEventoSchema);
