const { env } = require('../config/env');
const logger = require('../utils/logger');

/**
 * CUSTO DA CONTA OPENAI
 * ---------------------
 * O painel ja mostrava tokens. Token nao e o que o escritorio paga: ele nao
 * diz nada sobre a conta no fim do mes, e "3,2 milhoes de tokens" e uma
 * grandeza que ninguem consegue transformar em decisao. Aqui o numero vira
 * dinheiro — custo de hoje e do mes corrente, na moeda da conta.
 *
 * COMO A OPENAI EXPOE ISSO
 * ------------------------
 * `GET /v1/organization/costs` devolve buckets diarios de custo consolidado, e
 * exige chave de ADMIN da organizacao (`sk-admin-...`) — a chave de uso comum
 * recebe 401 ali. Por isso a chave e propria (`BILLING_OPENAI`).
 *
 * SALDO. Nao existe endpoint publico e atual que devolva "credito restante".
 * O antigo `/dashboard/billing/credit_grants` so responde a chave de sessao do
 * navegador e foi descontinuado para chave de API. Tentamos mesmo assim,
 * porque em algumas contas ele ainda responde — e, quando nao responde, o
 * painel DIZ que o saldo nao esta disponivel em vez de mostrar um numero
 * inventado. Num dado de dinheiro, silencio honesto vale mais que estimativa.
 *
 * Nada aqui derruba o atendimento: erro vira `{ok:false, motivo}` e o painel
 * mostra o motivo.
 */

const BASE = 'https://api.openai.com/v1';

/** Resposta memorizada. A OpenAI consolida custo com atraso; F5 nao ajuda. */
let cache = null;

const agora = () => Date.now();

const inicioDoDiaUTC = () => {
  const d = new Date();
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
};

const inicioDoMesUTC = () => {
  const d = new Date();
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
};

async function pedir(caminho, { timeoutMs }) {
  const controlador = new AbortController();
  const timer = setTimeout(() => controlador.abort(), timeoutMs);

  try {
    const resposta = await fetch(`${BASE}${caminho}`, {
      headers: {
        Authorization: `Bearer ${env.billing.key}`,
        'Content-Type': 'application/json',
      },
      signal: controlador.signal,
    });

    if (!resposta.ok) {
      const corpo = await resposta.text().catch(() => '');
      const erro = new Error(`HTTP ${resposta.status}`);
      erro.status = resposta.status;
      erro.corpo = corpo.slice(0, 300);
      throw erro;
    }

    return resposta.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Traduz o erro da OpenAI para uma frase que quem opera o painel consegue
 * agir. "HTTP 401" nao diz a ninguem que a chave precisa ser de admin.
 */
function explicar(erro) {
  if (erro.name === 'AbortError') {
    return 'A OpenAI nao respondeu a tempo. O custo aparece na proxima atualizacao.';
  }
  if (erro.status === 401) {
    return 'A chave BILLING_OPENAI foi recusada. A leitura de custo exige uma chave de ADMIN da organizacao (comeca com sk-admin), criada em platform.openai.com/settings/organization/admin-keys.';
  }
  if (erro.status === 403) {
    return 'A chave nao tem permissao para ler custos da organizacao. Confira o escopo api.usage.read na chave de admin.';
  }
  if (erro.status === 429) {
    return 'Limite de consultas da OpenAI atingido. A leitura volta sozinha em alguns minutos.';
  }
  return `Nao foi possivel consultar a OpenAI (${erro.message}).`;
}

/** Soma os buckets de custo devolvidos pela API, em dolares. */
function somar(buckets, desde = 0) {
  let total = 0;
  let moeda = 'usd';

  for (const bucket of buckets || []) {
    if (bucket.start_time < desde) continue;
    for (const linha of bucket.results || []) {
      total += Number(linha.amount?.value || 0);
      if (linha.amount?.currency) moeda = linha.amount.currency;
    }
  }

  return { total: Math.round(total * 10000) / 10000, moeda };
}

/**
 * Saldo restante. Endpoint legado: costuma responder 401 para chave de API.
 * Falhar aqui NAO invalida o custo — sao duas leituras independentes.
 */
async function saldo() {
  try {
    const dados = await pedir('/dashboard/billing/credit_grants', {
      timeoutMs: env.billing.timeoutMs,
    });

    return {
      disponivel: true,
      restante: Number(dados.total_available ?? 0),
      concedido: Number(dados.total_granted ?? 0),
      usado: Number(dados.total_used ?? 0),
    };
  } catch (error) {
    return {
      disponivel: false,
      motivo:
        error.status === 401 || error.status === 404
          ? 'A OpenAI nao expoe saldo por chave de API. Consulte o credito em platform.openai.com/settings/organization/billing.'
          : explicar(error),
    };
  }
}

/**
 * @param {object} [opcoes]
 * @param {boolean} [opcoes.forcar] ignora o cache (botao de atualizar do painel)
 */
async function resumo({ forcar = false } = {}) {
  if (!env.billing.key) {
    return {
      ok: false,
      motivo:
        'Leitura de custo nao configurada. Cadastre BILLING_OPENAI no .env com uma chave de admin da organizacao OpenAI.',
    };
  }

  if (!forcar && cache && agora() - cache.em < env.billing.cacheMs) {
    return { ...cache.dados, doCache: true };
  }

  const comecoDoMes = inicioDoMesUTC();

  try {
    const dados = await pedir(
      `/organization/costs?start_time=${comecoDoMes}&bucket_width=1d&limit=31`,
      { timeoutMs: env.billing.timeoutMs }
    );

    const mes = somar(dados.data, comecoDoMes);
    const hoje = somar(dados.data, inicioDoDiaUTC());

    const resultado = {
      ok: true,
      moeda: mes.moeda,
      custoHoje: hoje.total,
      custoMes: mes.total,
      // A OpenAI consolida com atraso de algumas horas; dizer isso evita que a
      // equipe conclua que o agente parou de rodar por ver 0 no comeco do dia.
      observacao: 'A OpenAI consolida o custo com algumas horas de atraso.',
      atualizadoEm: new Date().toISOString(),
      saldo: await saldo(),
    };

    cache = { em: agora(), dados: resultado };
    return resultado;
  } catch (error) {
    logger.warn({ err: error.message, status: error.status }, 'Consulta de custo na OpenAI falhou');

    // Cache vencido ainda serve para nao apagar o numero da tela por uma falha
    // momentanea: melhor um custo de 6 minutos atras, datado, do que um traco.
    if (cache) {
      return { ...cache.dados, doCache: true, aviso: explicar(error) };
    }

    return { ok: false, motivo: explicar(error) };
  }
}

/** Usado pelos testes: o cache e por processo e sobreviveria entre casos. */
const limparCache = () => {
  cache = null;
};

module.exports = { resumo, limparCache, somar, explicar };
