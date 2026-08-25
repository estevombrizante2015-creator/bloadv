const { Cliente, Tarefa } = require('../models');
const pipeline = require('./pipeline.service');

/**
 * PAINEL OPERACIONAL
 * ------------------
 * Os numeros que a planilha nunca deu sem alguem contar linha a linha.
 *
 * Cada indicador vem com o FILTRO que o reproduz na lista. E o que transforma
 * o painel de um cartaz em uma ferramenta: ver "7 sem contato ha 7 dias" e
 * inutil se descobrir quem sao esses sete der trabalho. Clicar no numero abre
 * a lista exatamente com aquele recorte.
 *
 * Tudo em uma unica ida ao banco por bloco, com agregacao — contar por status
 * com uma consulta por status seria uma dezena de idas a cada abertura.
 */

const DIAS_SEM_CONTATO = 7;

const contar = (filtro) => Cliente.countDocuments({ arquivado: false, ...filtro });

async function gerar() {
  const agora = new Date();
  const corteSemContato = new Date(Date.now() - DIAS_SEM_CONTATO * 86400000);
  const inicioDoMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
  const conclusivos = pipeline.statusConclusivos();

  const [
    ativos,
    novosNoMes,
    emAndamento,
    comPendencias,
    acaoVencida,
    semContato,
    prioritarios,
    porStatus,
    porEtapa,
    porResponsavel,
    tarefasVencidas,
    tarefasHoje,
  ] = await Promise.all([
    contar({}),
    contar({ entradaEm: { $gte: inicioDoMes } }),
    contar({ status: { $nin: conclusivos } }),
    contar({ 'pendencias.resolvida': false }),
    contar({ proximaAcaoEm: { $ne: null, $lt: agora } }),
    // "$or" cobre quem nunca teve contato registrado: sao justamente os mais
    // esquecidos, e deixa-los de fora esvaziaria o indicador mais util.
    contar({
      status: { $nin: conclusivos },
      $or: [{ ultimoContatoEm: { $lt: corteSemContato } }, { ultimoContatoEm: null }],
    }),
    contar({ prioridade: { $in: ['alta', 'urgente'] }, status: { $nin: conclusivos } }),

    Cliente.aggregate([
      { $match: { arquivado: false } },
      { $group: { _id: '$status', total: { $sum: 1 } } },
    ]),
    Cliente.aggregate([
      { $match: { arquivado: false, etapa: { $ne: null } } },
      { $group: { _id: '$etapa', total: { $sum: 1 } } },
    ]),
    Cliente.aggregate([
      { $match: { arquivado: false, status: { $nin: conclusivos } } },
      {
        $group: {
          _id: { $ifNull: ['$responsavel.id', null] },
          nome: { $first: '$responsavel.nome' },
          total: { $sum: 1 },
        },
      },
      { $sort: { total: -1 } },
    ]),

    Tarefa.countDocuments({ status: 'aberta', prazo: { $ne: null, $lt: agora } }),
    Tarefa.countDocuments({
      status: 'aberta',
      prazo: { $gte: agora, $lte: new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 23, 59, 59) },
    }),
  ]);

  const totalPorStatus = Object.fromEntries(porStatus.map((s) => [s._id, s.total]));
  const daLista = pipeline.atual();

  /** Um numero clicavel: o rotulo, o valor e o filtro que o reproduz. */
  const indicador = (id, label, valor, filtro, tom = 'neutro') => ({
    id,
    label,
    valor,
    filtro,
    tom,
  });

  return {
    indicadores: [
      indicador('ativos', 'Clientes ativos', ativos, {}),
      indicador('novos', 'Novos no mes', novosNoMes, {
        de: inicioDoMes.toISOString().slice(0, 10),
      }),
      indicador('andamento', 'Em andamento', emAndamento, {
        status: daLista.status.filter((s) => !s.conclusivo).map((s) => s.id).join(','),
      }),
      indicador(
        'aguardando',
        'Aguardando retorno',
        daLista.status
          .filter((s) => s.id.startsWith('aguardando'))
          .reduce((soma, s) => soma + (totalPorStatus[s.id] || 0), 0),
        { status: daLista.status.filter((s) => s.id.startsWith('aguardando')).map((s) => s.id).join(',') },
        'atencao'
      ),
      indicador('pendencias', 'Com pendencias', comPendencias, { comPendencias: 'true' }, 'atencao'),
      indicador('acao_vencida', 'Acao vencida', acaoVencida, { acaoVencida: 'true' }, 'alerta'),
      indicador(
        'sem_contato',
        `Sem contato ha ${DIAS_SEM_CONTATO}+ dias`,
        semContato,
        { paradoHaDias: String(DIAS_SEM_CONTATO) },
        'alerta'
      ),
      indicador('prioritarios', 'Prioritarios', prioritarios, { prioridade: 'alta,urgente' }, 'atencao'),
      indicador('tarefas_vencidas', 'Tarefas vencidas', tarefasVencidas, { aba: 'tarefas' }, 'alerta'),
      indicador('tarefas_hoje', 'Tarefas para hoje', tarefasHoje, { aba: 'tarefas' }),
    ],

    porStatus: daLista.status.map((s) => ({
      id: s.id,
      label: s.label,
      cor: s.cor,
      total: totalPorStatus[s.id] || 0,
    })),

    porEtapa: daLista.etapas.map((e) => ({
      id: e.id,
      label: e.label,
      total: porEtapa.find((p) => p._id === e.id)?.total || 0,
    })),

    porResponsavel: porResponsavel.map((r) => ({
      id: r._id,
      nome: r.nome || 'Sem responsavel',
      total: r.total,
    })),

    geradoEm: agora,
  };
}

module.exports = { gerar, DIAS_SEM_CONTATO };
