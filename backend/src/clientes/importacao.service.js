const { Cliente, User } = require('../models');
const { digitsOnly, comDdiBrasil } = require('../config/agents.config');
const pipeline = require('./pipeline.service');
const timeline = require('./timeline.service');
const csv = require('./csv');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');

/**
 * IMPORTACAO DA PLANILHA
 * ----------------------
 * O caminho de saida da planilha. Sem ele, adotar o modulo de clientes custa
 * preencher a carteira inteira a mao — e nenhum escritorio faz isso.
 *
 * TRES DECISOES SUSTENTAM O RESTO:
 *
 * 1. O MAPEAMENTO E DO USUARIO, NAO DO CODIGO. As colunas sao sugeridas pelo
 *    titulo, mas quem decide e quem conhece a planilha. Cravar os nomes de uma
 *    planilha especifica funcionaria uma vez e quebraria na proxima aba.
 *
 * 2. O QUE NAO SE ENTENDE, SE GUARDA. Coluna sem destino conhecido vira campo
 *    extra da ficha, com o titulo original. "Parte contraria" e "numero do
 *    processo" sao a substancia do caso: descarta-las tornaria a importacao
 *    inutil, e enfia-las nas observacoes transformaria dado em texto corrido.
 *
 * 3. NADA E INVENTADO. Valor que nao casa com nenhum status (o "SIM" da coluna
 *    AJUIZADO, por exemplo) NAO vira um status escolhido a esmo: a ficha fica
 *    com o status inicial e o valor original e preservado como campo extra. A
 *    previa diz quantas linhas cairam nesse caso.
 */

// ------------------------------------------------------------------ destinos

/** Para onde uma coluna da planilha pode ir. */
const DESTINOS = [
  { id: 'ignorar', label: 'Ignorar', descricao: 'A coluna nao entra na ficha.' },
  {
    id: 'extra',
    label: 'Guardar como campo da planilha',
    descricao: 'Aparece na ficha com o titulo original. Padrao para o que o sistema nao modela.',
  },
  { id: 'nome', label: 'Nome do cliente', descricao: 'Obrigatorio: sem nome nao ha ficha.' },
  { id: 'telefone', label: 'Telefone' },
  { id: 'email', label: 'E-mail' },
  { id: 'responsavel', label: 'Responsavel', descricao: 'Casa com um usuario do painel pelo nome.' },
  { id: 'status', label: 'Status' },
  { id: 'etapa', label: 'Etapa do processo' },
  { id: 'entradaEm', label: 'Data de entrada' },
  { id: 'aguardando', label: 'O que estamos aguardando' },
  { id: 'proximaAcao', label: 'Proxima acao' },
  { id: 'proximaAcaoEm', label: 'Data da proxima acao' },
  { id: 'prioridade', label: 'Prioridade' },
  { id: 'tags', label: 'Etiquetas', descricao: 'Varios valores separados por virgula.' },
  { id: 'observacoesInternas', label: 'Observacoes internas' },
  { id: 'pendencia', label: 'Pendencia', descricao: 'Vira uma pendencia em aberto na ficha.' },
];

const semAcento = (texto) =>
  String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Titulos que sugerem cada destino.
 *
 * A ordem importa: o primeiro que casar vence, e os mais especificos vem
 * antes. "documento faltante" precisa ganhar de "documento" solto.
 */
const APELIDOS = [
  ['pendencia', ['observacoes pendencias', 'obs pendencias', 'pendencias', 'pendencia']],
  ['proximaAcaoEm', ['data da proxima acao', 'prazo', 'vencimento', 'data limite']],
  ['proximaAcao', ['proxima acao', 'proximo passo', 'acao necessaria']],
  ['aguardando', ['documento faltante', 'documentos faltantes', 'aguardando', 'o que falta', 'falta']],
  ['nome', ['cliente', 'nome do cliente', 'nome', 'requerente', 'reclamante', 'autor']],
  ['telefone', ['telefone', 'celular', 'whatsapp', 'fone', 'tel', 'contato']],
  ['email', ['email', 'e mail']],
  ['responsavel', ['responsavel', 'advogado', 'advogada', 'atendente', 'atendimento por']],
  ['entradaEm', ['data de entrada', 'data entrada', 'data', 'entrada', 'cadastro']],
  ['status', ['status', 'situacao', 'ajuizado', 'andamento']],
  ['etapa', ['etapa', 'fase', 'estagio']],
  ['prioridade', ['prioridade', 'urgencia']],
  ['tags', ['natureza da demanda', 'etiquetas', 'tags', 'area', 'tipo de demanda']],
  ['observacoesInternas', ['observacoes internas', 'observacoes', 'observacao', 'anotacoes', 'obs']],
];

