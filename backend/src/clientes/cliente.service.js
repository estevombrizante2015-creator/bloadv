const { Cliente, Tarefa } = require('../models');
const { digitsOnly, formatNumber } = require('../config/agents.config');
const pipeline = require('./pipeline.service');
const timeline = require('./timeline.service');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');

/**
 * GESTAO OPERACIONAL DE CLIENTES
 * ------------------------------
 * O que a planilha fazia, com duas diferencas que sao o ponto do modulo:
 *
 *   1. A FICHA SE ALIMENTA SOZINHA. Mensagem que chega, status que muda,
 *      tarefa que vence — tudo vira linha da timeline sem ninguem digitar.
 *      Numa planilha o registro depende de alguem lembrar, e por isso ela
 *      sempre esta desatualizada exatamente nos casos que mais importam.
 *
 *   2. O TELEFONE E A IDENTIDADE. Toda entrada de dado (conversa, cadastro
 *      manual, pergunta do agente) encontra a mesma ficha pelo telefone.
 */

// Campos que a equipe edita e que geram linha na timeline quando mudam. O
// rotulo e o que aparece la — "Status alterado para Em analise", nao
// "status: em_analise".
const CAMPOS_RASTREADOS = {
  nome: { label: 'Nome', tipo: 'campo' },
  email: { label: 'E-mail', tipo: 'campo' },
  telefone: { label: 'Telefone', tipo: 'campo' },
  status: { label: 'Status', tipo: 'status', rotulo: pipeline.rotuloStatus },
  etapa: { label: 'Etapa', tipo: 'etapa', rotulo: pipeline.rotuloEtapa },
  aguardando: { label: 'Aguardando', tipo: 'campo' },
  proximaAcao: { label: 'Proxima acao', tipo: 'campo' },
  proximaAcaoEm: { label: 'Data da proxima acao', tipo: 'campo', data: true },
  prioridade: { label: 'Prioridade', tipo: 'campo' },
  observacoesInternas: { label: 'Observacoes internas', tipo: 'observacao' },
};

const textoLimpo = (v, max = 2000) => String(v ?? '').trim().slice(0, max);

const paraData = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Como um valor aparece na timeline. */
function legivel(campo, valor) {
  const meta = CAMPOS_RASTREADOS[campo];
  if (valor === null || valor === undefined || valor === '') return '(vazio)';
  if (meta?.rotulo) return meta.rotulo(valor);
  if (meta?.data) return new Date(valor).toLocaleDateString('pt-BR');
  return String(valor);
}

/**
 * Reconcilia o indice de telefone.
 *
 * O telefone ja foi obrigatorio, e o indice criado naquela epoca e unico sem
 * filtro. Com o campo opcional, esse indice trataria a ausencia como `null` e
 * deixaria cadastrar UM unico cliente sem numero — o segundo falharia com erro
 * de duplicidade, no meio de uma importacao, sem explicacao util.
 *
 * O Mongo nao troca as opcoes de um indice existente: e preciso derrubar o
 * antigo. Roda no boot, e nao faz nada quando ja esta correto.
 */
async function garantirIndices() {
  try {
    const indices = await Cliente.collection.indexes();
    const antigo = indices.find((i) => i.name === 'telefone_1');

    if (antigo && !antigo.partialFilterExpression) {
      await Cliente.collection.dropIndex('telefone_1');
      logger.info('Indice antigo de telefone removido; sera recriado como parcial');
    }

    await Cliente.syncIndexes();
  } catch (error) {
    // Sem o indice certo o sistema continua funcionando; o que se perde e a
    // garantia contra telefone duplicado. Nao vale impedir o boot por isso.
    logger.warn({ err: error.message }, 'Falha ao reconciliar os indices de clientes');
  }
}

// ------------------------------------------------------------------ leitura

const porTelefone = (telefone) => Cliente.findOne({ telefone: digitsOnly(telefone) });

const porId = (id) => Cliente.findById(id);

/**
 * Projecao para a tela. Tudo o que a lista e o kanban precisam, ja resolvido:
 * a tela nao deve ter de saber traduzir id de status em rotulo.
 */
