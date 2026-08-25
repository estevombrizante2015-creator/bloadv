const { LidMapping } = require('../models');
const { jidToNumber, isLidJid, jidToIdentifier } = require('../config/agents.config');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');

/**
 * DESCOBERTA DO TELEFONE REAL POR TRAS DO LID
 * -------------------------------------------
 * Tres fontes, todas do proprio protocolo, em ordem de confianca:
 *
 *   1. `key.senderPn`      chega junto da mensagem, no stanza. E o caminho
 *                          normal e o mais confiavel.
 *   2. `chats.phoneNumberShare`  evento emitido quando o contato compartilha o
 *                          telefone. Confirma o mesmo vinculo.
 *   3. `contacts.upsert`   a agenda da conta conectada, que traz `lid` e `jid`
 *                          do mesmo contato. Util para conversas antigas.
 *
 * O que se aprende fica gravado: a fonte 1 nao vem em toda mensagem, e sem
 * memoria o painel voltaria a mostrar o identificador no turno seguinte.
 *
 * CACHE. `resolver()` e consultado ao montar cada linha do painel e a cada
 * mensagem recebida. O mapa vive em memoria e so cresce quando um LID novo
 * aparece; sao poucos bytes por contato.
 */

/** lid (sem sufixo) -> telefone em digitos */
const cache = new Map();
let carregado = false;

/** Aceita "123@lid", "123" ou um objeto de conversa. */
const chave = (valor) => {
  const bruto = String(valor || '');
  return isLidJid(bruto) ? jidToIdentifier(bruto) : bruto.split('@')[0] || null;
};

async function carregar() {
  try {
    const docs = await LidMapping.find().lean();
    cache.clear();
    for (const doc of docs) cache.set(doc.lid, doc.phoneNumber);
    carregado = true;
    logger.info({ vinculos: cache.size }, 'Vinculos LID -> telefone carregados');
  } catch (error) {
    // Sem o mapa o painel volta a mostrar o identificador, mas o atendimento
    // continua: o LID e suficiente para conversar.
    logger.warn({ err: error.message }, 'Falha ao carregar vinculos de LID');
  }
  return cache.size;
}

/**
 * Registra um vinculo. Idempotente: repetir o mesmo par nao escreve no banco.
 *
 * SINCRONA de proposito. O cache e atualizado na hora e a gravacao segue em
 * segundo plano, porque isto roda no caminho de cada mensagem recebida:
 * descobrir o telefone de um contato nao pode atrasar a resposta a ele. Com o
 * banco fora, `findOneAndUpdate` fica 10s em buffer antes de falhar — 10s que
 * o lead passaria esperando por um dado que nem e usado para responder.
 *
 * @returns {string|null} o telefone, ou null se a entrada nao servia
 */
function aprender({ lid, phoneNumber, origem = 'senderPn' }) {
  const id = chave(lid);

  // `jidToNumber` limpa mascara e sufixo de dispositivo (":12") e devolve null
  // para um endereco `@lid` - o que impede, de graca, gravar um identificador
  // no lugar do telefone.
  const numero = jidToNumber(phoneNumber);

  // Numero brasileiro tem 12 ou 13 digitos com DDI; abaixo de 10 nao e
  // telefone nenhum e gravar lixo aqui e pior que nao ter o vinculo.
  if (!id || !numero || numero.length < 10) return null;

  const conhecido = cache.get(id);
  if (conhecido === numero) return numero;

  cache.set(id, numero);

  LidMapping.findOneAndUpdate(
    { lid: id },
    { $set: { phoneNumber: numero, origem, vistoEm: new Date() } },
    { upsert: true }
  )
    .then(() =>
      logger.info(
        { ev: EV.LID_RESOLVIDO, lid: id, origem, trocou: Boolean(conhecido) },
        conhecido ? 'Vinculo de LID atualizado' : 'Telefone real descoberto para um LID'
      )
    )
    .catch((error) =>
      // O cache ja tem o vinculo: a sessao atual funciona, so nao sobrevive ao
      // restart. Nao vale derrubar o processamento da mensagem por isso.
      logger.warn({ err: error.message, lid: id }, 'Falha ao gravar vinculo de LID')
    );

  return numero;
}