/**
 * Sugere um destino para cada coluna.
 *
 * O padrao de quem nao casa e `extra`, e nao `ignorar`: perder uma coluna em
 * silencio e o erro caro aqui — o escritorio so descobre semanas depois, com a
 * planilha ja arquivada.
 */
function sugerirMapeamento(colunas) {
  const usados = new Set();
  const mapa = {};

  for (const coluna of colunas) {
    const normalizado = semAcento(coluna);
    let destino = 'extra';

    for (const [id, apelidos] of APELIDOS) {
      // Campos de valor unico nao podem receber duas colunas; `tags`, `extra` e
      // `pendencia` aceitam varias.
      if (usados.has(id) && !['tags', 'extra', 'pendencia'].includes(id)) continue;

      if (apelidos.some((a) => normalizado === a || normalizado.startsWith(`${a} `))) {
        destino = id;
        usados.add(id);
        break;
      }
    }

    mapa[coluna] = destino;
  }

  return mapa;
}

// ---------------------------------------------------------------- conversoes

/**
 * Marcadores de sim/nao usados nas planilhas.
 *
 * Testado sobre o texto SEM ACENTO de proposito: a coluna se chama "NÃO" na
 * planilha real, e um `/^nao$/i` cru nao casa com ela. O resultado silencioso
 * era uma pendencia chamada "NÃO" em toda ficha — informacao nenhuma ocupando
 * o lugar do que trava o caso.
 */
const marcadorSimNao = (texto) => /^(sim|nao|s|n|true|false|x|-)$/.test(semAcento(texto));

/** Data em pt-BR ou ISO. Devolve null quando nao da para ter certeza. */
function paraData(valor) {
  const texto = String(valor || '').trim();
  if (!texto) return null;

  const br = texto.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (br) {
    const [, dia, mes, ano] = br;
    const anoCheio = ano.length === 2 ? `20${ano}` : ano;
    const data = new Date(Number(anoCheio), Number(mes) - 1, Number(dia));
    return Number.isNaN(data.getTime()) ? null : data;
  }

  const iso = texto.match(/^\d{4}-\d{2}-\d{2}/);
  if (iso) {
    const data = new Date(texto);
    return Number.isNaN(data.getTime()) ? null : data;
  }

  return null;
}

/**
 * Casa um texto livre com um item do pipeline (status ou etapa).
 *
 * Só aceita correspondencia clara — igual ao id, igual ao rotulo, ou um
 * contendo o outro. Adivinhar por semelhanca colocaria o cliente numa coluna
 * errada do quadro, que e pior do que deixa-lo no status inicial.
 */
function casarComPipeline(valor, itens) {
  const alvo = semAcento(valor);
  if (!alvo) return null;

  const exato = itens.find((i) => semAcento(i.id) === alvo || semAcento(i.label) === alvo);
  if (exato) return exato.id;

  const contido = itens.find((i) => {
    const rotulo = semAcento(i.label);
    return rotulo.includes(alvo) || alvo.includes(rotulo);
  });

  return contido?.id || null;
}

const PRIORIDADES = ['baixa', 'normal', 'alta', 'urgente'];

const casarPrioridade = (valor) => {
  const alvo = semAcento(valor);
  if (PRIORIDADES.includes(alvo)) return alvo;
  if (/urgent|urgencia/.test(alvo)) return 'urgente';
  if (/alta|alto/.test(alvo)) return 'alta';
  if (/baixa|baixo/.test(alvo)) return 'baixa';
  return null;
};

