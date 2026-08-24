/**
 * Catalogo de regras de guardrail. Tudo declarativo para ficar auditavel e testavel.
 * Cada regra: { id, re } ou { id, fn } - `fn` para o que regex sozinha nao resolve.
 *
 * Contexto: escritorio de advocacia trabalhista. A fronteira que importa aqui nao e
 * "falar de direito" (e o negocio do escritorio), e sim CONCLUIR sobre o caso da pessoa,
 * prometer resultado, estimar valor, cotar honorario ou mandar a pessoa agir.
 * Isso e do advogado, na consulta - e algumas dessas condutas esbarram nas normas
 * de publicidade e captacao da advocacia (Provimento 205/2021 CFOAB).
 */

const OPT_OUT_KEYWORDS = [
  'parar', 'pare', 'sair', 'descadastrar', 'nao quero mais', 'nao me mande',
  'remover meu numero', 'stop', 'unsubscribe', 'me tire da lista',
];

const HUMAN_HANDOFF_KEYWORDS = [
  'falar com humano', 'falar com atendente', 'quero uma pessoa', 'atendente humano',
  'me transfere', 'supervisor', 'falar com o advogado', 'falar com advogado',
  'falar com o doutor', 'quero falar com a dra', 'quero falar com o dr',
  'reclamacao formal', 'procon', 'oab', 'reclamar do escritorio',
];

/**
 * Sinais de que quem escreve e a EMPRESA, o empregador ou a parte contraria.
 * Conflito de interesses: o atendimento nao pode seguir pelo agente.
 */
const PARTE_CONTRARIA_PATTERNS = [
  /\bsou (o |a )?(dono|dona|propriet[aá]ri[oa]|s[oó]ci[oa]|empregador[a]?)\b/i,
  /\bsou (do |da )?(rh|departamento pessoal|dp|juridico da empresa)\b/i,
  /\b(represento|sou (o |a )?advogad[oa] d[ao])\s+(a\s+|o\s+)?(empresa|reclamada|parte contr[aá]ria)\b/i,
  /\bminha empresa (foi|esta sendo) (processad|acionad)/i,
  /\brecebi (uma )?(intima[cç][aã]o|cita[cç][aã]o).{0,30}\b(minha empresa|como empregador)\b/i,
];

/** Tentativas classicas de prompt injection / extracao de system prompt. */
const INJECTION_PATTERNS = [
  /ignore (todas as )?(as )?(instru[cç][oõ]es|regras)( anteriores)?/i,
  /esque[cç]a (tudo|as instru[cç][oõ]es|o que foi dito)/i,
  /voc[eê] agora (e|é|sera|será) (um|uma)\b/i,
  /\b(system prompt|prompt de sistema|suas instru[cç][oõ]es)\b/i,
  /\bdeveloper mode\b|\bmodo desenvolvedor\b/i,
  /\bDAN\b.{0,20}\bmode\b/i,
  /repita (tudo|todo) (o )?(seu )?(texto|prompt|contexto)/i,
  /qual (modelo|llm|ia) voc[eê] (usa|e|é)/i,
  /<\|.*?\|>/,
];

/**
 * Dados sensiveis. Num escritorio isto e LGPD e sigilo profissional, nao so higiene:
 * mascaramos antes de a mensagem chegar ao modelo.
 */
const PII_PATTERNS = [
  { id: 'cpf', re: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, mask: '[cpf]' },
  { id: 'cnpj', re: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, mask: '[cnpj]' },
  { id: 'pis', re: /\b\d{3}\.?\d{5}\.?\d{2}-?\d\b/g, mask: '[pis]' },
  { id: 'cartao', re: /\b(?:\d[ -]*?){13,16}\b/g, mask: '[cartao]' },
  { id: 'email', re: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g, mask: '[email]' },
  { id: 'chave_api', re: /\b(sk|pk)-[A-Za-z0-9_-]{16,}\b/g, mask: '[chave]' },
];

/**
 * Marcadores de que a frase e informacao geral, nao conclusao sobre o caso.
 * A persona manda usar; o guardrail confere.
 */
