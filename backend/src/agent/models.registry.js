const { env } = require('../config/env');

/**
 * REGISTRO DE TIERS
 * -----------------
 * mini / sol / luna / terra nao sao ids de modelo da OpenAI: sao TIERS de agente.
 * Cada tier junta limites de geracao (temperatura, tamanho) e aponta para um
 * modelo OpenAI real, configuravel em .env (MODEL_MINI, MODEL_SOL, MODEL_LUNA,
 * MODEL_TERRA). Trocar de modelo e mudar uma variavel de ambiente.
 *
 * O QUE O AGENTE DIZ NAO ESTA MAIS AQUI. Papel, tom e regras vem da curadoria
 * (curadoria/config.schema) e sao montados em agent/prompt.builder. Este arquivo
 * ja teve uma `persona` por tier; ela ficou obsoleta quando a equipe passou a
 * editar o texto pelo painel, e foi removida — um bloco de tom que parece
 * autoritario e nao e lido por ninguem custa uma tarde a quem for calibrar o
 * atendimento pela primeira vez.
 */

/**
 * LIMITES DA ADVOCACIA
 * --------------------
 * O agente e um canal de ATENDIMENTO INICIAL, nao um advogado. Ele acolhe, informa
 * de forma geral e encaminha. Quem analisa caso, estima valor e define estrategia
 * e o advogado responsavel. Estas regras existem tanto por risco ao cliente quanto
 * pelas normas de publicidade e captacao da advocacia (Provimento 205/2021 CFOAB).
 */
const LIMITES_ADVOCACIA = [
  'Voce NAO e advogado e NAO da consulta juridica. Voce faz o atendimento inicial: acolhe, entende o caso e encaminha.',
  'NUNCA afirme que a pessoa "tem direito" a algo no caso dela. Fale sempre no geral: "em regra a lei preve", "normalmente", "costuma ser".',
  'NUNCA estime valor de causa, de indenizacao ou de acerto. Nem faixa, nem "mais ou menos", nem calculo por cima.',
  'NUNCA informe honorarios, percentual, taxa ou custo. Honorarios sao tratados pelo advogado na consulta.',
  'NUNCA prometa resultado, ganho de causa, reintegracao ou prazo de duracao de processo.',
  'NUNCA oriente a pessoa a agir: pedir demissao, faltar, abandonar o emprego, assinar ou deixar de assinar documento, gravar alguem, confrontar a empresa. Se ela perguntar o que fazer, leve para a consulta.',
  'Diga que so o advogado, olhando os documentos, consegue avaliar o caso concreto.',
  'NUNCA compare o escritorio com outros, nao use superlativo ("melhor", "o mais barato") e nao ofereca servico a quem nao procurou.',
  'Se o contato for a empresa, o empregador ou a parte contraria de um caso, nao siga o atendimento: encaminhe ao time.',
  'Trate relato de assedio, doenca, acidente e gravidez com discricao. Nao peca detalhe intimo que nao seja necessario para a triagem.',
];

const TIERS = {
  /** Utilitario barato: classificacao, extracao de ontologia, resumo, triagem de guardrails. */
  mini: {
    key: 'mini',
    label: 'Mini',
    model: env.models.mini,
    temperature: 0,
    maxOutputTokens: 400,
    userFacing: false,
    description: 'Tier utilitario: extracao de ontologia, classificacao, resumo e guardrails.',
  },

  /** Agente de LEADS: primeiro contato de quem procura o escritorio. */
  sol: {
    key: 'sol',
    label: 'Sol',
    model: env.models.sol,
    temperature: 0.5,
    maxOutputTokens: 320,
    userFacing: true,
    role: 'leads',
    description: 'Atendimento inicial de quem procura o escritorio: acolhe o relato e faz a triagem.',
  },

  /** Agente de CLIENTES: quem ja tem caso ou processo com o escritorio. */
  luna: {
    key: 'luna',
    label: 'Luna',
    model: env.models.luna,
    temperature: 0.4,
    maxOutputTokens: 340,
    userFacing: true,
    role: 'clients',
    description: 'Acompanhamento de clientes com caso ou processo em andamento.',
  },

  /** Escalonamento: casos sensiveis e conversas que travaram. */
  terra: {
    key: 'terra',
    label: 'Terra',
    model: env.models.terra,
    temperature: 0.3,
    maxOutputTokens: 600,
    userFacing: true,
    description: 'Escalonamento: casos sensiveis, relatos delicados e conversas travadas.',
  },
};

/** Tier padrao de cada papel de canal. */
const DEFAULT_TIER_BY_ROLE = { leads: 'sol', clients: 'luna' };

const getTier = (key) => TIERS[key] || null;
const listTiers = () =>
  Object.values(TIERS).map(({ key, label, model, description, userFacing }) => ({
    key,
    label,
    model,
    description,
    userFacing,
  }));

module.exports = {
  TIERS,
  DEFAULT_TIER_BY_ROLE,
  getTier,
  listTiers,
  LIMITES_ADVOCACIA,
};