/** Chave de deduplicacao: telefone quando existe, senao o nome normalizado. */
const chaveDe = (cliente) =>
  cliente.telefone ? `tel:${cliente.telefone}` : `nome:${semAcento(cliente.nome)}`;

// --------------------------------------------------------------- conversao

/**
 * Uma linha da planilha vira um rascunho de ficha.
 *
 * @returns {{cliente: object, avisos: string[]}}
 */
function converterLinha(registro, mapeamento, contexto) {
  const cliente = { camposExtras: [], tags: [], pendencias: [] };
  const avisos = [];

  for (const [coluna, valor] of Object.entries(registro)) {
    const texto = String(valor || '').trim();
    const destino = mapeamento[coluna] || 'ignorar';

    if (destino === 'ignorar' || !texto) continue;

    switch (destino) {
      case 'nome':
        cliente.nome = texto.slice(0, 120);
        break;

      case 'telefone': {
        const numero = comDdiBrasil(texto);
        // Numero curto demais nao e telefone. Guardar mesmo assim criaria uma
        // identidade falsa — e telefone e a chave que liga a ficha ao WhatsApp.
        if (numero && digitsOnly(numero).length >= 12) cliente.telefone = numero;
        else avisos.push(`telefone ignorado (nao parece valido): "${texto}"`);
        break;
      }

      case 'email':
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(texto)) cliente.email = texto.toLowerCase();
        else avisos.push(`e-mail ignorado: "${texto}"`);
        break;

      case 'responsavel': {
        const usuario = contexto.usuarios.find(
          (u) => semAcento(u.nome) === semAcento(texto) || semAcento(u.nome).startsWith(semAcento(texto))
        );
        if (usuario) {
          cliente.responsavel = { id: usuario.id, nome: usuario.nome, email: usuario.email };
        } else {
          // O nome fica registrado mesmo sem usuario correspondente: e
          // informacao real da planilha, e some se for descartada.
          cliente.camposExtras.push({ rotulo: coluna, valor: texto });
          avisos.push(`"${texto}" nao e um usuario do painel; guardado como campo da planilha`);
        }
        break;
      }

      case 'status': {
        const id = casarComPipeline(texto, contexto.status);
        if (id) cliente.status = id;
        else {
          cliente.camposExtras.push({ rotulo: coluna, valor: texto });
          avisos.push(`status "${texto}" nao existe no quadro; ficha entra no status inicial`);
        }
        break;
      }

      case 'etapa': {
        const id = casarComPipeline(texto, contexto.etapas);
        if (id) cliente.etapa = id;
        else {
          cliente.camposExtras.push({ rotulo: coluna, valor: texto });
          avisos.push(`etapa "${texto}" nao existe; guardada como campo da planilha`);
        }
        break;
      }

      case 'prioridade': {
        const p = casarPrioridade(texto);
        if (p) cliente.prioridade = p;
        else cliente.camposExtras.push({ rotulo: coluna, valor: texto });
        break;
      }

      case 'entradaEm':
      case 'proximaAcaoEm': {
        const data = paraData(texto);
        if (data) cliente[destino] = data;
        else {
          cliente.camposExtras.push({ rotulo: coluna, valor: texto });
          avisos.push(`data "${texto}" nao reconhecida; guardada como campo da planilha`);
        }
        break;
      }

      case 'tags':
        for (const tag of texto.split(/[,;/]/)) {
          const limpa = tag.trim().toLowerCase();
          if (limpa && !cliente.tags.includes(limpa)) cliente.tags.push(limpa.slice(0, 40));
        }
        break;

      case 'pendencia':
        // "SIM"/"NAO" diz que existe pendencia, mas nao QUAL — e uma pendencia
        // chamada "SIM" na ficha nao ajuda ninguem. O valor vira campo extra.
        if (marcadorSimNao(texto)) cliente.camposExtras.push({ rotulo: coluna, valor: texto });
        else cliente.pendencias.push({ texto: texto.slice(0, 300), resolvida: false, criadaEm: new Date() });
        break;

      case 'aguardando':
      case 'proximaAcao':
        cliente[destino] = texto.slice(0, 300);
        break;

      case 'observacoesInternas':
        cliente.observacoesInternas = [cliente.observacoesInternas, `${coluna}: ${texto}`]
          .filter(Boolean)
          .join('\n')
          .slice(0, 8000);
        break;

      case 'extra':
      default:
        cliente.camposExtras.push({ rotulo: coluna, valor: texto.slice(0, 2000) });
        break;
    }
  }

  return { cliente, avisos };
}

