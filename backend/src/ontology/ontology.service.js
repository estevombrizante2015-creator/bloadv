const {
  SLOTS,
  REQUIRED_SLOTS,
  STAGES,
  INTENTS,
  SENTIMENTS,
  extractionSchema,
} = require('./ontology.schema');
const { env } = require('../config/env');
const logger = require('../utils/logger');

const clamp = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n).trim() : s);
const approxTokens = (text) => Math.ceil((text || '').length / 4);

/**
 * Sanitiza a saida do extrator contra a ontologia.
 * Guardrail estrutural: o modelo nao consegue inventar slots novos.
 */
function sanitize(role, raw) {
  const out = { slots: {}, facts: [], openQuestions: [] };
  if (!raw || typeof raw !== 'object') return out;

  if (INTENTS[role].includes(raw.intent)) out.intent = raw.intent;
  if (STAGES[role].includes(raw.stage)) out.stage = raw.stage;
  if (SENTIMENTS.includes(raw.sentiment)) out.sentiment = raw.sentiment;

  const defs = SLOTS[role];
  for (const [key, value] of Object.entries(raw.slots || {})) {
    const def = defs[key];
    if (!def || value === null || value === undefined || value === '') continue;

    if (def.type === 'enum') {
      if (def.values.includes(value)) out.slots[key] = value;
    } else if (def.type === 'number') {
      const n = Number(value);
      if (Number.isFinite(n)) {
        out.slots[key] = Math.min(def.max ?? n, Math.max(def.min ?? n, n));
      }
    } else if (def.type === 'string[]') {
      if (Array.isArray(value)) {
        out.slots[key] = value
          .filter((v) => typeof v === 'string' && v.trim())
          .slice(0, def.maxItems || 5)
          .map((v) => clamp(v.trim(), def.maxLen || 60));
      }
    } else if (typeof value === 'string') {
      out.slots[key] = clamp(value.trim(), def.maxLen || 80);
    }
  }

  out.facts = (Array.isArray(raw.facts) ? raw.facts : [])
    .filter((f) => typeof f === 'string' && f.trim())
    .slice(0, 6)
    .map((f) => clamp(f.trim(), 100));

  out.openQuestions = (Array.isArray(raw.openQuestions) ? raw.openQuestions : [])
    .filter((q) => typeof q === 'string' && q.trim())
    .slice(0, 3)
    .map((q) => clamp(q.trim(), 80));

  return out;
}

/** Funde o delta no snapshot atual. Escalares sobrescrevem; listas viram uniao limitada. */
function merge(current = {}, delta = {}, role = 'leads') {
  const next = {
    version: current.version || 1,
    intent: delta.intent || current.intent,
    stage: delta.stage || current.stage,
    sentiment: delta.sentiment || current.sentiment,
    language: current.language || 'pt-BR',
    slots: { ...(current.slots || {}) },
    facts: [...(current.facts || [])],
    openQuestions: delta.openQuestions?.length ? delta.openQuestions : current.openQuestions || [],
    updatedAt: new Date(),
  };

  for (const [key, value] of Object.entries(delta.slots || {})) {
    const def = SLOTS[role][key];
    if (def?.type === 'string[]') {
      const merged = [...new Set([...(next.slots[key] || []), ...value])];
      next.slots[key] = merged.slice(0, def.maxItems || 5);
    } else {
      next.slots[key] = value;
    }
  }

  for (const fact of delta.facts || []) {
    if (!next.facts.includes(fact)) next.facts.push(fact);
  }
  next.facts = next.facts.slice(-10); // memoria de fatos limitada

  return next;
}

/**
 * Renderiza o snapshot como linhas chave=valor.
 * Formato escolhido por densidade: bem mais barato que JSON identado
 * e ordens de grandeza mais barato que reenviar o historico equivalente.
 */