const HEDGES =
  /\b(em regra|em tese|normalmente|geralmente|costuma\w*|depende|a depender|pode(m)? (ter|haver|gerar)|poder[aá]|talvez|na maioria|conforme o caso|cada caso|em alguns casos|a lei prev[eê]|[eé] poss[ií]vel|pode ser poss[ií]vel)\b/i;

/**
 * O agente nunca pode afirmar isto. Cada match dispara UMA reescrita corretiva;
 * persistindo, cai no fallback e vai para atendimento humano.
 */
const FORBIDDEN_CLAIMS = [
  // --- promessa de resultado ---
  {
    id: 'promessa_resultado',
    re: /\b(garanto|garantimos|garantid[oa]|com certeza|sem d[uú]vida|certamente|pode ficar (tranquil|sossegad)[oa]?)[^.!?]{0,60}\b(ganh|receb|indeniza|reintegr|vit[oó]ria|sucesso|direito|processo)/i,
  },
  {
    id: 'promessa_resultado',
    re: /\b(voc[eê]|vc|n[oó]s|a gente)\s+(vai|vamos|ir[aá])\s+(ganhar|vencer|receber)\b/i,
  },
  { id: 'promessa_resultado', re: /\b(causa|processo|caso)\s+(ganh[oa]|garantid[oa]|certeir[oa])\b/i },

  // --- estimativa de valor (percentual legal continua permitido) ---
  { id: 'estimativa_valor', re: /R\$\s?\d/i },
  {
    id: 'estimativa_valor',
    re: /\b\d{1,3}(\.\d{3})*\s*(mil\s*)?reais\b|\b\d+\s*mil\b(?![^.!?]{0,20}\b(processos|clientes|trabalhadores)\b)/i,
  },
  {
    id: 'estimativa_valor',
    re: /\b(gira em torno|fica em torno|em m[eé]dia|mais ou menos|por cima|estimo|calculo que)\b[^.!?]{0,40}\b(receb|indeniza|valor|acerto|causa)/i,
  },

  // --- honorarios: so bloqueia quando ha VALOR junto; falar do tema e permitido ---
  {
    id: 'honorarios_cotados',
    re: /\b(honor[aá]ri\w+|cobramos|cobran[cç]a|nossa taxa|percentual|comiss[aã]o)\b[^.!?]{0,45}(R\$|\d{1,3}\s?%|\d+\s*(mil|reais))/i,
  },
  {
    id: 'honorarios_cotados',
    re: /(R\$|\d{1,3}\s?%|\d+\s*(mil|reais))[^.!?]{0,45}\b(honor[aá]ri\w+|de entrada|para entrar com|pela causa)\b/i,
  },
  { id: 'honorarios_cotados', re: /\b(sem custo|de gra[cç]a|gratuito|n[aã]o cobramos nada)\b/i },

  // --- parecer conclusivo sobre o caso da pessoa (sem hedge) ---
  {
    id: 'parecer_conclusivo',
    fn: (t) =>
      /\b(voc[eê]|vc)\s+(tem|ter[aá]|teria|possui)\s+direito\b/i.test(t) && !HEDGES.test(t),
  },
  {
    id: 'parecer_conclusivo',
    fn: (t) =>
      /\b(seu caso|sua situa[cç][aã]o|isso a[ií])\s+(e|é|foi)\s+(claramente|sem d[uú]vida|com certeza|ass[eé]dio|ilegal|irregular|rescis[aã]o indireta)\b/i.test(
        t
      ) && !HEDGES.test(t),
  },
  { id: 'parecer_conclusivo', re: /\b(pode processar|d[aá] pra processar|cabe a[cç][aã]o no seu caso)\b/i },

  // --- orientacao de conduta que pode prejudicar a pessoa ---
  {
    id: 'orientacao_de_risco',
    re: /\b(pe[cç]a demiss[aã]o|pede demiss[aã]o|n[aã]o assine|nao assine|recuse assinar|abandone o emprego|pare de ir(?! ao))\b/i,
  },
  { id: 'orientacao_de_risco', re: /\b(falte ao trabalho|d[aá] uma falta|grave (a conversa|seu chefe|as liga))/i },
  { id: 'orientacao_de_risco', re: /\b(entre com (a )?a[cç][aã]o|processe (a empresa|eles|seu chefe))\b/i },

  // --- prazo de processo ---
  {
    id: 'promessa_prazo',
    re: /\b(em|dentro de|leva)\s+\d+\s*(dias|semanas|meses|anos)\b[^.!?]{0,45}\b(receb|ganh|sai a senten|resolv|indeniza|acaba)/i,
  },

  // --- publicidade / captacao (Prov. 205/2021 CFOAB) ---
  {
    id: 'publicidade_indevida',
    re: /\b(melhor(es)? (escrit[oó]rio|advogad|banca)|n[uú]mero 1|l[ií]der em|mais barato|mais r[aá]pido que|melhor que (a|o) )/i,
  },

  // --- fora de escopo profissional ---
  { id: 'conselho_medico', re: /\b(dosagem|tome (o |esse )?rem[eé]dio|receito|diagnostico que voc[eê]|voc[eê] est[aá] com (depress[aã]o|s[ií]ndrome))\b/i },

  // --- higiene geral ---
  {
    id: 'auto_referencia_ia',
    re: /\b(sou (uma )?(intelig[eê]ncia artificial|ia|bot|rob[oô]|modelo de linguagem)|gpt-?\d|openai|chatgpt)\b/i,
  },
  {
    id: 'pedido_credencial',
    re: /\b(me (envie|passe|informe|manda)|qual (e|é))\b[^.!?]{0,25}\b(senha|c[oó]digo de (verifica[cç][aã]o|seguran[cç]a)|token|pin|cvv|chave pix)\b/i,
  },
];