function resumo(cliente, { tarefas = {} } = {}) {
  const pendenciasAbertas = (cliente.pendencias || []).filter((p) => !p.resolvida);
  const agora = Date.now();

  return {
    id: cliente._id.toString(),
    nome: cliente.nome || null,
    telefone: cliente.telefone,
    telefoneFormatado: formatNumber(cliente.telefone),
    email: cliente.email || null,
    responsavel: cliente.responsavel?.id ? cliente.responsavel : null,

    status: cliente.status,
    statusLabel: pipeline.rotuloStatus(cliente.status),
    statusCor: pipeline.statusPorId(cliente.status)?.cor || 'neutro',
    coluna: pipeline.colunaDoStatus(cliente.status)?.id || null,

    etapa: cliente.etapa || null,
    etapaLabel: cliente.etapa ? pipeline.rotuloEtapa(cliente.etapa) : null,

    aguardando: cliente.aguardando || null,
    pendencias: pendenciasAbertas.map((p) => ({
      id: p._id.toString(),
      texto: p.texto,
      criadaEm: p.criadaEm,
    })),
    totalPendencias: pendenciasAbertas.length,

    proximaAcao: cliente.proximaAcao || null,
    proximaAcaoEm: cliente.proximaAcaoEm || null,
    // A tela pinta de vermelho pelo booleano; calcular aqui evita cada
    // componente reimplementar a nocao de "vencido" com um fuso diferente.
    proximaAcaoVencida: Boolean(
      cliente.proximaAcaoEm && new Date(cliente.proximaAcaoEm).getTime() < agora
    ),

    ultimoContatoEm: cliente.ultimoContatoEm || null,
    diasSemContato: cliente.ultimoContatoEm
      ? Math.floor((agora - new Date(cliente.ultimoContatoEm).getTime()) / 86400000)
      : null,

    prioridade: cliente.prioridade || 'normal',
    tags: cliente.tags || [],

    entradaEm: cliente.entradaEm,
    atualizadoEm: cliente.updatedAt,
    origem: cliente.origem,
    arquivado: Boolean(cliente.arquivado),

    conversas: cliente.conversas || [],

    tarefasAbertas: tarefas.abertas || 0,
    tarefasVencidas: tarefas.vencidas || 0,

    temResumo: Boolean(cliente.resumo?.cliente || cliente.resumo?.interno),
    resumoEm: cliente.resumo?.geradoEm || null,
  };
}

/** Ficha completa, para a tela do cliente. */
function detalhe(cliente) {
  return {
    ...resumo(cliente),
    observacoesInternas: cliente.observacoesInternas || '',
    // Inclui as resolvidas: a ficha mostra o historico, a lista so o que trava.
    todasPendencias: (cliente.pendencias || []).map((p) => ({
      id: p._id.toString(),
      texto: p.texto,
      resolvida: Boolean(p.resolvida),
      criadaEm: p.criadaEm,
      resolvidaEm: p.resolvidaEm || null,
    })),
    resumo: cliente.resumo?.geradoEm
      ? {
          interno: cliente.resumo.interno || null,
          cliente: cliente.resumo.cliente || null,
          geradoEm: cliente.resumo.geradoEm,
          geradoPor: cliente.resumo.geradoPor || null,
        }
      : null,
  };
}

// ----------------------------------------------------------------- escrita

/**
 * Encontra ou cria a ficha de quem escreveu pelo WhatsApp.
 *
 * Sem telefone nao ha ficha: um chat por LID cujo numero ainda nao apareceu
 * criaria um cliente sem identidade, que depois duplicaria quando o telefone
 * surgisse. Melhor esperar — o resolver preenche na proxima mensagem.
 */
async function garantirDoWhatsApp({ telefone, nome, channelId, chatId }) {
  const numero = digitsOnly(telefone);
  if (!numero || numero.length < 10) return null;

  const existente = await Cliente.findOne({ telefone: numero });

  if (existente) {
    await vincularConversa(existente, { channelId, chatId, nome });
    return existente;
  }

  try {
    const cliente = await Cliente.create({
      telefone: numero,
      nome: textoLimpo(nome, 120) || null,
      status: pipeline.statusInicial(),
      origem: 'whatsapp',
      entradaEm: new Date(),
      ultimoContatoEm: new Date(),
      conversas: channelId && chatId ? [{ channelId, chatId }] : [],
    });

    await timeline.registrar({
      clienteId: cliente._id,
      tipo: timeline.TIPOS.ENTRADA,
      titulo: 'Cliente entrou na operacao',
      descricao: `Primeiro contato pelo WhatsApp${nome ? ` (${nome})` : ''}.`,
      autor: { tipo: 'sistema' },
      dados: { channelId, chatId },
    });

    logger.info(
      { ev: EV.CLIENTE_CRIADO, clienteId: cliente._id.toString(), origem: 'whatsapp' },
      'Ficha de cliente criada a partir do WhatsApp'
    );

    return cliente;
  } catch (error) {
    // Duas mensagens quase simultaneas do mesmo contato correm para criar a
    // mesma ficha; o indice unico reprova a segunda. Buscar de novo devolve a
    // que ganhou, em vez de estourar no meio do atendimento.
    if (error.code === 11000) return Cliente.findOne({ telefone: numero });
    logger.warn({ err: error.message, telefone: numero }, 'Falha ao criar ficha de cliente');
    return null;
  }
}

