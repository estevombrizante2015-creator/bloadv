/**
 * REGISTRO DE AGENTES  (fonte unica da verdade)
 * ----------------------------------------------
 * Nenhum `if numero === X` deve existir fora daqui. Um numero novo entra
 * adicionando uma string na lista `numbers` do agente correspondente.
 *
 * O vinculo numero -> agente e resolvido no momento em que o QR e lido:
 * o Baileys informa o numero real da conta pareada, e o sistema descobre
 * sozinho qual agente atende aquele numero. Ver baileys.manager#bindAgent.
 */

const AGENT_STATUS = {
  ACTIVE: 'active', // conversa normalmente
  STANDBY: 'standby', // existe, roteia, mas nao responde
  DISABLED: 'disabled', // desligado
};

const AGENTS = {
  lead_capture: {
    id: 'lead_capture',
    label: 'Captacao de Leads',
    description: 'Atendimento inicial de quem procura o escritorio: acolhe o relato e faz a triagem.',
    status: AGENT_STATUS.ACTIVE,
    role: 'leads', // papel da ontologia (slots/estagios)
    tier: 'sol', // tier padrao de geracao
    numbers: ['+55 19 99638-3884', '+55 11 94006-1595'],
  },

  customer_agent: {
    id: 'customer_agent',
    label: 'Clientes',
    description: 'Acompanhamento de quem ja e cliente: andamento do caso, documentos e duvidas.',
    status: AGENT_STATUS.ACTIVE,
    role: 'clients',
    tier: 'luna',
    numbers: ['+55 19 98758-7782'],
  },

  /**
   * Destino de numero que nao esta em nenhuma lista.
   *
   * Precisa ser um agente PROPRIO e desligado. Enquanto o fallback apontava
   * para um agente real, bastava esse agente virar `active` para que qualquer
   * numero pareado por engano comecasse a responder cliente sozinho.
   */
  unassigned: {
    id: 'unassigned',
    label: 'Nao atribuido',
    description: 'Numero conectado que nao esta cadastrado em nenhum agente. Nao responde.',
    status: AGENT_STATUS.DISABLED,
    role: 'clients',
    tier: 'luna',
    numbers: [],
  },
};

/** Agente usado quando o numero conectado nao esta em nenhuma lista. */
const FALLBACK_AGENT_ID = 'unassigned';

// ---------------------------------------------------------------- numeros

/**
 * Normaliza para digitos. O JID do WhatsApp vem como "5519996383884@s.whatsapp.net".
 */
function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Variantes de um numero brasileiro celular.
 * Contas antigas aparecem sem o nono digito, entao "5519996383884" e
 * "551996383884" precisam casar entre si.
 */
function numberVariants(value) {
  const digits = digitsOnly(value);
  if (!digits) return [];

  const variants = new Set([digits]);

  // Sem DDI: assume Brasil.
  if (digits.length === 10 || digits.length === 11) variants.add(`55${digits}`);

  const withDdi = digits.startsWith('55') ? digits : `55${digits}`;
  const ddd = withDdi.slice(2, 4);
  const rest = withDdi.slice(4);

  if (rest.length === 9 && rest.startsWith('9')) {
    variants.add(`55${ddd}${rest.slice(1)}`); // remove o nono digito
  }
  if (rest.length === 8) {
    variants.add(`55${ddd}9${rest}`); // adiciona o nono digito
  }

  variants.add(withDdi);
  return [...variants];
}

/**
 * O WhatsApp passou a usar LID (`1234@lid`) no lugar do telefone em muitos
 * chats, por privacidade. O numero por tras dele NAO e exposto pelo protocolo,
 * entao tratar um LID como telefone produz coisas como "+40351318433948".
 */
const isLidJid = (jid) => String(jid || '').endsWith('@lid');

/**
 * Extrai o numero de um JID ("5519996383884@s.whatsapp.net" -> "5519996383884").
 * Devolve null para LID: e um identificador interno, nao um telefone.
 */
function jidToNumber(jid) {
  if (isLidJid(jid)) return null;
  return digitsOnly(String(jid || '').split('@')[0].split(':')[0]) || null;
}

/** Identificador cru, para quando so existe o LID. */
const jidToIdentifier = (jid) => String(jid || '').split('@')[0].split(':')[0] || null;

/** Formato legivel para o painel: +55 (19) 99638-3884 */
function formatNumber(value) {
  const digits = digitsOnly(value);
  const m = digits.match(/^(\d{2})(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `+${m[1]} (${m[2]}) ${m[3]}-${m[4]}` : digits ? `+${digits}` : null;
}

// --------------------------------------------------------------- consultas

/** Agentes de verdade: o `unassigned` e mecanismo interno, nao configuracao. */
const listAgents = () =>
  Object.values(AGENTS)
    .filter((a) => a.id !== FALLBACK_AGENT_ID)
    .map((a) => ({
      id: a.id,
      label: a.label,
      description: a.description,
      status: a.status,
      role: a.role,
      tier: a.tier,
      numbers: a.numbers.map(formatNumber),
    }));

const getAgent = (id) => AGENTS[id] || null;

/**
 * Descobre qual agente atende um numero. Compara todas as variantes dos dois
 * lados, entao tanto faz o formato cadastrado.
 * @returns {{agent: object, matched: boolean}}
 */
function resolveAgentByNumber(value) {
  const candidates = new Set(numberVariants(value));
  if (candidates.size) {
    for (const agent of Object.values(AGENTS)) {
      for (const registered of agent.numbers) {
        if (numberVariants(registered).some((v) => candidates.has(v))) {
          return { agent, matched: true };
        }
      }
    }
  }
  return { agent: AGENTS[FALLBACK_AGENT_ID], matched: false };
}

/** Agente esta autorizado a responder? */
const isAgentActive = (agent) => agent?.status === AGENT_STATUS.ACTIVE;

/** Todos os numeros cadastrados, para diagnostico no painel. */
const registeredNumbers = () =>
  Object.values(AGENTS).flatMap((a) =>
    a.numbers.map((n) => ({ agentId: a.id, number: formatNumber(n), status: a.status }))
  );

module.exports = {
  AGENTS,
  AGENT_STATUS,
  FALLBACK_AGENT_ID,
  listAgents,
  getAgent,
  resolveAgentByNumber,
  isAgentActive,
  registeredNumbers,
  numberVariants,
  digitsOnly,
  jidToNumber,
  jidToIdentifier,
  isLidJid,
  formatNumber,
};
