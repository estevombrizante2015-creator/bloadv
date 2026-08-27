/**
 * POR QUE O AGENTE PAROU, EM PORTUGUES
 * ------------------------------------
 * Os motivos sao chaves internas ("atendimento_humano") e apareciam cruas nas
 * duas telas que mostram conversa pausada. Quem le e um atendente, nao quem
 * escreveu o codigo — e um sublinhado no meio da frase e a marca de um sistema
 * falando consigo mesmo.
 *
 * A tabela vive aqui, e nao em cada pagina, porque a mesma pausa aparece na
 * conversa aberta e na lista de conexoes: duas traducoes diferentes para o
 * mesmo estado fazem parecer que sao coisas diferentes.
 */

export const MOTIVO_DA_PAUSA: Record<string, string> = {
  // Vale para o painel E para quem responde pelo celular: nao da para dizer
  // "voce assumiu" quando pode ter sido outra pessoa do escritorio.
  atendimento_humano: 'alguém do escritório assumiu',
  pausada_no_painel: 'pausada no painel',
  pedido_do_contato: 'a pessoa pediu para falar com um advogado',
  possivel_conflito_de_interesses: 'possível conflito de interesses',
  possible_bot_loop: 'o outro lado parece ser automático',
  loop_de_bot: 'o outro lado parece ser automático',
  resposta_repetida: 'o agente estava repetindo a mesma resposta',
  violacao_guardrail_saida: 'a resposta foi barrada pelas regras',
  erro_openai: 'houve uma falha técnica',
};

export const motivoLegivel = (motivo: string | null | undefined) =>
  motivo ? MOTIVO_DA_PAUSA[motivo] || motivo.replace(/_/g, ' ') : null;

/**
 * Pausa pedida por uma pessoa e rotina; pausa automatica e sintoma.
 * A cor separa as duas na lista, para o olho achar o que precisa de atencao
 * sem ler motivo por motivo.
 */
const AUTOMATICAS = new Set([
  'possible_bot_loop',
  'loop_de_bot',
  'resposta_repetida',
  'violacao_guardrail_saida',
  'erro_openai',
  'possivel_conflito_de_interesses',
]);

export const pausaAutomatica = (motivo: string | null | undefined, status?: string) =>
  Boolean((motivo && AUTOMATICAS.has(motivo)) || status === 'BOT_LOOP_DETECTED');

/** "há 12 min", "há 3 h", "há 2 dias" — sem biblioteca de datas. */
export function desde(iso: string | null | undefined) {
  if (!iso) return null;

  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;

  const minutos = Math.floor(ms / 60_000);
  if (minutos < 1) return 'agora';
  if (minutos < 60) return `há ${minutos} min`;

  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `há ${horas} h`;

  const dias = Math.floor(horas / 24);
  return dias === 1 ? 'há 1 dia' : `há ${dias} dias`;
}

/**
 * Iniciais para o circulo da lista. Sem nome, o circulo fica com o icone de
 * pessoa: duas letras tiradas de um telefone nao dizem nada.
 */
export function iniciais(nome: string | null | undefined) {
  const partes = (nome || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return null;
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}
