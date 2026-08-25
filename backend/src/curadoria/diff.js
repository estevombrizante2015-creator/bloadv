const { MENSAGENS, CAMPOS_EMPRESA, TONS } = require('./config.schema');

/**
 * COMPARACAO DE VERSOES
 * ---------------------
 * O diff existe para uma pessoa que nao programa olhar antes de publicar e
 * entender o impacto do que fez. Por isso ele NAO e um diff de JSON:
 *
 *  - cada mudanca vem com rotulo em portugues ("Tom de voz", nao "tomDeVoz.preset")
 *  - regras sao casadas por id, entao "editei a regra 3" aparece como uma
 *    alteracao, e nao como "removida uma regra e adicionada outra"
 *  - valores booleanos e numericos viram texto legivel ("ligado", "8 segundos")
 *
 * A saida serve a dois consumidores: a tela de comparacao e o registro
 * gravado no historico da versao.
 */

const rotuloTom = (preset) => TONS[preset]?.label || preset;

/** Uma linha do diff. `antes`/`depois` sao sempre string, para a tela nao precisar decidir nada. */
const alteracao = (campo, rotulo, tipo, antes, depois) => ({
  campo,
  rotulo,
  tipo,
  antes: antes === null || antes === undefined ? '' : String(antes),
  depois: depois === null || depois === undefined ? '' : String(depois),
});

const textoMudou = (a, b) => String(a ?? '').trim() !== String(b ?? '').trim();

const simNao = (v) => (v ? 'ligado' : 'desligado');

// ---------------------------------------------------------------- regras

/**
 * Regras casadas por id. O id sobrevive a edicao do texto, entao editar uma
 * regra produz "alterado" - que e o que a pessoa fez de fato. Sem isso, mexer
 * numa virgula apareceria como remocao + adicao, e um diff de 40 linhas para
 * uma mudanca de uma palavra ninguem le.
 */
function diffRegras(antes = [], depois = []) {
  const mapaAntes = new Map(antes.map((r) => [r.id, r]));
  const mapaDepois = new Map(depois.map((r) => [r.id, r]));
  const saida = [];

  for (const nova of depois) {
    const velha = mapaAntes.get(nova.id);

    if (!velha) {
      saida.push(alteracao(`regras.${nova.id}`, 'Regra adicionada', 'adicionado', '', nova.texto));
      continue;
    }
    if (textoMudou(velha.texto, nova.texto)) {
      saida.push(alteracao(`regras.${nova.id}`, 'Regra editada', 'alterado', velha.texto, nova.texto));
    }
    if (Boolean(velha.ativa) !== Boolean(nova.ativa)) {
      saida.push(
        alteracao(
          `regras.${nova.id}.ativa`,
          nova.ativa ? 'Regra reativada' : 'Regra desativada',
          'alterado',
          `${simNao(velha.ativa)}: ${velha.texto}`,
          `${simNao(nova.ativa)}: ${nova.texto}`
        )
      );
    }
  }

  for (const velha of antes) {
    if (!mapaDepois.has(velha.id)) {
      saida.push(alteracao(`regras.${velha.id}`, 'Regra removida', 'removido', velha.texto, ''));
    }
  }

  return saida;
}

function diffFaq(antes = [], depois = []) {
  const saida = [];
  const max = Math.max(antes.length, depois.length);

  for (let i = 0; i < max; i += 1) {
    const a = antes[i];
    const d = depois[i];
    const renderiza = (item) => (item ? `${item.pergunta}\n${item.resposta}` : '');

    if (a && !d) saida.push(alteracao(`empresa.faq.${i}`, 'Pergunta frequente removida', 'removido', renderiza(a), ''));
    else if (!a && d) saida.push(alteracao(`empresa.faq.${i}`, 'Pergunta frequente adicionada', 'adicionado', '', renderiza(d)));
    else if (a && d && textoMudou(renderiza(a), renderiza(d))) {
      saida.push(alteracao(`empresa.faq.${i}`, 'Pergunta frequente editada', 'alterado', renderiza(a), renderiza(d)));
    }
  }

  return saida;
}

// ----------------------------------------------------------------- geral

/**
 * @param {object} antes  configuracao publicada (ou padrao, na primeira vez)
 * @param {object} depois rascunho
 * @returns {Array<{campo, rotulo, tipo, antes, depois}>}
 */