/** Liga uma conversa a ficha, sem duplicar. */
async function vincularConversa(cliente, { channelId, chatId, nome }) {
  const mudancas = {};

  const jaTem = (cliente.conversas || []).some(
    (c) => c.channelId === channelId && c.chatId === chatId
  );
  if (channelId && chatId && !jaTem) {
    mudancas.$push = { conversas: { channelId, chatId, vinculadaEm: new Date() } };
  }

  // O nome do WhatsApp so preenche o vazio. Sobrescrever apagaria o nome
  // civil que o escritorio digitou ("Maria Souza") pelo apelido da conta
  // ("Mah 💜"), e ninguem procura cliente por apelido.
  if (nome && !cliente.nome) mudancas.$set = { nome: textoLimpo(nome, 120) };

  if (!Object.keys(mudancas).length) return cliente;

  return Cliente.findByIdAndUpdate(cliente._id, mudancas, { new: true });
}

/** Cadastro manual, feito na tela. */
async function criar(dados, usuario) {
  const numero = digitsOnly(dados?.telefone);
  if (!numero || numero.length < 10) throw new Error('Informe um telefone valido com DDD.');

  const existente = await Cliente.findOne({ telefone: numero });
  if (existente) {
    const erro = new Error('Ja existe um cliente com este telefone.');
    erro.clienteId = existente._id.toString();
    throw erro;
  }

  const cliente = await Cliente.create({
    telefone: numero,
    nome: textoLimpo(dados.nome, 120) || null,
    email: textoLimpo(dados.email, 160) || null,
    responsavel: dados.responsavel || null,
    status: dados.status || pipeline.statusInicial(),
    etapa: dados.etapa || null,
    aguardando: textoLimpo(dados.aguardando, 300) || null,
    proximaAcao: textoLimpo(dados.proximaAcao, 300) || null,
    proximaAcaoEm: paraData(dados.proximaAcaoEm),
    prioridade: dados.prioridade || 'normal',
    tags: Array.isArray(dados.tags) ? dados.tags.slice(0, 20) : [],
    observacoesInternas: textoLimpo(dados.observacoesInternas, 8000),
    origem: 'manual',
    entradaEm: paraData(dados.entradaEm) || new Date(),
  });

  await timeline.registrar({
    clienteId: cliente._id,
    tipo: timeline.TIPOS.ENTRADA,
    titulo: 'Cliente cadastrado',
    descricao: 'Ficha criada manualmente no painel.',
    autor: { tipo: 'usuario', id: usuario?.id, nome: usuario?.nome || usuario?.email },
  });

  logger.info(
    { ev: EV.CLIENTE_CRIADO, clienteId: cliente._id.toString(), origem: 'manual', por: usuario?.email },
    'Ficha de cliente criada no painel'
  );

  return cliente;
}

/**
 * Aplica mudancas e registra na timeline o que de fato mudou.
 *
 * O diff acontece antes da escrita porque e ele que produz o historico. Sem
 * isso a timeline teria de ser preenchida a mao em cada rota que edita algo —
 * e a primeira que esquecesse deixaria um buraco silencioso no historico.
 */
