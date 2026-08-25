const { ClienteEvento } = require('../models');
const logger = require('../utils/logger');

const TIPOS = ClienteEvento.TIPOS;

/**
 * REGISTRO DA LINHA DO TEMPO
 * --------------------------
 * A regra que define este modulo: **registrar nunca pode derrubar o que estava
 * acontecendo**. Um evento e um efeito colateral de outra coisa — uma mensagem
 * chegou, alguem mudou o status — e falhar em anotar isso jamais pode impedir
 * a mensagem de ser respondida ou o status de ser salvo.
 *
 * Por isso todo `registrar` engole o proprio erro. Perder uma linha de
 * historico e ruim; deixar de atender um cliente por causa dela e pior.
 */

/**
 * @param {object} evento
 * @param {boolean} [evento.relevante=true] muda o entendimento do caso? Eventos
 *   irrelevantes (um "bom dia") nao envelhecem o resumo inteligente, e e isso
 *   que impede a IA de rodar a cada mensagem trocada.
 */
async function registrar({ clienteId, tipo, titulo, descricao, autor, dados, relevante = true, em }) {
  if (!clienteId || !tipo || !titulo) return null;

  try {
    return await ClienteEvento.create({
      clienteId,
      tipo,
      titulo,
      descricao: descricao || null,
      autor: autor || { tipo: 'sistema' },
      dados: dados || null,
      relevante,
      em: em || new Date(),
    });
  } catch (error) {
    logger.warn({ err: error.message, clienteId, tipo }, 'Falha ao registrar evento do cliente');
    return null;
  }
}

/** Vários eventos de uma vez, na mesma ida ao banco. */
async function registrarVarios(eventos = []) {
  const validos = eventos.filter((e) => e?.clienteId && e?.tipo && e?.titulo);
  if (!validos.length) return 0;

  try {
    const docs = await ClienteEvento.insertMany(
      validos.map((e) => ({
        ...e,
        autor: e.autor || { tipo: 'sistema' },
        em: e.em || new Date(),
      })),
      { ordered: false }
    );
    return docs.length;
  } catch (error) {
    logger.warn({ err: error.message }, 'Falha ao registrar eventos do cliente');
    return 0;
  }
}

/**
 * Timeline de um cliente, do mais recente para o mais antigo.
 * `tipos` filtra a visualizacao sem apagar nada.
 */
async function listar(clienteId, { limite = 80, tipos, antesDe } = {}) {
  const filtro = { clienteId };
  if (Array.isArray(tipos) && tipos.length) filtro.tipo = { $in: tipos };
  if (antesDe) filtro.em = { $lt: new Date(antesDe) };

  const docs = await ClienteEvento.find(filtro)
    .sort({ em: -1 })
    .limit(Math.min(300, Math.max(1, Number(limite) || 80)))
    .lean();

  return docs.map((d) => ({
    id: d._id.toString(),
    tipo: d.tipo,
    titulo: d.titulo,
    descricao: d.descricao || null,
    autor: d.autor || { tipo: 'sistema' },
    dados: d.dados || null,
    relevante: d.relevante !== false,
    em: d.em,
  }));
}

/**
 * Tipos de evento que podem ser lidos por algo que escreve PARA O CLIENTE.
 *
 * A lista e curta de proposito, e o criterio nao e "o tipo e sensivel?" e sim
 * "todo evento deste tipo e seguro?". `observacao`, `tarefa` e `campo` carregam
 * texto escrito pela equipe para a equipe — "cliente complicado, cobrar antes"
 * entra na timeline como descricao de uma observacao, e de la chegaria a uma
 * mensagem enviada a essa mesma pessoa.
 *
 * Foi exatamente esse o caminho de um vazamento encontrado em teste: o dossie
 * externo ja excluia o campo `observacoesInternas`, mas o mesmo texto voltava
 * pela linha do tempo.
 */
const TIPOS_PUBLICOS = new Set([
  TIPOS.ENTRADA,
  TIPOS.STATUS,
  TIPOS.ETAPA,
  TIPOS.MENSAGEM,
  TIPOS.DOCUMENTO,
  TIPOS.PENDENCIA,
]);

/**
 * O que a IA precisa ler para resumir o caso: os eventos que mudam o
 * entendimento, do mais antigo para o mais novo (a ordem importa para o
 * modelo entender a sequencia dos fatos).
 *
 * @param {boolean} [interno=true] quando `false`, devolve so os tipos publicos
 *   e SEM as descricoes — o titulo ("Status: Novo → Em analise") ja conta a
 *   historia, e e a descricao que carrega texto livre da equipe.
 */
async function paraResumo(clienteId, limite = 60, { interno = true } = {}) {
  const filtro = { clienteId, relevante: true };
  if (!interno) filtro.tipo = { $in: [...TIPOS_PUBLICOS] };

  const docs = await ClienteEvento.find(filtro).sort({ em: -1 }).limit(limite).lean();

  return docs.reverse().map((d) => ({
    tipo: d.tipo,
    titulo: d.titulo,
    descricao: interno ? d.descricao || null : null,
    autor: d.autor?.tipo || 'sistema',
    em: d.em,
  }));
}

/** Ultimo evento relevante — a base da assinatura que envelhece o resumo. */
const ultimoRelevante = (clienteId) =>
  ClienteEvento.findOne({ clienteId, relevante: true }).sort({ em: -1 }).lean();

const contar = (clienteId) => ClienteEvento.countDocuments({ clienteId });

/** Remove a timeline junto com a ficha. */
const apagarDoCliente = (clienteId) => ClienteEvento.deleteMany({ clienteId });

module.exports = {
  TIPOS,
  TIPOS_PUBLICOS,
  registrar,
  registrarVarios,
  listar,
  paraResumo,
  ultimoRelevante,
  contar,
  apagarDoCliente,
};