/** Telefone conhecido para um LID, ou null. Sincrono: roda no caminho quente. */
const resolver = (lid) => cache.get(chave(lid)) || null;

/**
 * Telefone do remetente de uma mensagem, seja qual for o formato do chat.
 *
 * Em chat comum o proprio `remoteJid` ja e o telefone. Em chat por LID, ele
 * vem em `senderPn` (1:1) ou `participantPn` (grupo).
 */
function doMensagem(msg) {
  const chatId = msg?.key?.remoteJid;
  if (!chatId) return { phoneNumber: null, lid: null, origem: null };

  if (!isLidJid(chatId)) {
    return { phoneNumber: jidToNumber(chatId), lid: null, origem: null };
  }

  const lid = jidToIdentifier(chatId);

  const doProtocolo = msg.key.senderPn || msg.key.participantPn;
  if (doProtocolo) {
    return {
      phoneNumber: jidToNumber(doProtocolo),
      lid,
      origem: msg.key.senderPn ? 'senderPn' : 'participantPn',
    };
  }

  // Mensagem sem o telefone: vale o que ja foi aprendido antes.
  return { phoneNumber: resolver(lid), lid, origem: null };
}

/**
 * Aprende com uma mensagem recebida e devolve o telefone.
 * Chamado uma vez por mensagem, no manager.
 */
function observarMensagem(msg) {
  const { phoneNumber, lid, origem } = doMensagem(msg);

  if (lid && phoneNumber && origem) {
    aprender({ lid, phoneNumber, origem });
  } else if (lid && !phoneNumber) {
    // Chat por LID que continua sem telefone. O log diz QUAIS campos o
    // WhatsApp mandou nesta mensagem — sem isso, "o painel mostra o ID" e um
    // sintoma sem causa, e a unica saida seria adivinhar.
    //
    // Nao e ruido: so sai quando o vinculo ainda nao existe, e para de sair no
    // instante em que qualquer fonte revelar o numero.
    logger.info(
      {
        ev: EV.LID_SEM_TELEFONE,
        lid,
        camposRecebidos: Object.keys(msg?.key || {}).filter((k) => msg.key[k]),
        temSenderPn: Boolean(msg?.key?.senderPn),
        temParticipantPn: Boolean(msg?.key?.participantPn),
        temSenderLid: Boolean(msg?.key?.senderLid),
      },
      'Mensagem de chat por LID sem o telefone; o painel vai exibir o identificador'
    );
  }

  return { phoneNumber, lid };
}

/** `chats.phoneNumberShare`: o contato compartilhou o telefone. */
const observarCompartilhamento = ({ lid, jid }) =>
  aprender({ lid, phoneNumber: jid, origem: 'phoneNumberShare' });

/**
 * `contacts.upsert` / `contacts.update`: a agenda traz os dois enderecos do
 * mesmo contato. E o que resolve conversas antigas, anteriores a este codigo.
 */
function observarContatos(contatos = []) {
  let aprendidos = 0;

  for (const contato of contatos) {
    // O contato pode vir com o LID em `lid` e o telefone em `jid`, ou com o
    // `id` fazendo o papel de um dos dois - depende do evento.
    const lid = contato?.lid || (isLidJid(contato?.id) ? contato.id : null);
    const telefone = contato?.jid || (!isLidJid(contato?.id) ? contato?.id : null);

    if (lid && telefone && aprender({ lid, phoneNumber: telefone, origem: 'contato' })) {
      aprendidos += 1;
    }
  }

  return aprendidos;
}

module.exports = {
  carregar,
  aprender,
  resolver,
  doMensagem,
  observarMensagem,
  observarCompartilhamento,
  observarContatos,
  tamanho: () => cache.size,
  isCarregado: () => carregado,
};