function render(ontology = {}, role = 'leads') {
  const lines = [];
  if (ontology.intent) lines.push(`intencao=${ontology.intent}`);
  if (ontology.stage) lines.push(`estagio=${ontology.stage}`);
  if (ontology.sentiment) lines.push(`humor=${ontology.sentiment}`);

  const slots = ontology.slots || {};
  for (const [key, value] of Object.entries(slots)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) lines.push(`${key}=${value.join('|')}`);
    } else {
      lines.push(`${key}=${value}`);
    }
  }

  if (ontology.facts?.length) lines.push(`fatos=${ontology.facts.join(' ; ')}`);

  const missing = missingSlots(ontology, role);
  if (missing.length) lines.push(`faltam=${missing.join(',')}`);

  return lines.join('\n');
}

/** Slots obrigatorios ainda vazios: o agente pergunta apenas estes, nunca repete. */
function missingSlots(ontology = {}, role = 'leads') {
  const slots = ontology.slots || {};
  return (REQUIRED_SLOTS[role] || []).filter((k) => {
    const v = slots[k];
    return v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  });
}

/** Conversa qualificada quando todos os slots obrigatorios estao preenchidos. */
const isComplete = (ontology, role) => missingSlots(ontology, role).length === 0;

const EXTRACTOR_PROMPT = [
  'Voce e um EXTRATOR de ontologia. Nao converse, nao responda ao usuario.',
  'Leia a ultima mensagem do contato no contexto dado e devolva SOMENTE JSON valido.',
  'Regras:',
  '- SEMPRE devolva "intent" e "stage": sao a classificacao da conversa agora, nao um dado do contato.',
  '- Escolha o intent MAIS ESPECIFICO que couber. Pergunta sobre quanto vai receber e pergunta_valor_causa;',
  '  sobre quanto o escritorio cobra e pergunta_honorarios; onde fica e pergunta_local_atendimento.',
  '  Use duvida_direito e outro apenas quando nenhum intent especifico servir.',
  '- Se a mensagem tem mais de um assunto, escolha o de maior risco para o escritorio',
  '  (honorarios e valor da causa vem antes de duvida generica).',
  '- Preencha os slots que a narrativa sustenta. "fui demitido" ja define tipo_caso e situacao_atual;',
  '  isso e classificar, nao inventar. Nao preencha nome, empresa, datas ou valores sem mencao explicita.',
  '- Se um slot ja esta correto no estado atual, omita-o (mande somente o delta).',
  '- Valores devem respeitar os enums do schema.',
  '- "facts": no maximo 3 fatos novos, cada um com ate 100 caracteres.',
  '- "openQuestions": o que ainda falta descobrir, ate 3 itens.',
  'Se nenhum slot mudou, ainda assim devolva intent e stage.',
].join('\n');

/**
 * Executa a extracao no tier mini (barato) e devolve o delta sanitizado.
 * Recebe openaiService por parametro para evitar dependencia circular.
 */
/**
 * Frases sociais que nao carregam informacao de caso.
 *
 * Escritas sem acento e comparadas contra o texto normalizado, porque quem
 * digita no celular escreve "ola" tanto quanto "olá" — e um `/olá/` cru
 * perderia metade das saudacoes.
 */
const SOCIAL = [
  'bom dia',
  'boa tarde',
  'boa noite',
  'ola',
  'oi',
  'oie',
  'opa',
  'e ai',
  'tudo bem',
  'tudo bom',
  'como vai',
  'obrigado',
  'obrigada',
  'obrigado(a)',
  'agradeco',
  'valeu',
  'blz',
  'beleza',
  'ok',
  'okay',
  'certo',
  'entendi',
  'perfeito',
  'por favor',
  'pfv',
  'boa',
  'com licenca',
  'ate mais',
  'tchau',
  'bom fim de semana',
];

/**
 * Vale gastar uma chamada de modelo para extrair estado desta mensagem?
 *
 * A extracao custa cerca de 900 tokens por turno — mais de um terco do custo de
 * uma resposta. Rodar isso sobre "Bom dia!!" paga o preco cheio para descobrir,
 * com certeza, que nao ha nada a extrair.
 *
 * O teste e por SUBTRACAO, nao por lista de gatilhos: retira-se do texto tudo o
 * que e cumprimento e pontuacao; se sobrar alguma palavra, ela pode ser o caso
 * da pessoa e a extracao roda. "Bom dia, fui demitido" deixa "fui demitido" e
 * portanto extrai; "Bom dia!!" nao deixa nada.
 *
 * O vies e deliberado: na duvida, EXTRAI. Perder um slot custa uma pergunta
 * repetida ao cliente; economizar tokens nao vale isso.
 */
