const { KNOWLEDGE, TOPICS } = require('./knowledge.base');
const { FIRM, renderUnidades } = require('./firm.config');

/**
 * Seleciona o minimo de conhecimento necessario para o turno.
 * Mandar a base inteira custaria ~1.500 tokens por mensagem; aqui vao no maximo
 * duas entradas (~120 tokens), escolhidas pelo tipo_caso ja extraido pela ontologia.
 */

const normalize = (text) =>
  (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Casa o gatilho como palavra inteira: evita "me demitiram" cair em "me demiti". */
function hasTrigger(haystack, trigger) {
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(normalize(trigger))}([^a-z0-9]|$)`);
  return pattern.test(haystack);
}

/**
 * Fallback por palavra-chave quando a ontologia ainda nao classificou o caso.
 * Gatilho mais longo pesa mais: "estou gravida" e mais informativo que "demissao".
 */
function matchByKeywords(text, limit = 2) {
  const haystack = normalize(text);
  if (!haystack) return [];

  return TOPICS.map((topic) => {
    const hits = KNOWLEDGE[topic].gatilhos.filter((g) => hasTrigger(haystack, g));
    const score = hits.reduce((acc, g) => acc + g.length, 0);
    return { topic, score };
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.topic);
}

/**
 * @returns {{ topics: string[], block: string }}
 */
function select({ tipoCaso, text, limit = 2 }) {
  const topics = [];

  if (tipoCaso && KNOWLEDGE[tipoCaso]) topics.push(tipoCaso);

  for (const topic of matchByKeywords(text, limit)) {
    if (!topics.includes(topic)) topics.push(topic);
  }

  const selected = topics.slice(0, limit);
  if (!selected.length) return { topics: [], block: '' };

  const block = selected
    .map((topic) => `- ${KNOWLEDGE[topic].titulo}: ${KNOWLEDGE[topic].resumo}`)
    .join('\n');

  return { topics: selected, block };
}

/** Pergunta de aprofundamento sugerida para o tema, evita pergunta generica. */
function suggestedQuestion(tipoCaso) {
  return KNOWLEDGE[tipoCaso]?.perguntaChave || null;
}

/** Injetado so quando o contato pergunta onde fica / como e o atendimento. */
function locationBlock() {
  return [
    `unidades: ${renderUnidades()}`,
    `atendimento: ${FIRM.atendimento.formatos.join(', ')} - ${FIRM.atendimento.horario}`,
    `contato: ${FIRM.contato.telefone} / ${FIRM.contato.email}`,
  ].join('\n');
}

const LOCATION_TRIGGERS = [
  'onde fica', 'onde voces ficam', 'endereco', 'presencial', 'atende em', 'atendem em',
  'qual cidade', 'sao paulo', 'cuiaba', 'iguatu', 'ceara', 'mato grosso',
  'santo antonio de posse', 'horario', 'que horas', 'online', 'telefone', 'email', 'e-mail',
];

const asksLocation = (text) => {
  const haystack = normalize(text);
  return LOCATION_TRIGGERS.some((trigger) => haystack.includes(normalize(trigger)));
};

module.exports = { select, suggestedQuestion, locationBlock, asksLocation, matchByKeywords };
