const mongoose = require('mongoose');

/**
 * FICHA OPERACIONAL DO CLIENTE
 * ----------------------------
 * Substitui a planilha. O que vive aqui e o ESTADO do acompanhamento — onde a
 * pessoa esta, o que se espera dela, quem responde por ela — e nao o historico
 * da conversa, que continua em Message/Conversation.
 *
 * A CHAVE E O TELEFONE. Nao o chatId, nao o LID, nao o _id de uma conversa.
 * Razoes:
 *
 *   - a mesma pessoa escreve para dois numeros do escritorio e continua sendo
 *     um cliente so;
 *   - o LID muda de forma e nao e legivel por ninguem;
 *   - quando alguem cadastra um cliente a mao, antes da primeira mensagem, o
 *     telefone e a unica coisa que se sabe.
 *
 * O vinculo com as conversas fica em `conversas`, preenchido sozinho quando o
 * telefone casa. Ver curadoria/../clientes/cliente.service#vincularConversa.
 */

const PRIORIDADES = ['baixa', 'normal', 'alta', 'urgente'];

const PendenciaSchema = new mongoose.Schema(
  {
    texto: { type: String, required: true, trim: true },
    resolvida: { type: Boolean, default: false },
    criadaEm: { type: Date, default: Date.now },
    resolvidaEm: Date,
  },
  { _id: true }
);

const ClienteSchema = new mongoose.Schema(
  {
    nome: { type: String, trim: true, index: true },

    /**
     * Digitos com DDI. E a identidade do cliente em todo o sistema — quando
     * existe.
     *
     * NAO e obrigatorio. A planilha que este modulo veio substituir tem
     * dezenas de clientes sem telefone: o escritorio sabe o nome, a parte
     * contraria e o pedido, e o telefone aparece depois. Exigir o numero para
     * cadastrar significaria recusar o cliente que ja existe — e mandar a
     * equipe de volta para a planilha.
     *
     * O indice unico e PARCIAL (ver abaixo): so vale para quem tem telefone,
     * entao muitos clientes sem numero convivem sem colidir.
     */
    telefone: { type: String },

    email: { type: String, trim: true, lowercase: true },

    /** Quem responde por este cliente no escritorio. */
    responsavel: {
      id: String,
      nome: String,
      email: String,
    },

    // Ids livres, definidos pela equipe em ClientePipeline. Nao sao enum: o
    // enunciado pede que status e etapa sejam configuraveis, e um enum aqui
    // exigiria deploy para criar uma etapa nova.
    status: { type: String, index: true },
    etapa: { type: String, index: true },

    /** O que trava o andamento agora, em uma linha. */
    aguardando: { type: String, trim: true },

    pendencias: { type: [PendenciaSchema], default: [] },

    proximaAcao: { type: String, trim: true },
    proximaAcaoEm: { type: Date, index: true },

    ultimoContatoEm: { type: Date, index: true },

    prioridade: { type: String, enum: PRIORIDADES, default: 'normal', index: true },

    tags: { type: [String], default: [], index: true },

    /** Nunca sai para o cliente. O resumo externo e gerado sem este campo. */
    observacoesInternas: { type: String, default: '' },

    entradaEm: { type: Date, default: Date.now, index: true },

    /** De onde veio a ficha, para saber o que confiar num diagnostico. */
    origem: {
      type: String,
      enum: ['whatsapp', 'manual', 'importacao'],
      default: 'whatsapp',
    },

    /** Conversas de WhatsApp desta pessoa, em qualquer canal. */
    conversas: {
      type: [
        {
          _id: false,
          channelId: String,
          chatId: String,
          vinculadaEm: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },

    /**
     * Resumo gerado por IA, nas duas versoes.
     *
     * `assinatura` e a impressao digital do historico que originou o resumo.
     * E o que permite dizer "este resumo esta desatualizado" sem chamar o
     * modelo de novo a cada abertura da ficha — a IA so roda quando algo
     * relevante mudou de verdade.
     */
    resumo: {
      interno: String,
      cliente: String,
      geradoEm: Date,
      geradoPor: String,
      assinatura: String,
      tokens: Number,
    },

    /**
     * COLUNAS QUE O PRODUTO NAO MODELA.
     *
     * Toda planilha de escritorio tem colunas proprias — "parte contraria",
     * "numero do processo", "documentos entregues", "Projuris". Inventar um
     * campo no schema para cada uma seria adivinhar o escritorio seguinte; e
     * jogar tudo dentro das observacoes internas transformaria dado estruturado
     * em texto corrido, que nao se filtra nem se lê.
     *
     * Guardadas como pares na ORDEM da planilha, e exibidas na ficha como
     * "Dados da planilha". Sao internas por natureza: entram no dossie da
     * equipe e nunca no resumo que vai para o cliente.
     */
    camposExtras: {
      type: [{ _id: false, rotulo: String, valor: String }],
      default: [],
    },

    /** Ficha arquivada some das listas, mas nada e apagado. */
    arquivado: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

/**
 * Unico, mas so para quem TEM telefone.
 *
 * Um indice unico comum trataria a ausencia como `null` e deixaria cadastrar um
 * unico cliente sem numero — o segundo colidiria com o primeiro. O filtro
 * parcial resolve: a restricao existe apenas sobre os documentos em que
 * `telefone` e uma string.
 */
ClienteSchema.index(
  { telefone: 1 },
  { unique: true, partialFilterExpression: { telefone: { $type: 'string' } } }
);

// A lista principal ordena por proxima acao e por quem esta parado ha mais
// tempo; sem indice composto isso vira varredura de colecao assim que a
// carteira passar de algumas centenas.
ClienteSchema.index({ arquivado: 1, status: 1, proximaAcaoEm: 1 });
ClienteSchema.index({ arquivado: 1, 'responsavel.id': 1, prioridade: -1 });

// Busca por nome/telefone/email vinda do campo de pesquisa.
ClienteSchema.index({ nome: 'text', email: 'text' });

ClienteSchema.statics.PRIORIDADES = PRIORIDADES;

module.exports = mongoose.model('Cliente', ClienteSchema);
