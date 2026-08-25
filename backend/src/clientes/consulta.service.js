const clienteService = require('./cliente.service');
const contexto = require('./contexto.service');
const pipeline = require('./pipeline.service');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');

/**
 * "COMO ESTA MEU PROCESSO?"
 * -------------------------
 * Quando o proprio cliente pergunta pelo WhatsApp, o agente responde com o que
 * esta REGISTRADO na ficha — nunca com uma reconstrucao a partir da conversa.
 *
 * Duas travas, e as duas sao estruturais, nao pedidos ao modelo:
 *
 *   1. O bloco so e montado quando ha material (`contexto.temMaterial`). Ficha
 *      vazia nao produz bloco nenhum, entao nao ha o que o modelo esticar.
 *
 *   2. O dossie entregue e o EXTERNO. Observacao interna, tarefa, responsavel
 *      e prioridade nao entram — o agente nao pode contar ao cliente algo que
 *      o escritorio anotou para si.
 *
 * Quando nao ha o que dizer, o bloco existe assim mesmo, mas com a instrucao
 * oposta: assuma que nao tem a informacao e encaminhe. E a diferenca entre o
 * agente calar e o agente inventar.
 */

/**
 * A mensagem pergunta sobre andamento?
 *
 * Deteccao por padrao de texto, sem chamada de modelo: isto roda em toda
 * mensagem recebida, e uma classificacao paga por turno so para descobrir que
 * a pessoa disse "bom dia" seria custo puro.
 */
/**
 * FIM DE PALAVRA, COM ACENTO.
 *
 * `\b` em JavaScript e ASCII: entre "á" e um espaco NAO existe borda, porque
 * nenhum dos dois e caractere de palavra para a engine. Na pratica isso faz
 * `/está\b/` nunca casar com "está meu processo" — e "como está meu processo?"
 * e literalmente a frase do enunciado.
 *
 * Este olhar-a-frente substitui o `\b` sempre que o padrao termina em palavra
 * acentuada.
 */
const FIM = '(?=[\\s?!.,;:]|$)';

const PADROES = [
  new RegExp(`\\bcomo (esta|está|ta|tá|anda|vai)${FIM}.*(meu|minha|o|a)\\s*(processo|caso|acao|ação|pedido|documento|analise|análise)`, 'i'),
  new RegExp(`\\b(meu|minha)\\s*(processo|caso|acao|ação)${FIM}.*\\b(como|status|andamento|situacao|situação)`, 'i'),
  new RegExp(`\\b(tem|teve|ha|há|surgiu)\\s*(alguma\\s*)?(novidade|noticia|notícia|atualizacao|atualização|resposta)${FIM}`, 'i'),
  new RegExp(`\\b(alguma|qualquer)\\s*novidade${FIM}`, 'i'),
  /\b(status|andamento|situacao|situação)\s*(do|da|de)\s*(meu|minha|processo|caso)/i,
  new RegExp(`\\bem que (pe|pé|ponto|etapa|fase)${FIM}`, 'i'),
  new RegExp(`\\bja\\s*(saiu|tem|teve)\\s*(alguma|algum)${FIM}`, 'i'),
  new RegExp(`\\bnoticias?\\s*(do|da|sobre)\\s*(meu|minha)${FIM}`, 'i'),
  new RegExp(`\\bvoces?\\s*(ja|já)\\s*(analisaram|olharam|viram)${FIM}`, 'i'),
];

const perguntaSobreAndamento = (texto) => {
  const limpo = String(texto || '').trim();
  if (limpo.length < 4 || limpo.length > 500) return false;
  return PADROES.some((p) => p.test(limpo));
};

/**
 * Bloco de situacao para o prompt do agente, ou null quando nao ha nada a
 * dizer e nem sequer vale gastar tokens com o assunto.
 *
 * @returns {{texto: string, temDados: boolean, clienteId: string}|null}
 */
async function situacaoParaAgente(telefone) {
  if (!telefone) return null;

  const cliente = await clienteService.porTelefone(telefone).catch(() => null);
  if (!cliente) return null;

  const dossie = await contexto.montar(cliente._id, { interno: false, mensagens: 0, eventos: 12 });
  if (!dossie) return null;

  const temDados = contexto.temMaterial(dossie.densidade);

  logger.info(
    {
      ev: EV.STATUS_CONSULTADO_PELO_AGENTE,
      clienteId: cliente._id.toString(),
      temDados,
    },
    'Agente consultou a situacao do cliente'
  );

  if (!temDados) {
    return {
      clienteId: cliente._id.toString(),
      temDados: false,
      texto: [
        'O contato perguntou sobre o andamento do caso dele.',
        '',
        'NAO HA INFORMACAO REGISTRADA suficiente sobre este caso no sistema.',
        '',
        'Diga com honestidade que voce nao tem essa informacao atualizada agora e que vai',
        'verificar com o responsavel para retornar. NAO descreva nenhuma etapa, fase ou',
        'andamento — inclusive os que aparecerem na conversa anterior. Nao invente.',
      ].join('\n'),
    };
  }

  const situacao = [
    `Situacao registrada: ${pipeline.rotuloStatus(cliente.status)}`,
    cliente.etapa ? `Etapa: ${pipeline.rotuloEtapa(cliente.etapa)}` : null,
    cliente.aguardando ? `O escritorio aguarda: ${cliente.aguardando}` : null,
    (cliente.pendencias || []).filter((p) => !p.resolvida).length
      ? `Pendente com o cliente: ${(cliente.pendencias || [])
          .filter((p) => !p.resolvida)
          .map((p) => p.texto)
          .join('; ')}`
      : null,
    cliente.ultimoContatoEm
      ? `Ultimo contato: ${new Date(cliente.ultimoContatoEm).toLocaleDateString('pt-BR')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    clienteId: cliente._id.toString(),
    temDados: true,
    texto: [
      'O contato perguntou sobre o andamento do caso dele. Isto e o que esta REGISTRADO',
      'no sistema neste momento:',
      '',
      situacao,
      '',
      'Responda com base APENAS nestas linhas, em uma ou duas frases, com naturalidade.',
      'Se houver algo pendente do lado dele, peca com cordialidade.',
      'NAO acrescente fase, prazo, valor, resultado ou qualquer detalhe que nao esteja acima.',
      'Se ele pedir algo que nao esta aqui, diga que vai confirmar com o responsavel.',
    ].join('\n'),
  };
}

module.exports = { perguntaSobreAndamento, situacaoParaAgente, PADROES };