async function atualizar(id, mudancas, usuario) {
  const cliente = await Cliente.findById(id);
  if (!cliente) return null;

  const autor = { tipo: 'usuario', id: usuario?.id, nome: usuario?.nome || usuario?.email };
  const set = {};
  const eventos = [];

  for (const [campo, meta] of Object.entries(CAMPOS_RASTREADOS)) {
    if (!(campo in mudancas)) continue;

    const antes = cliente[campo];
    let depois = mudancas[campo];

    if (meta.data) depois = paraData(depois);
    else if (campo === 'telefone') depois = digitsOnly(depois);
    else if (typeof depois === 'string') depois = textoLimpo(depois, campo === 'observacoesInternas' ? 8000 : 300);

    const mesmoValor = meta.data
      ? (antes?.getTime?.() || null) === (depois?.getTime?.() || null)
      : (antes ?? null) === (depois ?? null);
    if (mesmoValor) continue;

    if (campo === 'telefone' && (!depois || depois.length < 10)) {
      throw new Error('Informe um telefone valido com DDD.');
    }

    set[campo] = depois;

    eventos.push({
      clienteId: cliente._id,
      tipo: meta.tipo === 'observacao' ? timeline.TIPOS.OBSERVACAO : timeline.TIPOS[meta.tipo.toUpperCase()] || timeline.TIPOS.CAMPO,
      titulo:
        meta.tipo === 'observacao'
          ? 'Observacao interna atualizada'
          : `${meta.label}: ${legivel(campo, antes)} → ${legivel(campo, depois)}`,
      descricao: meta.tipo === 'observacao' ? textoLimpo(depois, 1000) : null,
      autor,
      dados: { campo, antes: antes ?? null, depois: depois ?? null },
    });
  }

  // Campos sem rastreio individual: mudam, mas nao merecem uma linha cada.
  if (Array.isArray(mudancas.tags)) {
    const novas = mudancas.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20);
    if (novas.join('|') !== (cliente.tags || []).join('|')) {
      set.tags = novas;
      eventos.push({
        clienteId: cliente._id,
        tipo: timeline.TIPOS.CAMPO,
        titulo: `Etiquetas: ${novas.length ? novas.join(', ') : '(nenhuma)'}`,
        autor,
        relevante: false,
      });
    }
  }

  if (mudancas.responsavel !== undefined) {
    const antes = cliente.responsavel?.nome || '(ninguem)';
    const depois = mudancas.responsavel?.nome || '(ninguem)';
    if (antes !== depois) {
      set.responsavel = mudancas.responsavel || null;
      eventos.push({
        clienteId: cliente._id,
        tipo: timeline.TIPOS.RESPONSAVEL,
        titulo: `Responsavel: ${antes} → ${depois}`,
        autor,
        dados: { antes: cliente.responsavel || null, depois: mudancas.responsavel || null },
      });
    }
  }

  if (typeof mudancas.arquivado === 'boolean' && mudancas.arquivado !== Boolean(cliente.arquivado)) {
    set.arquivado = mudancas.arquivado;
    eventos.push({
      clienteId: cliente._id,
      tipo: timeline.TIPOS.SISTEMA,
      titulo: mudancas.arquivado ? 'Ficha arquivada' : 'Ficha reativada',
      autor,
    });
  }

  if (!Object.keys(set).length) return cliente;

  const atualizado = await Cliente.findByIdAndUpdate(id, { $set: set }, { new: true });
  await timeline.registrarVarios(eventos);

  logger.info(
    { ev: EV.CLIENTE_ATUALIZADO, clienteId: id, campos: Object.keys(set), por: usuario?.email },
    'Ficha de cliente atualizada'
  );

  return atualizado;
}

// -------------------------------------------------------------- pendencias

async function adicionarPendencia(id, texto, usuario) {
  const limpo = textoLimpo(texto, 300);
  if (!limpo) throw new Error('Descreva a pendencia.');

  const cliente = await Cliente.findByIdAndUpdate(
    id,
    { $push: { pendencias: { texto: limpo, resolvida: false, criadaEm: new Date() } } },
    { new: true }
  );
  if (!cliente) return null;

  await timeline.registrar({
    clienteId: cliente._id,
    tipo: timeline.TIPOS.PENDENCIA,
    titulo: `Pendencia registrada: ${limpo}`,
    autor: { tipo: 'usuario', id: usuario?.id, nome: usuario?.nome || usuario?.email },
  });

  return cliente;
}

