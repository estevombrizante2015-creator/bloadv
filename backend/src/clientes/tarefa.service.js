const { Tarefa, Cliente } = require('../models');
const timeline = require('./timeline.service');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');

/**
 * TAREFAS E PROXIMOS PASSOS
 * -------------------------
 * O que faz uma tarefa valer alguma coisa nao e existir: e aparecer sozinha
 * quando o prazo chega. Por isso a leitura principal deste modulo nao e "as
 * tarefas do cliente X" e sim `agenda()` — o que vence hoje e o que ja venceu,
 * na carteira inteira.
 */

const textoLimpo = (v, max) => String(v ?? '').trim().slice(0, max);

const paraData = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const fimDoDia = (d) => {
  const data = new Date(d);
  data.setHours(23, 59, 59, 999);
  return data;
};

/** Projecao para a tela, com o vencimento ja calculado. */
function projetar(tarefa, cliente) {
  const agora = Date.now();
  const prazo = tarefa.prazo ? new Date(tarefa.prazo).getTime() : null;
  const aberta = tarefa.status === 'aberta';

  return {
    id: tarefa._id.toString(),
    clienteId: tarefa.clienteId.toString(),
    clienteNome: cliente?.nome || null,
    clienteTelefone: cliente?.telefone || null,

    titulo: tarefa.titulo,
    descricao: tarefa.descricao || '',
    responsavel: tarefa.responsavel?.id ? tarefa.responsavel : null,
    prazo: tarefa.prazo || null,
    prioridade: tarefa.prioridade,
    status: tarefa.status,

    // A tela nao recalcula: um "vencida" com fuso diferente em cada
    // componente e como nao ter o aviso.
    vencida: Boolean(aberta && prazo && prazo < agora),
    venceHoje: Boolean(aberta && prazo && prazo >= agora && prazo <= fimDoDia(new Date()).getTime()),

    concluidaEm: tarefa.concluidaEm || null,
    concluidaPor: tarefa.concluidaPor?.nome || null,
    criadaPor: tarefa.criadaPor?.nome || null,
    sugeridaPorIA: Boolean(tarefa.sugeridaPorIA),
    criadaEm: tarefa.createdAt,
  };
}

async function criar({ clienteId, titulo, descricao, responsavel, prazo, prioridade, sugeridaPorIA }, usuario) {
  const nome = textoLimpo(titulo, 200);
  if (!nome) throw new Error('Descreva a tarefa.');

  const cliente = await Cliente.findById(clienteId).lean();
  if (!cliente) throw new Error('Cliente nao encontrado.');

  const tarefa = await Tarefa.create({
    clienteId,
    titulo: nome,
    descricao: textoLimpo(descricao, 2000),
    responsavel: responsavel || null,
    prazo: paraData(prazo),
    prioridade: prioridade || 'normal',
    criadaPor: { id: usuario?.id, nome: usuario?.nome || usuario?.email },
    sugeridaPorIA: Boolean(sugeridaPorIA),
  });

  await timeline.registrar({
    clienteId,
    tipo: timeline.TIPOS.TAREFA,
    titulo: `Tarefa criada: ${nome}`,
    descricao: tarefa.prazo ? `Prazo: ${tarefa.prazo.toLocaleDateString('pt-BR')}` : null,
    autor: { tipo: 'usuario', id: usuario?.id, nome: usuario?.nome || usuario?.email },
    dados: { tarefaId: tarefa._id.toString() },
  });

  logger.info(
    { ev: EV.TAREFA_CRIADA, clienteId, tarefaId: tarefa._id.toString(), por: usuario?.email },
    'Tarefa criada'
  );

  return projetar(tarefa, cliente);
}

