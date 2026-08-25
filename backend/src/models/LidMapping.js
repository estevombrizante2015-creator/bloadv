const mongoose = require('mongoose');

/**
 * LID -> TELEFONE
 * ---------------
 * O WhatsApp passou a enderecar muitos chats por LID (`1234@lid`), um
 * identificador opaco que NAO e o telefone. O painel exibia esse numero cru e
 * saiam coisas como "+40351318433948" - um numero que nao existe.
 *
 * O telefone real chega junto das mensagens (`key.senderPn`) e de dois eventos
 * do protocolo, mas nem sempre: uma mensagem qualquer pode vir sem ele. Por
 * isso o vinculo e GRAVADO na primeira vez que aparece, e nao apenas lido no
 * momento em que se precisa dele.
 *
 * Colecao propria, e nao um campo em Conversation, por tres razoes:
 *
 *   1. o mesmo contato falando com dois numeros do escritorio e o mesmo
 *      telefone - descobrir num canal resolve no outro;
 *   2. a ficha do cliente precisa achar a pessoa pelo telefone, nao pelo LID;
 *   3. o vinculo sobrevive a exclusao de uma conversa.
 */
const LidMappingSchema = new mongoose.Schema(
  {
    /** Identificador puro, sem o sufixo "@lid". */
    lid: { type: String, required: true, unique: true, index: true },

    /** Telefone em digitos, com DDI. */
    phoneNumber: { type: String, required: true, index: true },

    /**
     * De onde veio o vinculo. Serve para depurar quando um numero parecer
     * errado: `senderPn` vem do proprio protocolo a cada mensagem e e o mais
     * confiavel; `contato` depende da agenda da conta conectada.
     */
    origem: {
      type: String,
      enum: ['senderPn', 'participantPn', 'phoneNumberShare', 'contato', 'manual'],
      default: 'senderPn',
    },

    vistoEm: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LidMapping', LidMappingSchema);
