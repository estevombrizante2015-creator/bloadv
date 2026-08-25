const { ClientePipeline } = require('../models');
const logger = require('../utils/logger');

/**
 * PIPELINE: STATUS, ETAPAS E KANBAN
 * ---------------------------------
 * O padrao abaixo e o do enunciado. Ele existe para que a equipe abra a tela e
 * ja encontre a operacao dela desenhada, em vez de uma pagina vazia pedindo
 * configuracao — planilha nenhuma comeca em branco.
 *
 * Tudo aqui e editavel. Os `id` sao estaveis e ficam gravados nas fichas;
 * renomear o rotulo de "Aguardando documentos" para "Falta documento" nao
 * remexe em cliente nenhum.
 *
 * CACHE. Consultado ao montar cada linha de lista e cada cartao do kanban.
 * Invalidado ao salvar; banco fora cai no padrao, que e melhor que uma tela
 * sem colunas.
 */

const STATUS_PADRAO = [
  { id: 'novo', label: 'Novo', cor: 'azul', ordem: 0 },
  { id: 'em_atendimento', label: 'Em atendimento', cor: 'dourado', ordem: 1 },
  { id: 'aguardando_documentos', label: 'Aguardando documentos', cor: 'ambar', ordem: 2 },
  { id: 'aguardando_cliente', label: 'Aguardando cliente', cor: 'ambar', ordem: 3 },
  { id: 'em_analise', label: 'Em analise', cor: 'roxo', ordem: 4 },
  { id: 'aguardando_interno', label: 'Aguardando retorno interno', cor: 'roxo', ordem: 5 },
  { id: 'pendencia', label: 'Pendencia', cor: 'vermelho', ordem: 6 },
  { id: 'concluido', label: 'Concluido', cor: 'verde', ordem: 7, conclusivo: true },
];

const ETAPAS_PADRAO = [
  { id: 'triagem', label: 'Triagem inicial', ordem: 0 },
  { id: 'coleta', label: 'Coleta de documentos', ordem: 1 },
  { id: 'analise', label: 'Analise do caso', ordem: 2 },
  { id: 'proposta', label: 'Proposta e contrato', ordem: 3 },
  { id: 'andamento', label: 'Caso em andamento', ordem: 4 },
  { id: 'encerrado', label: 'Encerrado', ordem: 5, conclusivo: true },
];

/**
 * Cinco colunas, nao oito. Um quadro so e util enquanto cabe na tela inteira;
 * a distincao fina entre "aguardando documentos" e "aguardando cliente"
 * continua viva na ficha e nos filtros.
 */
const COLUNAS_PADRAO = [
  { id: 'novos', label: 'Novos', cor: 'azul', ordem: 0, status: ['novo'], statusAoSoltar: 'novo' },
  {
    id: 'andamento',
    label: 'Em andamento',
    cor: 'dourado',
    ordem: 1,
    status: ['em_atendimento', 'em_analise', 'aguardando_interno'],
    statusAoSoltar: 'em_atendimento',
  },
  {
    id: 'aguardando',
    label: 'Aguardando cliente',
    cor: 'ambar',
    ordem: 2,
    status: ['aguardando_cliente', 'aguardando_documentos'],
    statusAoSoltar: 'aguardando_cliente',
  },
  {
    id: 'pendencias',
    label: 'Pendencias',
    cor: 'vermelho',
    ordem: 3,
    status: ['pendencia'],
    statusAoSoltar: 'pendencia',
  },
  {
    id: 'concluidos',
    label: 'Concluidos',
    cor: 'verde',
    ordem: 4,
    status: ['concluido'],
    statusAoSoltar: 'concluido',
  },
];

const TAGS_PADRAO = [
  'urgente',
  'indicacao',
  'reclamacao',
  'aguardando audiencia',
  'documento pendente',
];

const padrao = () => ({
  status: STATUS_PADRAO.map((s) => ({ ...s })),
  etapas: ETAPAS_PADRAO.map((e) => ({ ...e })),
  colunas: COLUNAS_PADRAO.map((c) => ({ ...c, status: [...c.status] })),
  tags: [...TAGS_PADRAO],
});

let cache = null;

async function carregar() {
  try {
    const doc = await ClientePipeline.findOne({ chave: 'padrao' }).lean();
    cache = doc
      ? { status: doc.status, etapas: doc.etapas, colunas: doc.colunas, tags: doc.tags }
      : padrao();
  } catch (error) {
    logger.warn({ err: error.message }, 'Falha ao carregar o pipeline; usando o padrao');
    cache = padrao();
  }
  return cache;
}

/** Sincrono: roda ao montar cada linha da lista e cada cartao do kanban. */
const atual = () => cache || padrao();

