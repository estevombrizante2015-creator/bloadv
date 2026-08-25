const { env } = require('../config/env');

/**
 * HORARIO DE ATENDIMENTO
 * ----------------------
 * O agente responde de segunda a sexta, das 08:00 as 18:30, horario de Brasilia.
 *
 * O fuso e resolvido pelo proprio Intl com `America/Sao_Paulo`, e nao por
 * offset fixo: o horario de verao ja acabou no Brasil, mas amarrar em -03:00
 * deixaria uma bomba caso volte, e tambem quebraria se o servidor rodar em
 * outro fuso (o que e o caso comum em nuvem).
 *
 * Fora do horario a mensagem NAO se perde: ela e recebida, registrada e
 * respondida por uma unica mensagem de ausencia - uma vez por periodo, nao a
 * cada mensagem, para nao virar spam.
 */

const FUSO = 'America/Sao_Paulo';

const DIAS = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
};

/** Converte "18:30" em minutos desde a meia-noite. */
function minutos(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/**
 * Data/hora no fuso de Brasilia, independentemente do fuso do servidor.
 * @returns {{ diaSemana: number, minutoDoDia: number, hora: string, data: string }}
 */
function agoraEmBrasilia(referencia = new Date()) {
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour12: false,
  }).formatToParts(referencia);

  const get = (tipo) => partes.find((p) => p.type === tipo)?.value ?? '';

  // `weekday` curto em pt-BR: "dom.", "seg.", "ter."...
  const mapa = { dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sáb: 6, sab: 6 };
  const abrev = get('weekday').toLowerCase().replace('.', '').slice(0, 3);

  const hora = Number(get('hour'));
  const minuto = Number(get('minute'));

  return {
    diaSemana: mapa[abrev] ?? new Date(referencia).getDay(),
    minutoDoDia: hora * 60 + minuto,
    hora: `${get('hour')}:${get('minute')}`,
    data: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/**
 * @returns {{ dentro: boolean, motivo: string, hora: string, data: string, abreEm?: string }}
 */
function estaNoExpediente(referencia = new Date()) {
  if (!env.expediente.enabled) {
    return { dentro: true, motivo: 'controle_desligado', hora: '', data: '' };
  }

  const { diaSemana, minutoDoDia, hora, data } = agoraEmBrasilia(referencia);

  const diasUteis = env.expediente.dias.map((d) => DIAS[d]).filter((d) => d !== undefined);
  if (!diasUteis.includes(diaSemana)) {
    return { dentro: false, motivo: 'fim_de_semana', hora, data, abreEm: proximaAbertura(diaSemana) };
  }

  const inicio = minutos(env.expediente.inicio);
  const fim = minutos(env.expediente.fim);

  if (minutoDoDia < inicio) {
    return { dentro: false, motivo: 'antes_da_abertura', hora, data, abreEm: env.expediente.inicio };
  }
  if (minutoDoDia >= fim) {
    return { dentro: false, motivo: 'apos_o_fechamento', hora, data, abreEm: proximaAbertura(diaSemana) };
  }

  return { dentro: true, motivo: 'no_expediente', hora, data };
}

/** Texto curto de quando volta, para a mensagem de ausencia. */
function proximaAbertura(diaSemana) {
  const proximo = (diaSemana + 1) % 7;
  const diasUteis = env.expediente.dias.map((d) => DIAS[d]);

  if (!diasUteis.includes(proximo)) return `segunda-feira as ${env.expediente.inicio}`;
  return `amanha as ${env.expediente.inicio}`;
}

/**
 * Mensagem enviada uma vez por periodo fora do expediente.
 *
 * `texto` vem da curadoria e tem precedencia. E enviada LITERALMENTE: fora do
 * expediente o agente nem chega a rodar, entao nao ha quem improvise. Dois
 * marcadores sao trocados pelo horario real, para o texto nao desatualizar
 * quando o escritorio mudar o expediente:
 *
 *   {horario}  -> "das 08:00 as 18:30"
 *   {retorno}  -> "amanha as 08:00"
 */
function mensagemAusencia(estado, texto) {
  const faixa = `${env.expediente.inicio} as ${env.expediente.fim}`;

  if (String(texto || '').trim()) {
    return String(texto)
      .replace(/\{horario\}/gi, `das ${faixa}`)
      .replace(/\{retorno\}/gi, estado.abreEm || 'em breve')
      .trim();
  }

  if (estado.motivo === 'fim_de_semana') {
    return (
      'Oi! Recebi sua mensagem. O atendimento funciona de segunda a sexta, ' +
      `das ${faixa}. Assim que abrirmos, alguem do escritorio te responde por aqui.`
    );
  }

  return (
    'Oi! Recebi sua mensagem, mas o atendimento ja encerrou por hoje. ' +
    `Funcionamos de segunda a sexta, das ${faixa}. Retornamos ${estado.abreEm || 'em breve'}.`
  );
}

/** Descricao legivel, para o painel. */
const descricao = () =>
  `${env.expediente.dias.join(', ')} · ${env.expediente.inicio}–${env.expediente.fim} (Brasilia)`;

module.exports = {
  estaNoExpediente,
  mensagemAusencia,
  agoraEmBrasilia,
  descricao,
  minutos,
  FUSO,
  DIAS,
};