async function resolverPendencia(id, pendenciaId, usuario) {
  const cliente = await Cliente.findById(id);
  if (!cliente) return null;

  const pendencia = cliente.pendencias.id(pendenciaId);
  if (!pendencia || pendencia.resolvida) return cliente;

  pendencia.resolvida = true;
  pendencia.resolvidaEm = new Date();
  await cliente.save();

  await timeline.registrar({
    clienteId: cliente._id,
    tipo: timeline.TIPOS.PENDENCIA,
    titulo: `Pendencia resolvida: ${pendencia.texto}`,
    autor: { tipo: 'usuario', id: usuario?.id, nome: usuario?.nome || usuario?.email },
  });

  return cliente;
}

// ------------------------------------------------------------------- kanban

/**
 * Move um cliente para uma coluna do quadro.
 * A coluna decide qual status aplicar (`statusAoSoltar`).
 */
async function moverParaColuna(id, colunaId, usuario) {
  const coluna = pipeline.atual().colunas.find((c) => c.id === colunaId);
  if (!coluna) throw new Error('Coluna desconhecida.');

  const novoStatus = coluna.statusAoSoltar || coluna.status[0];
  if (!novoStatus) throw new Error('Esta coluna nao tem status associado.');

  return atualizar(id, { status: novoStatus }, usuario);
}

// ------------------------------------------------------------------ filtros

/**
 * Traduz os filtros da tela em consulta.
 *
 * Os tres ultimos sao os que substituem a varredura visual da planilha —
 * "quem esta parado", "o que venceu", "quem esta me esperando".
 */
function montarFiltro(q = {}) {
  const filtro = { arquivado: q.arquivados === 'true' || q.arquivados === true };

  if (q.status) filtro.status = { $in: String(q.status).split(',').filter(Boolean) };
  if (q.etapa) filtro.etapa = { $in: String(q.etapa).split(',').filter(Boolean) };
  if (q.prioridade) filtro.prioridade = { $in: String(q.prioridade).split(',').filter(Boolean) };
  if (q.responsavel) filtro['responsavel.id'] = q.responsavel;
  if (q.tag) filtro.tags = q.tag;

  if (q.comPendencias === 'true' || q.comPendencias === true) {
    filtro['pendencias.resolvida'] = false;
  }

  if (q.acaoVencida === 'true' || q.acaoVencida === true) {
    filtro.proximaAcaoEm = { $ne: null, $lt: new Date() };
  }

  // "Sem atualizacao ha N dias": e a pergunta que a planilha nunca respondeu
  // sem alguem conferir data por data.
  const paradoHa = Number(q.paradoHaDias);
  if (Number.isFinite(paradoHa) && paradoHa > 0) {
    const corte = new Date(Date.now() - paradoHa * 86400000);
    filtro.$or = [{ ultimoContatoEm: { $lt: corte } }, { ultimoContatoEm: null }];
  }

  if (q.de || q.ate) {
    filtro.entradaEm = {};
    if (q.de) filtro.entradaEm.$gte = new Date(q.de);
    if (q.ate) filtro.entradaEm.$lte = new Date(`${q.ate}T23:59:59`);
  }

  const termo = String(q.q || '').trim();
  if (termo) {
    const digitos = digitsOnly(termo);
    const busca = [
      { nome: { $regex: termo, $options: 'i' } },
      { email: { $regex: termo, $options: 'i' } },
      ...(digitos.length >= 4 ? [{ telefone: { $regex: digitos } }] : []),
    ];
    // `$and` porque `$or` ja pode estar ocupado pelo filtro de parado.
    filtro.$and = [...(filtro.$and || []), { $or: busca }];
  }

  return filtro;
}

const ORDENS = {
  recentes: { updatedAt: -1 },
  antigos: { updatedAt: 1 },
  proxima_acao: { proximaAcaoEm: 1 },
  prioridade: { prioridade: -1, updatedAt: -1 },
  sem_contato: { ultimoContatoEm: 1 },
  nome: { nome: 1 },
};

/** Contagem de tarefas por cliente, numa consulta so. */
async function tarefasPorCliente(ids) {
  if (!ids.length) return {};

  const agora = new Date();
  const linhas = await Tarefa.aggregate([
    { $match: { clienteId: { $in: ids }, status: 'aberta' } },
    {
      $group: {
        _id: '$clienteId',
        abertas: { $sum: 1 },
        vencidas: {
          $sum: { $cond: [{ $and: [{ $ne: ['$prazo', null] }, { $lt: ['$prazo', agora] }] }, 1, 0] },
        },
      },
    },
  ]);

  return Object.fromEntries(
    linhas.map((l) => [l._id.toString(), { abertas: l.abertas, vencidas: l.vencidas }])
  );
}

