const mongoose = require('mongoose');

/**
 * HISTORICO DE VERSOES
 * --------------------
 * Uma linha por publicacao, com o snapshot INTEIRO da configuracao.
 *
 * Guardar o estado completo, e nao so o diff, e uma escolha deliberada:
 * restaurar a versao 12 precisa funcionar mesmo que as versoes 13 a 30 tenham
 * sido apagadas, e precisa funcionar sem reproduzir uma cadeia de patches.
 * Configuracao de agente e texto - o custo em disco e irrelevante perto do
 * risco de nao conseguir voltar atras.
 *
 * `alteracoes` e a leitura humana do que mudou em relacao a versao anterior,
 * calculada no momento da publicacao (curadoria/diff.js). Recalcular depois
 * daria outro resultado se o esquema mudasse.
 */
const AlteracaoSchema = new mongoose.Schema(
  {
    campo: String, // caminho tecnico: "tomDeVoz.preset"
    rotulo: String, // como aparece na tela: "Tom de voz"
    tipo: { type: String, enum: ['adicionado', 'removido', 'alterado'] },
    antes: String,
    depois: String,
  },
  { _id: false }
);

const AgentConfigVersionSchema = new mongoose.Schema(
  {
    agentId: { type: String, required: true, index: true },
    versao: { type: Number, required: true },

    /** Snapshot completo: e daqui que a restauracao le. */
    config: { type: mongoose.Schema.Types.Mixed, required: true },

    alteracoes: { type: [AlteracaoSchema], default: [] },

    /** Resumo em uma linha, escrito pela equipe ou gerado a partir do diff. */
    nota: { type: String, default: '' },

    publicadaPor: {
      id: String,
      email: String,
      nome: String,
    },

    /** Preenchido quando esta versao nasceu de "restaurar a versao N". */
    restauradaDe: { type: Number, default: null },
  },
  { timestamps: true, minimize: false }
);

// Duas publicacoes simultaneas nao podem gerar a mesma versao: o indice unico
// faz a segunda falhar, e o servico tenta de novo com o numero seguinte.
AgentConfigVersionSchema.index({ agentId: 1, versao: -1 }, { unique: true });

module.exports = mongoose.model('AgentConfigVersion', AgentConfigVersionSchema);