async function atualizar(id, mudancas, usuario) {
  const tarefa = await Tarefa.findById(id);
  if (!tarefa) return null;

  const set = {};
  if (mudancas.titulo !== undefined) set.titulo = textoLimpo(mudancas.titulo, 200);
  if (mudancas.descricao !== undefined) set.descricao = textoLimpo(mudancas.descricao, 2000);
  if (mudancas.prazo !== undefined) set.prazo = paraData(mudancas.prazo);
  if (mudancas.prioridade !== undefined) set.prioridade = mudancas.prioridade;
  if (mudancas.responsavel !== undefined) set.responsavel = mudancas.responsavel || null;

  const concluindo = mudancas.status === 'concluida' && tarefa.status !== 'concluida';

  if (mudancas.status !== undefined) {
    set.status = mudancas.status;
    if (concluindo) {
      set.concluidaEm = new Date();
      set.concluidaPor = { id: usuario?.id, nome: usuario?.nome || usuario?.email };
    }
    // Reabrir limpa a marca de conclusao: deixar a data antiga faria a ficha
    // dizer que a tarefa foi concluida e esta aberta ao mesmo tempo.
    if (mudancas.status === 'aberta') {
      set.concluidaEm = null;
      set.concluidaPor = null;
    }
  }

  if (!Object.keys(set).length) return projetar(tarefa);

  const atualizada = await Tarefa.findByIdAndUpdate(id, { $set: set }, { new: true });

  if (concluindo) {
    await timeline.registrar({
      clienteId: tarefa.clienteId,
      tipo: timeline.TIPOS.TAREFA,
      titulo: `Tarefa concluida: ${atualizada.titulo}`,
      autor: { tipo: 'usuario', id: usuario?.id, nome: usuario?.nome || usuario?.email },
      dados: { tarefaId: id },
    });

    logger.info(
      { ev: EV.TAREFA_CONCLUIDA, tarefaId: id, por: usuario?.email },
      'Tarefa concluida'
    );
  } else if (mudancas.status === 'cancelada') {
    await timeline.registrar({
      clienteId: tarefa.clienteId,
      tipo: timeline.TIPOS.TAREFA,
      titulo: `Tarefa cancelada: ${atualizada.titulo}`,
      autor: { tipo: 'usuario', id: usuario?.id, nome: usuario?.nome || usuario?.email },
      relevante: false,
    });
  }

  const cliente = await Cliente.findById(tarefa.clienteId).lean();
  return projetar(atualizada, cliente);
}

async function remover(id) {
  const tarefa = await Tarefa.findByIdAndDelete(id);
  return Boolean(tarefa);
}

/** Tarefas de um cliente, abertas primeiro e por prazo. */
async function doCliente(clienteId, { incluirConcluidas = true } = {}) {
  const filtro = { clienteId };
  if (!incluirConcluidas) filtro.status = 'aberta';

  const [tarefas, cliente] = await Promise.all([
    Tarefa.find(filtro).sort({ status: 1, prazo: 1, createdAt: -1 }).lean(),
    Cliente.findById(clienteId).lean(),
  ]);

  return tarefas.map((t) => projetar(t, cliente));
}

/**
 * A agenda do escritorio: o que venceu e o que vence.
 *
 * Devolve vencidas e de hoje separadas porque sao urgencias diferentes — uma
 * lista unica ordenada por data esconde as vencidas no meio das outras.
 */
async function agenda({ responsavel, diasAFrente = 7 } = {}) {
  const agora = new Date();
  const limite = new Date(Date.now() + diasAFrente * 86400000);
  const filtro = { status: 'aberta' };
  if (responsavel) filtro['responsavel.id'] = responsavel;

  const tarefas = await Tarefa.find({ ...filtro, prazo: { $ne: null, $lte: limite } })
    .sort({ prazo: 1 })
    .limit(200)
    .lean();

  const clientes = await Cliente.find(
    { _id: { $in: [...new Set(tarefas.map((t) => String(t.clienteId)))] } },
    { nome: 1, telefone: 1 }
  ).lean();
  const porId = Object.fromEntries(clientes.map((c) => [c._id.toString(), c]));

  const projetadas = tarefas.map((t) => projetar(t, porId[t.clienteId.toString()]));
  const fimHoje = fimDoDia(agora).getTime();

  return {
    vencidas: projetadas.filter((t) => t.vencida),
    hoje: projetadas.filter(
      (t) => !t.vencida && t.prazo && new Date(t.prazo).getTime() <= fimHoje
    ),
    proximas: projetadas.filter((t) => !t.vencida && new Date(t.prazo).getTime() > fimHoje),
  };
}

module.exports = { criar, atualizar, remover, doCliente, agenda, projetar };