// ----------------------------------------------------------------- analise

/** Usuarios e pipeline, carregados uma vez para a importacao inteira. */
async function montarContexto() {
  const usuarios = await User.find({ active: true }, { name: 1, email: 1 }).lean();
  const atual = pipeline.atual();

  return {
    usuarios: usuarios.map((u) => ({ id: u._id.toString(), nome: u.name || u.email, email: u.email })),
    status: atual.status,
    etapas: atual.etapas,
  };
}

/**
 * Le o arquivo e devolve tudo o que a tela precisa para o mapeamento — sem
 * gravar nada.
 */
async function analisar(bytes) {
  const lido = csv.ler(bytes);
  if (lido.erro) return lido;

  return {
    ...lido,
    // Amostra para a tela conferir se as colunas estao no lugar certo.
    amostra: lido.registros.slice(0, 5),
    mapeamentoSugerido: sugerirMapeamento(lido.colunas),
    destinos: DESTINOS,
  };
}

/**
 * Simula a importacao: converte todas as linhas, resolve duplicatas contra o
 * banco e devolve o que aconteceria — sem gravar.
 */
async function prever(bytes, mapeamento, { atualizarExistentes = false } = {}) {
  const lido = csv.ler(bytes);
  if (lido.erro) return lido;

  const contexto = await montarContexto();

  const novos = [];
  const atualizados = [];
  const semNome = [];
  const duplicadosNoArquivo = [];
  const avisos = [];
  const vistos = new Set();

  for (const [indice, registro] of lido.registros.entries()) {
    const linha = lido.linhaDoCabecalho + indice + 1;
    const { cliente, avisos: avisosLinha } = converterLinha(registro, mapeamento, contexto);

    if (!cliente.nome) {
      semNome.push({ linha, motivo: 'sem nome do cliente' });
      continue;
    }

    const chave = chaveDe(cliente);
    if (vistos.has(chave)) {
      duplicadosNoArquivo.push({ linha, nome: cliente.nome });
      continue;
    }
    vistos.add(chave);

    for (const aviso of avisosLinha) avisos.push({ linha, nome: cliente.nome, aviso });

    const existente = cliente.telefone
      ? await Cliente.findOne({ telefone: cliente.telefone }, { nome: 1 }).lean()
      : await Cliente.findOne(
          { nome: new RegExp(`^${cliente.nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
          { nome: 1 }
        ).lean();

    if (existente) atualizados.push({ linha, cliente, existenteId: existente._id.toString() });
    else novos.push({ linha, cliente });
  }

  return {
    ...lido,
    registros: undefined, // a tela nao precisa do arquivo inteiro de volta
    resumo: {
      totalNoArquivo: lido.total,
      novos: novos.length,
      jaExistem: atualizados.length,
      seraoAtualizados: atualizarExistentes ? atualizados.length : 0,
      semNome: semNome.length,
      duplicadosNoArquivo: duplicadosNoArquivo.length,
      comAviso: new Set(avisos.map((a) => a.linha)).size,
    },
    // Prévia do que sera criado, ja com os rotulos resolvidos.
    exemplos: novos.slice(0, 8).map(({ linha, cliente }) => ({
      linha,
      nome: cliente.nome,
      telefone: cliente.telefone || null,
      status: pipeline.rotuloStatus(cliente.status || pipeline.statusInicial()),
      etapa: cliente.etapa ? pipeline.rotuloEtapa(cliente.etapa) : null,
      responsavel: cliente.responsavel?.nome || null,
      tags: cliente.tags,
      pendencias: cliente.pendencias.map((p) => p.texto),
      camposExtras: cliente.camposExtras,
    })),
    problemas: { semNome, duplicadosNoArquivo, avisos: avisos.slice(0, 40) },
  };
}

// --------------------------------------------------------------- gravacao

/**
 * Grava de verdade.
 *
 * `atualizarExistentes` preenche apenas o que esta VAZIO na ficha atual. Uma
 * planilha e quase sempre mais antiga que o sistema — sobrescrever com ela
 * apagaria o trabalho feito no painel desde a ultima exportacao.
 */
async function importar(bytes, mapeamento, { atualizarExistentes = false, usuario } = {}) {
  const lido = csv.ler(bytes);
  if (lido.erro) return lido;

  const contexto = await montarContexto();
  const autor = { tipo: 'usuario', id: usuario?.id, nome: usuario?.nome || usuario?.email };

  let criados = 0;
  let atualizados = 0;
  let ignorados = 0;
  const erros = [];
  const vistos = new Set();

  for (const [indice, registro] of lido.registros.entries()) {
    const linha = lido.linhaDoCabecalho + indice + 1;

    try {
      const { cliente } = converterLinha(registro, mapeamento, contexto);
      if (!cliente.nome) {
        ignorados += 1;
        continue;
      }

      const chave = chaveDe(cliente);
      if (vistos.has(chave)) {
        ignorados += 1;
        continue;
      }
      vistos.add(chave);

      const existente = cliente.telefone
        ? await Cliente.findOne({ telefone: cliente.telefone })
        : await Cliente.findOne({
            nome: new RegExp(`^${cliente.nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
          });

      if (existente) {
        if (!atualizarExistentes) {
          ignorados += 1;
          continue;
        }

        const preencher = {};
        for (const campo of [
          'telefone',
          'email',
          'etapa',
          'aguardando',
          'proximaAcao',
          'proximaAcaoEm',
          'entradaEm',
        ]) {
          if (cliente[campo] && !existente[campo]) preencher[campo] = cliente[campo];
        }
        if (cliente.responsavel && !existente.responsavel?.id) {
          preencher.responsavel = cliente.responsavel;
        }
        if (cliente.tags.length) {
          preencher.tags = [...new Set([...(existente.tags || []), ...cliente.tags])];
        }
        if (cliente.camposExtras.length && !existente.camposExtras?.length) {
          preencher.camposExtras = cliente.camposExtras;
        }

        if (Object.keys(preencher).length) {
          await Cliente.updateOne({ _id: existente._id }, { $set: preencher });
          await timeline.registrar({
            clienteId: existente._id,
            tipo: timeline.TIPOS.SISTEMA,
            titulo: 'Ficha completada pela importacao da planilha',
            descricao: `Campos preenchidos: ${Object.keys(preencher).join(', ')}`,
            autor,
            relevante: false,
          });
          atualizados += 1;
        } else {
          ignorados += 1;
        }
        continue;
      }

      const criado = await Cliente.create({
        ...cliente,
        status: cliente.status || pipeline.statusInicial(),
        entradaEm: cliente.entradaEm || new Date(),
        origem: 'importacao',
      });

      await timeline.registrar({
        clienteId: criado._id,
        tipo: timeline.TIPOS.ENTRADA,
        titulo: 'Cliente importado da planilha',
        descricao: `Linha ${linha} do arquivo.`,
        autor,
      });

      criados += 1;
    } catch (error) {
      // Uma linha ruim nao pode derrubar a importacao inteira: o escritorio
      // teria de corrigir a planilha e recomecar do zero.
      erros.push({ linha, erro: error.message });
    }
  }

  logger.info(
    { ev: EV.CLIENTES_IMPORTADOS, criados, atualizados, ignorados, erros: erros.length, por: usuario?.email },
    'Importacao de clientes concluida'
  );

  return { criados, atualizados, ignorados, erros, total: lido.total };
}

module.exports = {
  DESTINOS,
  analisar,
  prever,
  importar,
  sugerirMapeamento,
  converterLinha,
  paraData,
  casarComPipeline,
  casarPrioridade,
  semAcento,
  montarContexto,
};
