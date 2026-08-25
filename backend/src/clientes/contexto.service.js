const { Cliente, Message, Tarefa } = require('../models');
const pipeline = require('./pipeline.service');
const timeline = require('./timeline.service');
const { formatNumber } = require('../config/agents.config');

/**
 * O DOSSIE DO CLIENTE PARA A IA
 * -----------------------------
 * Ponto unico que traduz uma ficha em texto para o modelo. Quatro consumidores:
 * o resumo inteligente, o assistente do colaborador, as sugestoes automaticas
 * e o proprio agente do WhatsApp respondendo "como esta meu processo?".
 *
 * Ser um so importa por uma razao especifica: o dossie carrega a fronteira
 * entre o que e interno e o que pode chegar ao cliente. Se cada funcionalidade
 * montasse o seu, bastaria uma esquecer de excluir as observacoes internas
 * para o agente ler em voz alta, no WhatsApp, a anotacao "cliente e
 * complicado, cobrar antes".
 *
 * Por isso `montar()` recebe `interno` e o padrao e **false**. O default
 * seguro e o que vaza menos.
 */

const data = (d) =>
  d ? new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : null;

const dataHora = (d) =>
  d
    ? new Date(d).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

const linha = (rotulo, valor) => (valor ? `${rotulo}: ${valor}` : null);

/** Últimas mensagens trocadas nas conversas vinculadas a esta ficha. */
async function mensagensRecentes(cliente, limite = 30) {
  const conversas = cliente.conversas || [];
  if (!conversas.length) return [];

  const docs = await Message.find({
    $or: conversas.map((c) => ({ channelId: c.channelId, jid: c.chatId })),
  })
    .sort({ createdAt: -1 })
    .limit(limite)
    .lean();

  return docs.reverse().map((d) => ({
    quem: d.direction === 'in' ? 'cliente' : 'escritorio',
    texto: d.text || d.transcription || d.imageDescription || d.caption || '(midia)',
    em: d.createdAt,
  }));
}

/**
 * Reúne tudo o que se sabe do cliente.
 *
 * @param {boolean} [interno=false] inclui observacoes internas, pendencias
 *   internas e nomes de responsaveis. NUNCA passe true para nada que possa
 *   chegar ao proprio cliente.
 */
async function montar(clienteId, { interno = false, mensagens = 30, eventos = 40 } = {}) {
  const cliente = await Cliente.findById(clienteId).lean();
  if (!cliente) return null;

  const [historico, conversas, tarefas] = await Promise.all([
    timeline.paraResumo(cliente._id, eventos, { interno }),
    mensagensRecentes(cliente, mensagens),
    Tarefa.find({ clienteId: cliente._id, status: 'aberta' }).sort({ prazo: 1 }).lean(),
  ]);

  const pendenciasAbertas = (cliente.pendencias || []).filter((p) => !p.resolvida);

  // ---------- ficha ----------
  const ficha = [
    linha('Nome', cliente.nome),
    linha('Telefone', formatNumber(cliente.telefone)),
    linha('Situacao atual', pipeline.rotuloStatus(cliente.status)),
    linha('Etapa do processo', cliente.etapa ? pipeline.rotuloEtapa(cliente.etapa) : null),
    linha('Aguardando', cliente.aguardando),
    linha('Proxima acao', cliente.proximaAcao),
    linha('Data da proxima acao', data(cliente.proximaAcaoEm)),
    linha('Ultimo contato', data(cliente.ultimoContatoEm)),
    linha('Cliente desde', data(cliente.entradaEm)),
    interno ? linha('Responsavel', cliente.responsavel?.nome) : null,
    interno ? linha('Prioridade', cliente.prioridade) : null,
    interno && cliente.tags?.length ? linha('Etiquetas', cliente.tags.join(', ')) : null,
  ]
    .filter(Boolean)
    .join('\n');

  const blocos = [`[FICHA]\n${ficha}`];

  // ---------- pendencias ----------
  if (pendenciasAbertas.length) {
    blocos.push(
      `[PENDENCIAS EM ABERTO]\n${pendenciasAbertas.map((p) => `- ${p.texto}`).join('\n')}`
    );
  }

  // ---------- tarefas: so no dossie interno ----------
  // A agenda do escritorio nao e assunto do cliente. Ele nao precisa saber que
  // existe uma tarefa "cobrar o comprovante pela terceira vez".
  if (interno && tarefas.length) {
    blocos.push(
      `[TAREFAS ABERTAS]\n${tarefas
        .map(
          (t) =>
            `- ${t.titulo}${t.prazo ? ` (prazo ${data(t.prazo)})` : ''}` +
            `${t.responsavel?.nome ? ` — ${t.responsavel.nome}` : ''}`
        )
        .join('\n')}`
    );
  }

  // ---------- observacoes internas: NUNCA no dossie externo ----------
  if (interno && cliente.observacoesInternas?.trim()) {
    blocos.push(`[OBSERVACOES INTERNAS]\n${cliente.observacoesInternas.trim()}`);
  }

  // ---------- historico ----------
  if (historico.length) {
    blocos.push(
      `[HISTORICO]\n${historico
        .map((e) => `${data(e.em)} — ${e.titulo}${e.descricao ? `: ${e.descricao}` : ''}`)
        .join('\n')}`
    );
  }

  if (conversas.length) {
    blocos.push(
      `[CONVERSAS RECENTES]\n${conversas
        .map((m) => `${dataHora(m.em)} ${m.quem}: ${String(m.texto).slice(0, 300)}`)
        .join('\n')}`
    );
  }

  return {
    cliente,
    texto: blocos.join('\n\n'),
    interno,
    // Quanto material existe de fato. E o que permite dizer "nao tenho dados
    // suficientes" em vez de inventar um andamento a partir de uma ficha vazia.
    densidade: {
      eventos: historico.length,
      mensagens: conversas.length,
      tarefas: tarefas.length,
      pendencias: pendenciasAbertas.length,
      temStatus: Boolean(cliente.status),
      temEtapa: Boolean(cliente.etapa),
    },
  };
}

/**
 * Ha material suficiente para afirmar alguma coisa sobre o andamento?
 *
 * A pergunta existe por causa de uma exigencia explicita: o agente nunca pode
 * inventar um status. Uma ficha recem-criada, so com o telefone, nao autoriza
 * dizer nada — e este e o unico ponto que decide isso, para os quatro
 * consumidores responderem igual.
 */
const temMaterial = (densidade) =>
  Boolean(
    densidade &&
      (densidade.temStatus || densidade.temEtapa) &&
      densidade.eventos + densidade.mensagens >= 2
  );

/**
 * Assinatura do estado atual. Muda quando algo que importa muda — e so ai o
 * resumo inteligente e considerado velho. Sem isso, abrir a ficha dispararia
 * uma chamada de IA por abertura.
 */
function assinatura(cliente, ultimoEvento) {
  return [
    cliente.status,
    cliente.etapa,
    cliente.aguardando,
    cliente.proximaAcao,
    cliente.proximaAcaoEm?.getTime?.() || cliente.proximaAcaoEm || '',
    (cliente.pendencias || []).filter((p) => !p.resolvida).length,
    ultimoEvento?._id?.toString() || '',
  ].join('|');
}

module.exports = { montar, temMaterial, assinatura, mensagensRecentes };
