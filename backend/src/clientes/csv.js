/**
 * LEITURA DE CSV DE PLANILHA DE ESCRITORIO
 * ----------------------------------------
 * Nao e um parser generico: e um leitor calibrado para o que sai do Excel de
 * um escritorio brasileiro, que erra de maneiras especificas e repetidas.
 *
 * Cada funcao aqui existe por causa de um problema encontrado no arquivo real
 * que originou este modulo:
 *
 *   - a primeira linha nao era o cabecalho, era um titulo solto;
 *   - os acentos vieram corrompidos ("FUNÃÃO" no lugar de "FUNÇÃO");
 *   - campos entre aspas continham virgulas ("CONTRATO, PROCURACAO, ...");
 *   - havia 18 colunas vazias no fim, chamadas "Coluna 2" a "Coluna 20";
 *   - varias linhas tinham so o nome do cliente preenchido.
 *
 * Sem dependencia nova: o formato e simples o bastante para ser lido direito,
 * e uma biblioteca traria as mesmas ~80 linhas mais um risco de supply chain
 * num projeto que guarda credencial de WhatsApp.
 */

// ------------------------------------------------------------- codificacao

/**
 * Conserta o texto que foi salvo em UTF-8 e lido como Latin-1.
 *
 * E o erro mais comum do Excel em portugues, e o do arquivo que motivou isto:
 * "Ç" (bytes C3 87) vira "Ã" seguido de um caractere de controle invisivel, e
 * "FUNÇÃO" aparece como "FUNÃÃO". Reinterpretar os bytes desfaz exatamente
 * isso.
 */
function repararAcentos(texto) {
  // A assinatura do estrago: "\u00C3"/"\u00C2" (C3/C2) seguidos de um byte de
  // continuacao UTF-8 (80-BF). Escrito com escapes de proposito: caractere
  // acentuado literal em codigo-fonte e o tipo de coisa que uma normalizacao
  // de arquivo altera em silencio, e a deteccao para de funcionar sem que
  // nenhuma compilacao reclame.
  if (!/[\u00C3\u00C2][\u0080-\u00BF]/.test(texto)) return texto;

  try {
    const consertado = Buffer.from(texto, 'latin1').toString('utf-8');
    // So aceita se o resultado nao tiver caractere de substituicao: se tiver,
    // o palpite estava errado e o texto original era melhor.
    return consertado.includes('�') ? texto : consertado;
  } catch {
    return texto;
  }
}

/**
 * Bytes -> texto, descobrindo a codificacao.
 *
 * Excel em portugues salva CSV em Windows-1252 por padrao; quem exporta do
 * Google Planilhas manda UTF-8. Ler um como o outro estraga todo acento, e o
 * usuario nao tem como saber qual e o seu.
 *
 * @returns {{texto: string, codificacao: string}}
 */
function decodificar(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

  // BOM de UTF-8: a unica pista explicita que existe.
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { texto: buffer.subarray(3).toString('utf-8'), codificacao: 'utf-8 (com BOM)' };
  }

  const comoUtf8 = buffer.toString('utf-8');
  if (!comoUtf8.includes('�')) {
    const reparado = repararAcentos(comoUtf8);
    return {
      texto: reparado,
      codificacao: reparado === comoUtf8 ? 'utf-8' : 'utf-8 (acentos reparados)',
    };
  }

  // Byte invalido em UTF-8 significa que o arquivo nao e UTF-8.
  return { texto: buffer.toString('latin1'), codificacao: 'windows-1252' };
}

// ---------------------------------------------------------------- separador

/**
 * Virgula ou ponto e virgula?
 *
 * O Excel em portugues usa ";" porque a virgula ja e o separador decimal.
 * Decidir pela contagem na primeira linha util e mais confiavel que perguntar:
 * quem exporta a planilha nao sabe responder.
 */
function detectarSeparador(texto) {
  const linha = texto.split(/\r?\n/).find((l) => l.trim()) || '';

  // Conta apenas fora de aspas: um campo como "SILVA, JOAO" nao pode votar.
  const contar = (sep) => {
    let fora = 0;
    let dentro = false;
    for (const ch of linha) {
      if (ch === '"') dentro = !dentro;
      else if (ch === sep && !dentro) fora += 1;
    }
    return fora;
  };

  const candidatos = [',', ';', '\t'].map((sep) => ({ sep, n: contar(sep) }));
  const vencedor = candidatos.sort((a, b) => b.n - a.n)[0];
  return vencedor.n > 0 ? vencedor.sep : ',';
}

// ------------------------------------------------------------------ parser

