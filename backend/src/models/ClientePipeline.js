const mongoose = require('mongoose');

/**
 * STATUS, ETAPAS E COLUNAS DO KANBAN
 * ----------------------------------
 * Documento unico, editavel pela equipe. O enunciado e explicito: "os status e
 * etapas deverao ser configuraveis pela propria equipe" — entao nao podem ser
 * enum no codigo nem lista em arquivo, que exigiriam desenvolvedor.
 *
 * O KANBAN NAO E A LISTA DE ETAPAS. Sao coisas diferentes de proposito: um
 * quadro com nove colunas nao cabe na tela nem na cabeca. Cada coluna agrupa
 * um ou mais status, entao "Aguardando documentos" e "Aguardando cliente"
 * podem virar uma coluna "Aguardando cliente" sem que o escritorio perca a
 * distincao na ficha.
 */

const ItemSchema = new mongoose.Schema(
  {
    /** Estavel: e o que fica gravado nas fichas. Renomear o rotulo nao o muda. */
    id: { type: String, required: true },
    label: { type: String, required: true },
    /** Um dos tons definidos no front. Nao e CSS: a tela decide como pintar. */
    cor: { type: String, default: 'neutro' },
    ordem: { type: Number, default: 0 },
    /** Status/etapa final: sai das contagens de "em andamento". */
    conclusivo: { type: Boolean, default: false },
  },
  { _id: false }
);

const ColunaSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    cor: { type: String, default: 'neutro' },
    ordem: { type: Number, default: 0 },
    /** Status que aparecem nesta coluna. */
    status: { type: [String], default: [] },
    /**
     * Para onde o status vai quando alguem arrasta um cartao para ca. Sem
     * isso, uma coluna com tres status nao saberia qual aplicar.
     */
    statusAoSoltar: String,
  },
  { _id: false }
);

const ClientePipelineSchema = new mongoose.Schema(
  {
    // Chave fixa: existe um pipeline por instalacao. O campo existe para que o
    // upsert tenha em que casar.
    chave: { type: String, default: 'padrao', unique: true },

    status: { type: [ItemSchema], default: [] },
    etapas: { type: [ItemSchema], default: [] },
    colunas: { type: [ColunaSchema], default: [] },

    /** Sugestoes de etiqueta, para a equipe nao inventar dez grafias da mesma. */
    tags: { type: [String], default: [] },

    atualizadoPor: { id: String, nome: String },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.model('ClientePipeline', ClientePipelineSchema);
