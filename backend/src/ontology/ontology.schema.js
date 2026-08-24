/**
 * ONTOLOGIA DE DOMINIO - Barbosa, Loli e Oliveira (Direito do Trabalho)
 * ---------------------------------------------------------------------
 * Por que existe: enviar historico bruto para o modelo custa tokens que crescem
 * linearmente com a conversa. Aqui o dominio e modelado como um conjunto FECHADO
 * de slots. Cada turno atualiza slots (delta), e o agente recebe um snapshot
 * compacto no lugar do historico - custo praticamente constante por turno.
 *
 * Regras:
 *  - Slot so existe se estiver declarado aqui (vocabulario fechado).
 *  - Valores enumerados sao preferidos a texto livre (menos tokens, menos ruido).
 *  - Texto livre tem limite rigido de caracteres (maxLen).
 *  - Slot vazio nao e renderizado no prompt.
 *
 * Papeis:
 *  - "leads"   = quem procura o escritorio pela primeira vez  -> triagem do caso
 *  - "clients" = quem ja e cliente, com caso ou processo ativo -> acompanhamento
 */

const STAGES = {
  leads: [
    'primeiro_contato',
    'coletando_relato',
    'triagem_completa',
    'consulta_agendada',
    'aguardando_documentos',
    'encaminhado_advogado',
    'fora_de_escopo',
    'desistiu',
  ],
  clients: [
    'ativo',
    'duvida',
    'aguardando_documentos',
    'aguardando_audiencia',
    'aguardando_pagamento',
    'insatisfeito',
    'encerrado',
  ],
};

const INTENTS = {
  leads: [
    'saudacao',
    'relato_caso',
    'duvida_direito',
    'quer_consulta',
    'pergunta_honorarios',
    'pergunta_valor_causa',
    'pergunta_prazo',
    'pergunta_local_atendimento',
    'envio_documento',
    'fora_de_escopo',
    'outro',
  ],
  clients: [
    'saudacao',
    'status_processo',
    'duvida_direito',
    'envio_documento',
    'pergunta_audiencia',
    'pergunta_pagamento',
    'reclamacao_atendimento',
    'quer_falar_advogado',
    'outro',
  ],
};

const SENTIMENTS = ['positivo', 'neutro', 'negativo', 'irritado', 'fragilizado'];

/**
 * Tipos de caso. Espelham a base de conhecimento (knowledge.base.js),
 * entao o topico certo e injetado sem custo extra de classificacao.
 */
const TIPOS_CASO = [
  'demissao_sem_justa_causa',
  'pedido_demissao',
  'justa_causa',
  'sem_registro',
  'vinculo_pj',
  'horas_extras',
  'verbas_incorretas',
  'salario_por_fora',
  'ferias',
  'estabilidade',
  'estabilidade_gestante',
  'assedio',
  'insalubridade',
  'rescisao_indireta',
  'prazo_pagamento',
  'fgts',
  'seguro_desemprego',
  'outro',
];

/** Slots por papel. type: enum | string | number | string[] | bool */
const SLOTS = {
  leads: {
    nome: { type: 'string', maxLen: 60 },
    tipo_caso: { type: 'enum', values: TIPOS_CASO },
    empregador: { type: 'string', maxLen: 60 },
    funcao: { type: 'string', maxLen: 40 },
    situacao_atual: {
      type: 'enum',
      values: ['ainda_trabalhando', 'afastado', 'aviso_previo', 'ja_desligado', 'nunca_registrado'],
    },
    tempo_de_casa: { type: 'string', maxLen: 30 },
    data_saida: { type: 'string', maxLen: 20 },
    tinha_registro: { type: 'enum', values: ['sim', 'nao', 'parcial', 'desconhecido'] },
    faixa_salarial: { type: 'string', maxLen: 30 },
    ja_recebeu_acerto: { type: 'enum', values: ['sim', 'parcial', 'nao', 'desconhecido'] },
    documentos: {
      type: 'string[]',
      maxItems: 6,
      maxLen: 30,
      // ctps, holerites, termo_rescisao, contrato, ponto, mensagens, testemunhas, extrato_fgts
    },
    ja_tem_advogado: { type: 'enum', values: ['sim', 'nao', 'desconhecido'] },
    ja_processou: { type: 'enum', values: ['sim', 'nao', 'desconhecido'] },
    cidade: { type: 'string', maxLen: 40 },
    uf: { type: 'string', maxLen: 2 },
    preferencia_atendimento: { type: 'enum', values: ['presencial', 'online', 'visita', 'indiferente'] },
    urgencia: { type: 'enum', values: ['desconhecido', 'imediata', '30d', '90d', 'sem_prazo'] },
    // Prescricao trabalhista: 2 anos apos a saida para ajuizar, 5 anos retroativos.
    risco_prescricao: { type: 'enum', values: ['desconhecido', 'dentro_do_prazo', 'proximo', 'possivel_prescrito'] },
    objecoes: { type: 'string[]', maxItems: 4, maxLen: 60 },
    proximo_passo: { type: 'string', maxLen: 80 },
    resumo_relato: { type: 'string', maxLen: 200 },
  },

  clients: {
    nome: { type: 'string', maxLen: 60 },
    tipo_caso: { type: 'enum', values: TIPOS_CASO },
    numero_processo: { type: 'string', maxLen: 30 },
    advogado_responsavel: { type: 'string', maxLen: 60 },
    fase: {
      type: 'enum',
      values: ['pre_processual', 'inicial_protocolada', 'audiencia_marcada', 'instrucao', 'sentenca', 'recurso', 'execucao', 'encerrado'],
    },
    proxima_audiencia: { type: 'string', maxLen: 30 },
    documentos_pendentes: { type: 'string[]', maxItems: 5, maxLen: 40 },
    assunto_contato: { type: 'string', maxLen: 100 },
    satisfacao: { type: 'enum', values: ['alta', 'media', 'baixa'] },
    proximo_passo: { type: 'string', maxLen: 80 },
  },
};

/**
 * Minimo para a triagem estar completa e o caso poder ir ao advogado.
 * Sem isto o agente fica perguntando; com isto, ele encaminha.
 */
const REQUIRED_SLOTS = {
  leads: ['nome', 'tipo_caso', 'situacao_atual', 'tempo_de_casa', 'cidade'],
  clients: ['nome', 'assunto_contato'],
};

/** JSON Schema enviado a OpenAI na extracao (tier mini). Compacto de proposito. */
function extractionSchema(role) {
  const slots = SLOTS[role];
  const properties = {};
  for (const [key, def] of Object.entries(slots)) {
    if (def.type === 'enum') properties[key] = { type: 'string', enum: def.values };
    else if (def.type === 'number') properties[key] = { type: 'number' };
    else if (def.type === 'string[]') properties[key] = { type: 'array', items: { type: 'string' } };
    else properties[key] = { type: 'string' };
  }
  return {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: INTENTS[role] },
      stage: { type: 'string', enum: STAGES[role] },
      sentiment: { type: 'string', enum: SENTIMENTS },
      slots: { type: 'object', properties, additionalProperties: false },
      facts: { type: 'array', items: { type: 'string' } },
      openQuestions: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  };
}

module.exports = {
  STAGES,
  INTENTS,
  SENTIMENTS,
  SLOTS,
  REQUIRED_SLOTS,
  TIPOS_CASO,
  extractionSchema,
};
