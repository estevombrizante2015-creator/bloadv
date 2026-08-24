const { env } = require('./env');

/**
 * Os 3 numeros do sistema.
 * - role "leads"   -> atendidos pelo tier SOL (qualificacao/conversao)
 * - role "clients" -> atendidos pelo tier LUNA (suporte/retencao)
 * Ambos escalam para TERRA e usam MINI para tarefas utilitarias.
 */
const CHANNELS = [
  { id: 'leads-1', role: 'leads', label: env.labels['leads-1'], agentTier: 'sol' },
  { id: 'leads-2', role: 'leads', label: env.labels['leads-2'], agentTier: 'sol' },
  { id: 'clients-1', role: 'clients', label: env.labels['clients-1'], agentTier: 'luna' },
];

const CHANNEL_IDS = CHANNELS.map((c) => c.id);
const getChannel = (id) => CHANNELS.find((c) => c.id === id) || null;
const isValidChannel = (id) => CHANNEL_IDS.includes(id);

module.exports = { CHANNELS, CHANNEL_IDS, getChannel, isValidChannel };