const statusPorId = (id) => atual().status.find((s) => s.id === id) || null;
const etapaPorId = (id) => atual().etapas.find((e) => e.id === id) || null;

/** Rotulo legivel de um status, com recuo seguro para ids orfaos. */
const rotuloStatus = (id) => statusPorId(id)?.label || id || null;
const rotuloEtapa = (id) => etapaPorId(id)?.label || id || null;

/** Primeiro status da lista: onde entra quem acabou de chegar. */
const statusInicial = () => atual().status[0]?.id || 'novo';

/** Status que significam "encerrado", para as contagens do painel. */
const statusConclusivos = () => atual().status.filter((s) => s.conclusivo).map((s) => s.id);

/** Coluna do kanban onde um status aparece. */
function colunaDoStatus(statusId) {
  const colunas = atual().colunas;
  return (
    colunas.find((c) => c.status.includes(statusId)) ||
    // Status que nao foi mapeado em coluna nenhuma nao pode sumir do quadro:
    // vai para a primeira, onde alguem vai reparar nele.
    colunas[0] ||
    null
  );
}

// ------------------------------------------------------------------ escrita

const idDe = (label) =>
  String(label || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);

/** Normaliza o que veio da tela, gerando id para item novo. */
const normalizarItens = (itens, existentes = []) =>
  (Array.isArray(itens) ? itens : []).slice(0, 40).map((item, i) => {
    const label = String(item?.label || '').trim().slice(0, 60);
    // Item ja existente mantem o id; senao, deriva do rotulo. Um id novo a
    // cada salvamento orfanaria as fichas que apontam para o antigo.
    const id = existentes.some((e) => e.id === item?.id) ? item.id : item?.id || idDe(label) || `item_${i}`;
    return {
      id,
      label: label || id,
      cor: String(item?.cor || 'neutro').slice(0, 20),
      ordem: Number.isFinite(Number(item?.ordem)) ? Number(item.ordem) : i,
      conclusivo: Boolean(item?.conclusivo),
    };
  });

async function salvar(entrada, usuario) {
  const antigo = atual();

  const status = normalizarItens(entrada?.status, antigo.status);
  const etapas = normalizarItens(entrada?.etapas, antigo.etapas);

  const idsValidos = new Set(status.map((s) => s.id));

  const colunas = (Array.isArray(entrada?.colunas) ? entrada.colunas : antigo.colunas)
    .slice(0, 12)
    .map((coluna, i) => {
      // Coluna nao pode apontar para status que a equipe acabou de apagar:
      // sobraria um cartao invisivel, que e a pior falha possivel num quadro.
      const doColuna = (Array.isArray(coluna?.status) ? coluna.status : []).filter((s) =>
        idsValidos.has(s)
      );

      return {
        id: coluna?.id || idDe(coluna?.label) || `coluna_${i}`,
        label: String(coluna?.label || '').trim().slice(0, 40) || `Coluna ${i + 1}`,
        cor: String(coluna?.cor || 'neutro').slice(0, 20),
        ordem: Number.isFinite(Number(coluna?.ordem)) ? Number(coluna.ordem) : i,
        status: doColuna,
        statusAoSoltar: idsValidos.has(coluna?.statusAoSoltar)
          ? coluna.statusAoSoltar
          : doColuna[0] || null,
      };
    });

  const tags = [
    ...new Set(
      (Array.isArray(entrada?.tags) ? entrada.tags : antigo.tags)
        .map((t) => String(t || '').trim().toLowerCase())
        .filter(Boolean)
    ),
  ].slice(0, 60);

  if (!status.length) throw new Error('E preciso ter pelo menos um status.');
  if (!colunas.length) throw new Error('E preciso ter pelo menos uma coluna no quadro.');

  await ClientePipeline.findOneAndUpdate(
    { chave: 'padrao' },
    {
      $set: {
        status,
        etapas,
        colunas,
        tags,
        atualizadoPor: { id: usuario?.id, nome: usuario?.nome || usuario?.email },
      },
      $setOnInsert: { chave: 'padrao' },
    },
    { upsert: true }
  );

  cache = { status, etapas, colunas, tags };
  logger.info({ status: status.length, colunas: colunas.length }, 'Pipeline de clientes atualizado');

  return cache;
}

/** Restaura o desenho de fabrica. As fichas nao sao tocadas. */
async function restaurarPadrao(usuario) {
  return salvar(padrao(), usuario);
}

module.exports = {
  carregar,
  atual,
  salvar,
  restaurarPadrao,
  padrao,
  statusPorId,
  etapaPorId,
  rotuloStatus,
  rotuloEtapa,
  statusInicial,
  statusConclusivos,
  colunaDoStatus,
};