function valeExtrair(texto) {
  const normalizado = String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalizado) return false;

  // Mensagem longa quase nunca e so cumprimento; nem vale normalizar mais.
  if (normalizado.length > 80) return true;

  let resto = ` ${normalizado} `;
  // Do mais longo para o mais curto: "tudo bem" antes de "bem" solto.
  for (const frase of [...SOCIAL].sort((a, b) => b.length - a.length)) {
    resto = resto.split(` ${frase} `).join(' ');
  }

  return resto.trim().length > 0;
}

async function extract({ openaiService, role, currentOntology, recentMessages, userText }) {
  const schema = extractionSchema(role);
  const currentCompact = render(currentOntology, role) || '(vazio)';

  const context = (recentMessages || [])
    .slice(-4)
    .map((m) => `${m.role === 'user' ? 'C' : 'A'}: ${clamp(m.text, 240)}`)
    .join('\n');

  try {
    const result = await openaiService.completeJSON({
      tier: 'mini',
      purpose: 'ontology_extract',
      system: `${EXTRACTOR_PROMPT}\n\nSCHEMA:\n${JSON.stringify(schema)}`,
      user: [
        `ESTADO ATUAL:\n${currentCompact}`,
        `CONTEXTO:\n${context}`,
        `ULTIMA MENSAGEM DO CONTATO:\n${clamp(userText, 800)}`,
      ].join('\n\n'),
      maxTokens: 400,
    });
    return { delta: sanitize(role, result.json), usage: result.usage };
  } catch (error) {
    logger.warn({ err: error.message }, 'Extracao de ontologia falhou; seguindo sem delta');
    return { delta: sanitize(role, {}), usage: null };
  }
}

/** Resumo rolante: substitui turnos antigos por texto curto. Roda a cada N mensagens. */
async function summarize({ openaiService, previousSummary, messages }) {
  const transcript = (messages || [])
    .map((m) => `${m.role === 'user' ? 'C' : 'A'}: ${clamp(m.text, 200)}`)
    .join('\n');

  const result = await openaiService.complete({
    tier: 'mini',
    purpose: 'rolling_summary',
    system:
      'Comprima a conversa em no maximo 60 palavras, em portugues, mantendo apenas o que muda decisoes futuras: ' +
      'compromissos assumidos, restricoes, preferencias e o que ja foi respondido. ' +
      'Sem saudacoes, sem cortesia, sem repetir dados ja estruturados.',
    user: `RESUMO ANTERIOR:\n${previousSummary || '(nenhum)'}\n\nNOVOS TURNOS:\n${transcript}`,
    maxTokens: 160,
    temperature: 0.2,
  });

  return { summary: clamp((result.text || '').trim(), 600), usage: result.usage };
}

/**
 * Monta o contexto final do agente.
 * Economia = tokens do historico completo menos tokens do contexto compactado.
 */
function buildContext({ ontology, role, rollingSummary, recentMessages, allMessagesCount }) {
  const snapshot = render(ontology, role);
  const turns = (recentMessages || []).slice(-env.ontology.recentTurns);

  const parts = [];
  if (snapshot) parts.push(`[ESTADO ESTRUTURADO]\n${snapshot}`);
  if (rollingSummary) parts.push(`[HISTORICO COMPRIMIDO]\n${rollingSummary}`);

  const contextBlock = parts.join('\n\n');

  // Estimativa conservadora: cada turno descartado custaria ~40 tokens.
  const droppedTurns = Math.max(0, (allMessagesCount || 0) - turns.length);
  const savedTokens = Math.max(0, droppedTurns * 40 - approxTokens(contextBlock));

  return { contextBlock, turns, savedTokens, missing: missingSlots(ontology, role) };
}

module.exports = {
  valeExtrair,
  sanitize,
  merge,
  render,
  missingSlots,
  isComplete,
  extract,
  summarize,
  buildContext,
  approxTokens,
};