/**
 * CSV -> matriz de strings. Segue o RFC 4180 no que importa:
 * campo entre aspas pode conter separador, quebra de linha e aspas escapadas
 * como `""`.
 */
function parseLinhas(texto, separador) {
  const linhas = [];
  let campo = '';
  let linha = [];
  let dentroDeAspas = false;

  for (let i = 0; i < texto.length; i += 1) {
    const ch = texto[i];

    if (dentroDeAspas) {
      if (ch === '"') {
        // Aspas dobradas dentro do campo representam uma aspa literal.
        if (texto[i + 1] === '"') {
          campo += '"';
          i += 1;
        } else {
          dentroDeAspas = false;
        }
      } else {
        campo += ch;
      }
      continue;
    }

    if (ch === '"') {
      dentroDeAspas = true;
    } else if (ch === separador) {
      linha.push(campo);
      campo = '';
    } else if (ch === '\n') {
      linha.push(campo);
      linhas.push(linha);
      linha = [];
      campo = '';
    } else if (ch !== '\r') {
      campo += ch;
    }
  }

  // A ultima linha costuma vir sem quebra no fim.
  if (campo !== '' || linha.length) {
    linha.push(campo);
    linhas.push(linha);
  }

  return linhas.map((l) => l.map((c) => c.trim()));
}

// ------------------------------------------------------------- cabecalho

const naoVazias = (linha) => linha.filter((c) => c && c.trim()).length;

/**
 * Descobre em que linha esta o cabecalho.
 *
 * Planilha de escritorio quase nunca comeca no cabecalho: ha titulo, linha em
 * branco, uma celula solta com o nome da aba. No arquivo real, a primeira
 * linha tinha duas celulas preenchidas e o cabecalho de verdade estava na
 * segunda, com vinte.
 *
 * Criterio: entre as primeiras linhas, a que tem mais celulas preenchidas.
 * Empate fica com a primeira, que e a mais provavel.
 */
function acharCabecalho(linhas, limite = 10) {
  let melhor = 0;
  let maior = naoVazias(linhas[0] || []);

  for (let i = 1; i < Math.min(limite, linhas.length); i += 1) {
    const total = naoVazias(linhas[i]);
    if (total > maior) {
      maior = total;
      melhor = i;
    }
  }

  return melhor;
}

/**
 * Colunas que so ocupam espaco: sem titulo, ou com titulo generico do Excel
 * ("Coluna 7") e nenhum valor em linha nenhuma.
 */
function colunasUteis(cabecalho, linhas) {
  return cabecalho
    .map((titulo, indice) => ({ titulo: titulo.trim(), indice }))
    .filter(({ titulo, indice }) => {
      const temValor = linhas.some((l) => (l[indice] || '').trim());
      if (temValor) return true;
      if (!titulo) return false;
      return !/^coluna\s*\d+$/i.test(titulo);
    });
}

/**
 * Le um CSV inteiro e devolve o que a tela precisa para montar o mapeamento.
 *
 * @param {Buffer} bytes conteudo bruto do arquivo
 */
function ler(bytes) {
  const { texto, codificacao } = decodificar(bytes);
  const separador = detectarSeparador(texto);
  const linhas = parseLinhas(texto, separador).filter((l) => naoVazias(l) > 0);

  if (!linhas.length) {
    return { erro: 'O arquivo esta vazio ou nao pode ser lido.' };
  }

  const indiceCabecalho = acharCabecalho(linhas);
  const cabecalhoBruto = linhas[indiceCabecalho];
  const corpo = linhas.slice(indiceCabecalho + 1);

  const colunas = colunasUteis(cabecalhoBruto, corpo);

  if (!colunas.length) {
    return { erro: 'Nao encontrei colunas com conteudo neste arquivo.' };
  }

  // As linhas passam a ser objetos { titulo -> valor }, so com as colunas uteis.
  const registros = corpo
    .map((linha) => {
      const registro = {};
      for (const { titulo, indice } of colunas) registro[titulo] = (linha[indice] || '').trim();
      return registro;
    })
    // Linha totalmente vazia depois do recorte nao e um cliente.
    .filter((r) => Object.values(r).some((v) => v));

  return {
    codificacao,
    separador: separador === '\t' ? 'tabulacao' : separador,
    linhaDoCabecalho: indiceCabecalho + 1,
    colunas: colunas.map((c) => c.titulo),
    colunasDescartadas: cabecalhoBruto.length - colunas.length,
    registros,
    total: registros.length,
  };
}

module.exports = {
  ler,
  decodificar,
  repararAcentos,
  detectarSeparador,
  parseLinhas,
  acharCabecalho,
  colunasUteis,
};