const isOptOut = (text) => {
  const t = (text || '').toLowerCase().trim();
  return OPT_OUT_KEYWORDS.some((k) => t === k || t.includes(k));
};

const wantsHuman = (text) => {
  const t = (text || '').toLowerCase();
  return HUMAN_HANDOFF_KEYWORDS.some((k) => t.includes(k));
};

const hasInjection = (text) => INJECTION_PATTERNS.some((re) => re.test(text || ''));

/** Conflito de interesses: quem escreve esta do outro lado. */
const isParteContraria = (text) => PARTE_CONTRARIA_PATTERNS.some((re) => re.test(text || ''));

/** Substitui PII por marcadores antes de a mensagem chegar ao modelo. */
function redactPII(text) {
  let output = text || '';
  const found = [];
  for (const { id, re, mask } of PII_PATTERNS) {
    if (re.test(output)) {
      found.push(id);
      output = output.replace(new RegExp(re.source, re.flags), mask);
    }
  }
  return { text: output, found };
}

function checkForbiddenClaims(text) {
  const content = text || '';
  const hits = FORBIDDEN_CLAIMS.filter((rule) =>
    rule.fn ? rule.fn(content) : rule.re.test(content)
  ).map((rule) => rule.id);
  return [...new Set(hits)];
}

/** Links so podem apontar para dominios autorizados. */
function checkLinks(text, allowedDomains = []) {
  const urls = (text || '').match(/https?:\/\/[^\s)]+/gi) || [];
  const offending = [];
  for (const url of urls) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      const ok = allowedDomains.some((d) => host === d || host.endsWith(`.${d}`));
      if (!ok) offending.push(host);
    } catch {
      offending.push(url.slice(0, 40));
    }
  }
  return offending;
}

module.exports = {
  OPT_OUT_KEYWORDS,
  HUMAN_HANDOFF_KEYWORDS,
  INJECTION_PATTERNS,
  PARTE_CONTRARIA_PATTERNS,
  PII_PATTERNS,
  FORBIDDEN_CLAIMS,
  HEDGES,
  isOptOut,
  wantsHuman,
  hasInjection,
  isParteContraria,
  redactPII,
  checkForbiddenClaims,
  checkLinks,
};