async function listar(q = {}) {
  const filtro = montarFiltro(q);
  const limite = Math.min(200, Math.max(1, Number(q.limite) || 50));
  const pular = Math.max(0, Number(q.pular) || 0);

  const [docs, total] = await Promise.all([
    Cliente.find(filtro)
      .sort(ORDENS[q.ordem] || ORDENS.recentes)
      .skip(pular)
      .limit(limite)
      .lean(),
    Cliente.countDocuments(filtro),
  ]);

  const tarefas = await tarefasPorCliente(docs.map((d) => d._id));

  return {
    clientes: docs.map((d) => resumo(d, { tarefas: tarefas[d._id.toString()] })),
    total,
    limite,
    pular,
  };
}

/**
 * Quadro kanban: os mesmos filtros da lista, agrupados por coluna.
 *
 * Cada coluna traz o total real e apenas os primeiros cartoes. Carregar mil
 * fichas para desenhar cinco colunas travaria a tela — e ninguem arrasta o
 * cartao numero 300.
 */
async function kanban(q = {}, porColuna = 50) {
  const filtro = montarFiltro(q);
  const colunas = pipeline.atual().colunas.slice().sort((a, b) => a.ordem - b.ordem);

  const resultado = await Promise.all(
    colunas.map(async (coluna) => {
      const daColuna = { ...filtro, status: { $in: coluna.status } };

      const [docs, total] = await Promise.all([
        Cliente.find(daColuna).sort({ prioridade: -1, updatedAt: -1 }).limit(porColuna).lean(),
        Cliente.countDocuments(daColuna),
      ]);

      const tarefas = await tarefasPorCliente(docs.map((d) => d._id));

      return {
        id: coluna.id,
        label: coluna.label,
        cor: coluna.cor,
        total,
        clientes: docs.map((d) => resumo(d, { tarefas: tarefas[d._id.toString()] })),
      };
    })
  );

  return { colunas: resultado };
}

// ------------------------------------------------------- sinais do WhatsApp

/**
 * Registra na ficha que houve conversa. Chamado pela ponte do WhatsApp.
 *
 * Uma mensagem NAO e evento relevante para o resumo: se fosse, um "bom dia"
 * marcaria o resumo como desatualizado e a IA rodaria a cada troca. O que
 * marca sao mudancas de estado — e o proprio texto entra no resumo pela
 * leitura das mensagens, nao pela timeline.
 */
async function registrarInteracao({ telefone, nome, channelId, chatId, direcao, texto }) {
  const cliente = await garantirDoWhatsApp({ telefone, nome, channelId, chatId });
  if (!cliente) return null;

  await Cliente.updateOne({ _id: cliente._id }, { $set: { ultimoContatoEm: new Date() } });

  await timeline.registrar({
    clienteId: cliente._id,
    tipo: timeline.TIPOS.MENSAGEM,
    titulo: direcao === 'in' ? 'Mensagem recebida' : 'Resposta enviada',
    descricao: textoLimpo(texto, 400) || null,
    autor: { tipo: direcao === 'in' ? 'cliente' : 'agente', nome: nome || null },
    dados: { channelId, chatId },
    relevante: false,
  });

  return cliente;
}

// ----------------------------------------------------------------- exclusao

async function remover(id, usuario) {
  const cliente = await Cliente.findById(id);
  if (!cliente) return false;

  await Promise.all([
    timeline.apagarDoCliente(cliente._id),
    Tarefa.deleteMany({ clienteId: cliente._id }),
    Cliente.deleteOne({ _id: cliente._id }),
  ]);

  logger.warn(
    { ev: EV.CLIENTE_REMOVIDO, clienteId: id, telefone: cliente.telefone, por: usuario?.email },
    'Ficha de cliente removida'
  );

  return true;
}

module.exports = {
  CAMPOS_RASTREADOS,
  garantirIndices,
  porId,
  porTelefone,
  resumo,
  detalhe,
  garantirDoWhatsApp,
  vincularConversa,
  criar,
  atualizar,
  adicionarPendencia,
  resolverPendencia,
  moverParaColuna,
  listar,
  kanban,
  montarFiltro,
  registrarInteracao,
  remover,
};
