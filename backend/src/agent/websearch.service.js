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
 * O que volta entra no prompt como [WEB] em texto limpo — sem link e sem
 * markdown, porque isso vazava para a conversa. A fonte nao se perde: fica no
 * registro do AgentRun, para o advogado conferir. Os guardrails de saida
 * continuam valendo: nada de conclusao sobre o caso da pessoa.
 *
 * A busca tem DUAS chaves: `WEBSEARCH_ENABLED` no .env (time tecnico) e o
 * interruptor da curadoria (escritorio). Ver `deveBuscar`.
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

  /**
   * PERGUNTA JURIDICA GERAL (secao 8.2 das instrucoes do escritorio)
   * ----------------------------------------------------------------
   * "Quais as causas de rescisao indireta?" nao pede um valor que muda — pede
   * o que a lei e os tribunais dizem hoje. Ate aqui isso nao disparava nada, e
   * o agente respondia so com a base local: verbete curado meses atras, sem
   * saber se mudou.
   *
   * O gatilho exige INSTITUTO + FORMULACAO DE PERGUNTA. Um relato que apenas
   * menciona "justa causa" ("recebi justa causa ontem") nao dispara: nao ha
   * pergunta ali, ha um caso — e caso e do advogado, nao da internet.
   *
   * Perguntas sobre o proprio caso continuam bloqueadas logo abaixo, em
   * BLOQUEIOS: a busca serve para a regra geral, nunca para concluir sobre a
   * situacao de quem escreve.
   */
  /\b(quais|quando|como|o que|em que|cabe|existe|requisito|hip[oó]tese|caracteriza|configura|regra|prev[eê])\b[\s\S]{0,80}\b(rescis[aã]o indireta|justa causa|estabilidade|gestante|insalubridade|periculosidade|aviso pr[eé]vio|horas? extras?|adicional noturno|equipara[cç][aã]o salarial|ac[uú]mulo de fun[cç][aã]o|desvio de fun[cç][aã]o|ass[eé]dio|dano moral|v[ií]nculo empregat[ií]cio|banco de horas|intervalo intrajornada|abandono de emprego|dispensa discriminat[oó]ria)\b/i,
  /\b(rescis[aã]o indireta|justa causa|estabilidade|insalubridade|periculosidade|equipara[cç][aã]o salarial|ass[eé]dio moral|ass[eé]dio sexual|v[ií]nculo empregat[ií]cio)\b[\s\S]{0,80}\b(quais|causas|hip[oó]teses|requisitos|caracteriza|configura|cabe|regra|lei|artigo|s[uú]mula|prazo)\b/i,

  // Sumula, precedente e jurisprudencia: mudam sem aviso e por isso valem consulta.
  /\b(s[uú]mula|precedente|tema repetitivo|jurisprud[eê]ncia|entendimento do tst|decis[aã]o do (tst|stf|stj))\b/i,

  // Norma coletiva e dados publicos da empresa (secoes 8.2 e 8.6).
  /\b(conven[cç][aã]o coletiva|acordo coletivo|diss[ií]dio|norma coletiva|piso da categoria|piso da minha categoria)\b/i,
  /\b(cnpj|raz[aã]o social)\b/i,
];

/**
 * Nunca busca: sao perguntas sobre o caso da pessoa, nao sobre um dado.
 *
 * Vale mais que os gatilhos. Com a pergunta juridica geral agora disparando
 * busca, esta lista e o que separa "quais as causas de rescisao indireta" (a
 * regra, pesquisavel) de "tenho direito a rescisao indireta?" (o caso dela,
 * que so o advogado avalia com os documentos).
 */
const BLOQUEIOS = [
  /\b(meu caso|minha situa[cç][aã]o|eu tenho direito|vou ganhar|quanto vou receber)\b/i,
  /\b(honor[aá]rio|quanto voc[eê]s cobram)\b/i,
  /\b(no meu caso|comigo|na minha empresa|meu chefe|meu patr[aã]o|fui demitid|me demiti)\b/i,
];

/**
 * @param {string} texto             mensagem do contato
 * @param {object} [opcoes]
 * @param {boolean} [opcoes.habilitado] chave da curadoria (aba Midia e pesquisa)
 * @returns {{buscar: boolean, motivo: string}}
 *
 * Duas chaves, de donos diferentes: `env.websearch.enabled` e do time tecnico
 * (custo, chave, contrato) e `habilitado` e do escritorio. A do escritorio nao
 * liga o que a tecnica desligou — quem paga a conta decide primeiro.
 */