function comparar(antes, depois) {
  if (!antes || !depois) return [];
  const saida = [];

  if (textoMudou(antes.promptPrincipal, depois.promptPrincipal)) {
    saida.push(
      alteracao('promptPrincipal', 'Instrucoes principais', 'alterado', antes.promptPrincipal, depois.promptPrincipal)
    );
  }

  if (antes.tomDeVoz?.preset !== depois.tomDeVoz?.preset) {
    saida.push(
      alteracao(
        'tomDeVoz.preset',
        'Tom de voz',
        'alterado',
        rotuloTom(antes.tomDeVoz?.preset),
        rotuloTom(depois.tomDeVoz?.preset)
      )
    );
  }
  if (textoMudou(antes.tomDeVoz?.descricao, depois.tomDeVoz?.descricao)) {
    saida.push(
      alteracao(
        'tomDeVoz.descricao',
        'Descricao do tom',
        'alterado',
        antes.tomDeVoz?.descricao,
        depois.tomDeVoz?.descricao
      )
    );
  }

  saida.push(...diffRegras(antes.regras, depois.regras));

  for (const [chave, meta] of Object.entries(MENSAGENS)) {
    if (textoMudou(antes.mensagens?.[chave], depois.mensagens?.[chave])) {
      saida.push(
        alteracao(
          `mensagens.${chave}`,
          `Mensagem: ${meta.label}`,
          'alterado',
          antes.mensagens?.[chave],
          depois.mensagens?.[chave]
        )
      );
    }
  }

  if (Boolean(antes.audio?.habilitado) !== Boolean(depois.audio?.habilitado)) {
    saida.push(
      alteracao(
        'audio.habilitado',
        'Interpretacao de audio',
        'alterado',
        simNao(antes.audio?.habilitado),
        simNao(depois.audio?.habilitado)
      )
    );
  }
  if (textoMudou(antes.audio?.instrucoes, depois.audio?.instrucoes)) {
    saida.push(
      alteracao('audio.instrucoes', 'Instrucoes de audio', 'alterado', antes.audio?.instrucoes, depois.audio?.instrucoes)
    );
  }
  if (Boolean(antes.audio?.responderSempreEmTexto) !== Boolean(depois.audio?.responderSempreEmTexto)) {
    saida.push(
      alteracao(
        'audio.responderSempreEmTexto',
        'Responder sempre em texto',
        'alterado',
        simNao(antes.audio?.responderSempreEmTexto),
        simNao(depois.audio?.responderSempreEmTexto)
      )
    );
  }

  if (Boolean(antes.imagem?.habilitado) !== Boolean(depois.imagem?.habilitado)) {
    saida.push(
      alteracao(
        'imagem.habilitado',
        'Interpretacao de imagens',
        'alterado',
        simNao(antes.imagem?.habilitado),
        simNao(depois.imagem?.habilitado)
      )
    );
  }
  if (textoMudou(antes.imagem?.instrucoes, depois.imagem?.instrucoes)) {
    saida.push(
      alteracao(
        'imagem.instrucoes',
        'Instrucoes de imagem',
        'alterado',
        antes.imagem?.instrucoes,
        depois.imagem?.instrucoes
      )
    );
  }

  if (Boolean(antes.web?.habilitado) !== Boolean(depois.web?.habilitado)) {
    saida.push(
      alteracao(
        'web.habilitado',
        'Consulta a internet',
        'alterado',
        simNao(antes.web?.habilitado),
        simNao(depois.web?.habilitado)
      )
    );
  }
  if (textoMudou(antes.web?.instrucoes, depois.web?.instrucoes)) {
    saida.push(
      alteracao(
        'web.instrucoes',
        'Instrucoes da pesquisa na internet',
        'alterado',
        antes.web?.instrucoes,
        depois.web?.instrucoes
      )
    );
  }

  if (antes.tempoDeEspera?.segundos !== depois.tempoDeEspera?.segundos) {
    saida.push(
      alteracao(
        'tempoDeEspera.segundos',
        'Tempo de espera',
        'alterado',
        `${antes.tempoDeEspera?.segundos} segundos`,
        `${depois.tempoDeEspera?.segundos} segundos`
      )
    );
  }

  for (const campo of CAMPOS_EMPRESA) {
    if (textoMudou(antes.empresa?.[campo.id], depois.empresa?.[campo.id])) {
      saida.push(
        alteracao(
          `empresa.${campo.id}`,
          campo.label,
          'alterado',
          antes.empresa?.[campo.id],
          depois.empresa?.[campo.id]
        )
      );
    }
  }

  saida.push(...diffFaq(antes.empresa?.faq, depois.empresa?.faq));

  return saida;
}

/**
 * Resumo de uma linha para o historico ("Tom de voz, 2 regras").
 * Quem abre a lista de versoes precisa entender o que aconteceu sem abrir cada uma.
 */
function resumir(alteracoes) {
  if (!alteracoes.length) return 'Sem alteracoes';

  const regras = alteracoes.filter((a) => a.campo.startsWith('regras.')).length;
  const mensagens = alteracoes.filter((a) => a.campo.startsWith('mensagens.')).length;
  const outros = alteracoes
    .filter((a) => !a.campo.startsWith('regras.') && !a.campo.startsWith('mensagens.'))
    .map((a) => a.rotulo);

  const partes = [...new Set(outros)];
  if (regras) partes.push(`${regras} ${regras === 1 ? 'regra' : 'regras'}`);
  if (mensagens) partes.push(`${mensagens} ${mensagens === 1 ? 'mensagem' : 'mensagens'}`);

  const texto = partes.slice(0, 3).join(', ');
  const restante = partes.length - 3;
  return restante > 0 ? `${texto} e mais ${restante}` : texto;
}

module.exports = { comparar, resumir, diffRegras };
