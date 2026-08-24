const { env } = require('../config/env');
const { getClient } = require('./openai.service');
const logger = require('../utils/logger');

/**
 * CONSULTA NA INTERNET, EM TEMPO REAL
 * -----------------------------------
 * Usada com parcimonia, por tres motivos:
 *
 *  1. Custo humano. Num escritorio de advocacia, repetir o que "a internet
 *     diz" sobre um caso e pior do que nao responder. A busca serve para DADO
 *     QUE MUDA (valor vigente, tabela do ano, endereco de orgao), nunca para
 *     formar opiniao juridica.
 *  2. Latencia. A busca acontece antes da geracao, entao entra no tempo de
 *     resposta. Por isso ha gatilho estreito e timeout curto.
 *  3. Custo em tokens.
 *
 * O que volta entra no prompt como [WEB], sempre com a fonte, e os guardrails
 * de saida continuam valendo: nada de conclusao sobre o caso da pessoa.
 */

/**
 * So dispara quando a pergunta depende de algo que muda com o tempo.
 * "Fui demitido, e agora?" NAO busca. "Qual o salario minimo hoje?" busca.
 */
const GATILHOS = [
  // valores e tabelas que mudam por ano
  /\b(sal[aá]rio m[ií]nimo|piso salarial|teto do inss|teto previdenci[aá]rio)\b/i,
  /\b(tabela|al[ií]quota|[ií]ndice|corre[cç][aã]o monet[aá]ria|juros de mora)\b.{0,30}\b(inss|fgts|irrf|tr|selic|inpc|ipca)\b/i,
  /\b(fgts|inss|irrf|pis|pasep)\b.{0,25}\b(valor|tabela|al[ií]quota|hoje|atual|vigente|\d{4})\b/i,
  // Bidirecional: "valor das parcelas do seguro-desemprego" e "seguro-desemprego,
  // qual o valor" sao a mesma pergunta com a ordem trocada.
  /\b(seguro-?desemprego)\b.{0,40}\b(valor|parcela|faixa|tabela)\b/i,
  /\b(valor|parcela|faixa|tabela)\b.{0,40}\b(seguro-?desemprego)\b/i,
  // referencias temporais explicitas
  /\b(hoje|atualmente|agora|neste ano|este ano|vigente|atualizad[oa])\b.{0,40}\b(valor|tabela|regra|lei|norma|indice)\b/i,
  /\bem 20\d{2}\b.{0,30}\b(valor|tabela|regra|mudou|alterou)\b/i,
  // mudanca de regra
  /\b(mudou|mudan[cç]a|nova regra|nova lei|entrou em vigor|reforma)\b.{0,30}\b(trabalhista|clt|inss|fgts)\b/i,
  // orgaos e servicos publicos
  /\b(endere[cç]o|telefone|hor[aá]rio|agendamento)\b.{0,30}\b(inss|caixa|minist[eé]rio do trabalho|superintend[eê]ncia|trt|justi[cç]a do trabalho)\b/i,
];

/** Nunca busca: sao perguntas sobre o caso da pessoa, nao sobre um dado. */
const BLOQUEIOS = [
  /\b(meu caso|minha situa[cç][aã]o|eu tenho direito|vou ganhar|quanto vou receber)\b/i,
  /\b(honor[aá]rio|quanto voc[eê]s cobram)\b/i,
];

/**
 * @returns {{buscar: boolean, motivo: string}}
 */
function deveBuscar(texto) {
  if (!env.websearch.enabled) return { buscar: false, motivo: 'desabilitado' };

  const conteudo = String(texto || '');
  if (conteudo.length < 8) return { buscar: false, motivo: 'curto_demais' };

  if (BLOQUEIOS.some((re) => re.test(conteudo))) {
    return { buscar: false, motivo: 'pergunta_sobre_o_caso' };
  }

  const gatilho = GATILHOS.findIndex((re) => re.test(conteudo));
  if (gatilho === -1) return { buscar: false, motivo: 'sem_gatilho' };

  return { buscar: true, motivo: `gatilho_${gatilho}` };
}

const INSTRUCOES = [
  'Voce pesquisa DADOS OBJETIVOS e atuais para um escritorio de advocacia trabalhista no Brasil.',
  '',
  'Devolva no maximo 3 linhas, cada uma com um dado e a fonte entre parenteses.',
  'Priorize fontes oficiais: gov.br, planalto.gov.br, inss.gov.br, caixa.gov.br, tst.jus.br.',
  'Traga apenas fato verificavel: valor, data, tabela, endereco, horario.',
  'NAO opine, NAO interprete lei, NAO fale sobre casos concretos.',
  'Se nao encontrar dado confiavel e atual, responda exatamente: SEM_DADO',
].join('\n');

/**
 * Executa a busca. Nunca lanca e nunca demora mais que o timeout configurado:
 * uma busca lenta nao pode segurar a resposta ao contato.
 *
 * @returns {Promise<{ok: boolean, texto?: string, fontes?: string[], motivo?: string}>}
 */
async function buscar({ pergunta, channelId, chatId }) {
  const inicio = Date.now();

  try {
    const resposta = await Promise.race([
      getClient().responses.create({
        model: env.websearch.model,
        tools: [{ type: 'web_search' }],
        tool_choice: 'auto',
        max_output_tokens: 500,
        input: [
          { role: 'system', content: INSTRUCOES },
          { role: 'user', content: pergunta },
        ],
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), env.websearch.timeoutMs)
      ),
    ]);

    const texto = (resposta.output_text || '').trim();
    const latencyMs = Date.now() - inicio;

    if (!texto || texto.includes('SEM_DADO')) {
      logger.info({ channelId, chatId, latencyMs }, 'Busca web sem dado confiavel');
      return { ok: false, motivo: 'sem_dado' };
    }

    // Coleta as URLs citadas para poder mostrar a origem no painel.
    const fontes = [...new Set((texto.match(/https?:\/\/[^\s)]+/g) || []).slice(0, 5))];

    logger.info(
      { channelId, chatId, latencyMs, chars: texto.length, fontes: fontes.length },
      'Busca web concluida'
    );

    return {
      ok: true,
      texto: texto.slice(0, 700),
      fontes,
      latencyMs,
      usage: {
        prompt: resposta.usage?.input_tokens || 0,
        completion: resposta.usage?.output_tokens || 0,
        total: resposta.usage?.total_tokens || 0,
      },
    };
  } catch (error) {
    // Busca e um extra: falhar aqui nao pode derrubar o atendimento.
    logger.warn(
      { channelId, chatId, err: error.message, latencyMs: Date.now() - inicio },
      'Busca web falhou; seguindo sem ela'
    );
    return { ok: false, motivo: error.message === 'timeout' ? 'timeout' : 'erro' };
  }
}

module.exports = { deveBuscar, buscar, GATILHOS, BLOQUEIOS };