function deveBuscar(texto, { habilitado = true } = {}) {
  if (!env.websearch.enabled) return { buscar: false, motivo: 'desabilitado' };
  if (habilitado === false) return { buscar: false, motivo: 'desligado_na_curadoria' };

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
  'Devolva no maximo 3 linhas de TEXTO SIMPLES, uma informacao por linha.',
  'Priorize fontes oficiais: gov.br, planalto.gov.br, inss.gov.br, caixa.gov.br, tst.jus.br.',
  'Traga apenas fato verificavel: valor, data, tabela, endereco, horario.',
  // O valor de 2023 aparecia como se fosse o de hoje quando a pergunta dizia
  // "hoje" e a pagina encontrada era antiga. Exigir a vigencia por extenso
  // obriga a checar a data em vez de repetir o primeiro resultado.
  'Diga sempre desde quando o dado vale, por extenso ("vigente desde janeiro de 2026").',
  'Se houver versao mais recente que a da pagina encontrada, use a mais recente.',
  'NAO opine, NAO interprete lei, NAO fale sobre casos concretos.',
  // O texto vai para dentro do prompt de uma conversa de WhatsApp. Link,
  // markdown e marcador de citacao vazam para a resposta do agente e a fazem
  // parecer copiada de um site — a limpeza abaixo e a rede, isto e o pedido.
  'NAO use links, markdown, asterisco, colchete ou nota de rodape. So frases.',
  'Se nao encontrar dado confiavel e atual, responda exatamente: SEM_DADO',
].join('\n');

/**
 * FORMATACAO DO RESULTADO
 * -----------------------
 * O modelo de busca devolve markdown com a fonte embutida:
 *
 *   "O salario minimo e R$ 1.621,00 ([gov.br](https://www.gov.br/...?utm_source=openai))"
 *
 * Isso entra no prompt e sai na conversa como um pedaco de pagina colado no
 * WhatsApp — parenteses soltos, endereco com parametro de rastreio, colchete
 * no meio da frase. E o oposto do registro do escritorio.
 *
 * A origem NAO se perde: `fontes` e extraida antes da limpeza e vai para o
 * AgentRun, onde o advogado consegue conferir. Ao contato vai so o fato, em
 * texto corrido — que e exatamente o que o escritorio pediu em §8.7 das
 * instrucoes: explicacao curta ao cliente, fonte registrada para o advogado.
 */
function formatarParaConversa(bruto) {
  return String(bruto || '')
    // [rotulo](url) -> rotulo
    .replace(/\[([^\]\n]*)\]\((?:https?:)?\/\/[^)\s]*\)/gi, '$1')
    // marcador de citacao do modelo e nota de rodape
    .replace(/【[^】]*】/g, '')
    .replace(/\[\^?\d+\]/g, '')
    // parentese que sobrou contendo so um dominio ou endereco
    .replace(/\(\s*(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/[^)\s]*)?\s*\)/gi, '')
    // endereco solto
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '')
    // enfase e cabecalho de markdown
    .replace(/[*_`#>]+/g, '')
    // marcadores de lista variados viram um so
    .replace(/^[\t ]*[•·‣▪–—-]\s+/gm, '- ')
    // sobras da remocao: parenteses vazios, espaco antes de pontuacao
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map((linha) => linha.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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

    const bruto = (resposta.output_text || '').trim();
    const latencyMs = Date.now() - inicio;

    if (!bruto || bruto.includes('SEM_DADO')) {
      logger.info({ channelId, chatId, latencyMs }, 'Busca web sem dado confiavel');
      return { ok: false, motivo: 'sem_dado' };
    }

    // As URLs sao colhidas ANTES da limpeza: elas vao para o registro do
    // AgentRun (o advogado confere a origem), nunca para a conversa.
    const fontes = [...new Set((bruto.match(/https?:\/\/[^\s)\]]+/g) || []).slice(0, 5))].map(
      // O parametro de rastreio que a API acrescenta nao ajuda a conferir nada.
      (url) => url.replace(/[?&]utm_source=openai\b/, '')
    );

    const texto = formatarParaConversa(bruto);

    if (!texto) {
      logger.info({ channelId, chatId, latencyMs }, 'Busca web so devolveu fonte, sem fato');
      return { ok: false, motivo: 'sem_dado' };
    }

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

module.exports = { deveBuscar, buscar, formatarParaConversa, GATILHOS, BLOQUEIOS };
