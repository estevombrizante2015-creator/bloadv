const { LIMITES, MENSAGENS, CAMPOS_EMPRESA, TONS } = require('./config.schema');

/**
 * VALIDACAO ANTES DE PUBLICAR
 * ---------------------------
 * Roda entre "Publicar" e a producao. Duas severidades, com efeitos distintos:
 *
 *   erro  -> impede a publicacao. So entra aqui o que quebra o atendimento ou
 *            vaza segredo: prompt vazio, credencial colada, campo obrigatorio
 *            em branco, valor fora da faixa.
 *
 *   aviso -> aparece na tela e a pessoa decide. Aqui mora tudo que e
 *            HEURISTICA: contradicao provavel, regra essencial que sumiu,
 *            texto encolhendo demais.
 *
 * A separacao e deliberada. Um palpite de maquina nunca pode travar o trabalho
 * de quem conhece o escritorio - se a heuristica errar e bloquear, a equipe
 * fica refem de um desenvolvedor, que e exatamente o que esta interface veio
 * eliminar. Bloqueio so para o que e certo.
 */

const problema = (nivel, campo, titulo, mensagem, comoCorrigir) => ({
  nivel,
  campo,
  titulo,
  mensagem,
  comoCorrigir,
});

const erro = (...args) => problema('erro', ...args);
const aviso = (...args) => problema('aviso', ...args);

/**
 * As instrucoes principais nao tem teto (ver LIMITES em config.schema): o
 * escritorio precisa poder escrever o quanto o trabalho exigir.
 *
 * Este numero nao limita nada — e o ponto a partir do qual vale a pena AVISAR
 * que o texto agora pesa em toda resposta. ~24 mil caracteres sao cerca de 6
 * mil tokens por turno, que e onde o custo comeca a aparecer na conta e o
 * essencial comeca a disputar atencao com o detalhe.
 */
const PROMPT_LONGO = 24000;

// ------------------------------------------------------------ credenciais

/**
 * Segredo colado por engano no texto do agente. Acontece de verdade: alguem
 * testa uma integracao, copia a chave para o bloco de notas e cola no campo
 * errado. O prompt vai inteiro para a OpenAI e fica gravado no historico de
 * versoes - onde qualquer curador le.
 */
const PADROES_CREDENCIAL = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}/, nome: 'chave da OpenAI' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, nome: 'token do Slack' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, nome: 'chave da AWS' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/, nome: 'token do GitHub' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, nome: 'token JWT' },
  { re: /mongodb(\+srv)?:\/\/\S+/i, nome: 'endereco de banco de dados' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, nome: 'chave privada' },
  { re: /\b(api[_-]?key|secret|senha|password|token)\s*[:=]\s*\S{8,}/i, nome: 'credencial' },
  { re: /\bBearer\s+[A-Za-z0-9._-]{20,}/, nome: 'token de autorizacao' },
];

function procurarCredenciais(campo, rotulo, texto) {
  const achados = [];
  for (const { re, nome } of PADROES_CREDENCIAL) {
    if (re.test(String(texto || ''))) {
      achados.push(
        erro(
          campo,
          'Credencial no texto',
          `O campo "${rotulo}" parece conter uma ${nome}.`,
          'Apague esse trecho. Chaves e senhas nunca ficam na configuracao do agente: ' +
            'elas sao guardadas pelo time tecnico, fora do painel.'
        )
      );
      break; // uma denuncia por campo basta; a pessoa vai revisar o campo inteiro
    }
  }
  return achados;
}

// --------------------------------------------------------- regras essenciais

/**
 * Temas que um atendimento automatico de escritorio nao deveria perder. A
 * checagem e por palavra-chave em QUALQUER lugar do texto curado (regras
 * ativas, prompt e restricoes), nao por regra literal: o escritorio pode
 * escrever a mesma ideia com as palavras dele.
 */
const REGRAS_ESSENCIAIS = [
  {
    id: 'nao_inventar',
    titulo: 'Nunca inventar informacao',
    re: /invent|nao sei|não sei|confirmar com|chutar|supor/i,
    porque: 'Sem isso o agente preenche lacuna com texto plausivel, e no atendimento juridico isso vira promessa.',
  },
  {
    id: 'idioma',
    titulo: 'Responder em portugues',
    re: /portugu|idioma|lingua|língua/i,
    porque: 'Sem isso o agente pode responder no idioma da ultima mensagem recebida, inclusive de um bot.',
  },
  {
    id: 'nao_repetir_pergunta',
    titulo: 'Nao repetir pergunta ja respondida',
    re: /repet|de novo|novamente|ja respond|já respond|ja forneceu|já forneceu/i,
    porque: 'E a queixa numero um de quem conversa com atendimento automatico.',
  },
  {
    id: 'antibot',
    titulo: 'Encerrar interacao com outro robo',
    re: /rob[oô]|autom[aá]tic|bot\b|loop/i,
    porque: 'Sem isso dois atendimentos automaticos conversam entre si indefinidamente.',
  },
  {
    id: 'escopo',
    titulo: 'Nao tratar assunto fora do escopo',
    re: /fora do (contexto|escopo|assunto)|nao (e|é) do escopo|so (trata|atende)|apenas (trata|atende)/i,
    porque: 'Sem limite de assunto o agente responde qualquer coisa em nome do escritorio.',
  },
];

// ------------------------------------------------------------ contradicoes

const PARADAS = new Set([
  'a','o','as','os','de','da','do','das','dos','em','no','na','nos','nas','um','uma','uns','umas',
  'para','pra','por','com','sem','que','se','ao','aos','e','ou','mas','the','ja','já','ser','sao',
  'são','esta','está','seja','muito','mais','menos','todo','toda','todos','todas','isso','esse',
  'essa','quando','como','qualquer','algo','voce','você','pessoa','contato','cliente','agente',
]);

const NEGATIVAS = /\b(nunca|jamais|nao|não|evite|evitar|proibido|nao pode|não pode|deixe de)\b/i;
const POSITIVAS = /\b(sempre|obrigatoriamente|deve|devera|deverá|precisa|deve-se|deve sempre)\b/i;

/** Palavras de conteudo de uma frase: e sobre elas que a contradicao e medida. */
function conteudo(texto) {
  return new Set(
    String(texto || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((p) => p.length > 3 && !PARADAS.has(p))
  );
}

function polaridade(texto) {
  const negativa = NEGATIVAS.test(texto);
  const positiva = POSITIVAS.test(texto);
  if (negativa && !positiva) return -1;
  if (positiva && !negativa) return 1;
  return 0;
}

/**
 * Duas regras ativas que mandam o oposto sobre o mesmo assunto.
 *
 * O criterio e polaridade contraria + sobreposicao alta de palavras de
 * conteudo. Tres palavras em comum e o piso: com duas, "nunca prometa prazo"
 * e "sempre confirme o prazo com o advogado" apareceriam como conflito, e um
 * validador que grita a toa e um validador que a equipe aprende a ignorar.
 */
function procurarContradicoes(regras) {
  const ativas = regras.filter((r) => r.ativa);
  const saida = [];

  for (let i = 0; i < ativas.length; i += 1) {
    for (let j = i + 1; j < ativas.length; j += 1) {
      const a = ativas[i];
      const b = ativas[j];

      const pa = polaridade(a.texto);
      const pb = polaridade(b.texto);
      if (pa === 0 || pb === 0 || pa === pb) continue;

      const ca = conteudo(a.texto);
      const cb = conteudo(b.texto);
      const comuns = [...ca].filter((p) => cb.has(p));
      const menor = Math.min(ca.size, cb.size) || 1;

      if (comuns.length >= 3 && comuns.length / menor >= 0.5) {
        saida.push(
          aviso(
            `regras.${b.id}`,
            'Regras podem se contradizer',
            `Estas duas regras parecem mandar o contrario uma da outra sobre "${comuns.slice(0, 3).join(', ')}":\n` +
              `• ${a.texto}\n• ${b.texto}`,
            'Se as duas estiverem certas, reescreva uma delas deixando claro em que situacao cada uma vale. ' +
              'Se so uma valer, desative a outra.'
          )
        );
      }
    }
  }

  return saida;
}

// ---------------------------------------------------------------- validar

/**
 * @param {object} config     rascunho ja sanitizado
 * @param {object} [publicada] versao no ar, para detectar encolhimento brusco
 * @returns {{ok: boolean, erros: Array, avisos: Array}}
 */
function validar(config, publicada = null) {
  const problemas = [];

  // ---------- prompt principal ----------
  const prompt = String(config.promptPrincipal || '').trim();
  if (!prompt) {
    problemas.push(
      erro(
        'promptPrincipal',
        'Instrucoes vazias',
        'O agente esta sem instrucoes principais.',
        'Escreva quem ele e, para quem fala e o que precisa conseguir na conversa. ' +
          'Pense como se estivesse explicando o trabalho a alguem no primeiro dia.'
      )
    );
  } else if (prompt.length < 80) {
    problemas.push(
      aviso(
        'promptPrincipal',
        'Instrucoes muito curtas',
        `As instrucoes tem ${prompt.length} caracteres. E pouco para o agente saber o que fazer.`,
        'Diga pelo menos: quem ele e, quem esta do outro lado e qual o objetivo da conversa.'
      )
    );
  } else if (prompt.length > PROMPT_LONGO) {
    problemas.push(
      aviso(
        'promptPrincipal',
        'Instrucoes bem longas',
        `As instrucoes tem ${prompt.length.toLocaleString('pt-BR')} caracteres (cerca de ` +
          `${Math.round(prompt.length / 4 / 100) / 10} mil tokens). Nao existe teto, e o texto vai ` +
          'inteiro para o agente — mas ele entra em TODA resposta, entao o custo por conversa sobe ' +
          'junto e o que e essencial disputa espaco com o que e detalhe.',
        'Se puder, mova o que for informacao do escritorio (servicos, horarios, politicas) para a ' +
          'aba Informacoes da empresa. Se o comportamento realmente exige este tamanho, publique: ' +
          'este aviso e informativo e nao impede nada.'
      )
    );
  }

  // ---------- tom de voz ----------
  if (config.tomDeVoz?.preset === 'personalizado' && !String(config.tomDeVoz?.descricao || '').trim()) {
    problemas.push(
      erro(
        'tomDeVoz.descricao',
        'Tom personalizado sem descricao',
        'Voce escolheu tom personalizado, mas nao descreveu como o agente deve falar.',
        'Descreva o tom desejado, ou escolha um dos tons prontos acima.'
      )
    );
  }

  if (!TONS[config.tomDeVoz?.preset]) {
    problemas.push(
      erro('tomDeVoz.preset', 'Tom invalido', 'O tom escolhido nao existe.', 'Escolha um dos tons da lista.')
    );
  }

  // ---------- regras ----------
  const regras = Array.isArray(config.regras) ? config.regras : [];
  const ativas = regras.filter((r) => r.ativa);

  if (!ativas.length) {
    problemas.push(
      erro(
        'regras',
        'Nenhuma regra ativa',
        'Todas as regras de comportamento estao desativadas.',
        'Ative pelo menos as regras basicas: nao inventar informacao, responder em portugues e ' +
          'nao repetir pergunta ja respondida.'
      )
    );
  }

  const textoCurado = [
    prompt,
    config.tomDeVoz?.descricao,
    ...ativas.map((r) => r.texto),
    config.empresa?.restricoes,
    config.empresa?.instrucoesOperacionais,
  ]
    .filter(Boolean)
    .join('\n');

  for (const essencial of REGRAS_ESSENCIAIS) {
    if (!essencial.re.test(textoCurado)) {
      problemas.push(
        aviso(
          'regras',
          `Faltando: ${essencial.titulo}`,
          `Nao encontrei nada sobre "${essencial.titulo.toLowerCase()}" nas regras ativas. ${essencial.porque}`,
          'Adicione uma regra sobre isso, ou reative a que foi desligada.'
        )
      );
    }
  }

  problemas.push(...procurarContradicoes(regras));

  // ---------- mensagens ----------
  for (const [chave, meta] of Object.entries(MENSAGENS)) {
    const texto = String(config.mensagens?.[chave] || '').trim();
    if (texto) continue;

    // Mensagem literal em branco vira silencio para o contato: o agente nao
    // esta no circuito nessas duas situacoes e nao tem como improvisar.
    if (!meta.comoModelo) {
      problemas.push(
        erro(
          `mensagens.${chave}`,
          `Mensagem obrigatoria em branco: ${meta.label}`,
          `${meta.usoReal} Sem texto, o contato fica sem resposta nenhuma.`,
          'Escreva a mensagem que deve ser enviada nessa situacao.'
        )
      );
    } else {
      problemas.push(
        aviso(
          `mensagens.${chave}`,
          `Mensagem em branco: ${meta.label}`,
          `Sem orientacao, o agente improvisa nessa situacao. ${meta.descricao}`,
          'Escreva como ele deve conduzir esse momento.'
        )
      );
    }
  }

  // ---------- tempo de espera ----------
  const segundos = Number(config.tempoDeEspera?.segundos);
  if (!Number.isFinite(segundos) || segundos < LIMITES.esperaSegundosMin || segundos > LIMITES.esperaSegundosMax) {
    problemas.push(
      erro(
        'tempoDeEspera.segundos',
        'Tempo de espera invalido',
        `O tempo precisa ficar entre ${LIMITES.esperaSegundosMin} e ${LIMITES.esperaSegundosMax} segundos.`,
        'Ajuste o controle. O padrao recomendado e 8 segundos.'
      )
    );
  } else if (segundos <= 2) {
    problemas.push(
      aviso(
        'tempoDeEspera.segundos',
        'Espera muito curta',
        `Com ${segundos} segundo(s), quem escreve em varias mensagens seguidas recebe uma resposta ` +
          'para cada pedaco, em vez de uma resposta ao conjunto.',
        'Deixe em 8 segundos, salvo se o escritorio quiser resposta quase imediata.'
      )
    );
  } else if (segundos >= 25) {
    problemas.push(
      aviso(
        'tempoDeEspera.segundos',
        'Espera muito longa',
        `Com ${segundos} segundos, quem manda uma mensagem so espera esse tempo inteiro antes de ` +
          'qualquer resposta, e pode achar que ninguem viu.',
        'Acima de 20 segundos costuma custar mais lead do que economiza mensagem.'
      )
    );
  }

  // ---------- midia ----------
  if (!config.audio?.habilitado && !config.imagem?.habilitado) {
    problemas.push(
      aviso(
        'audio.habilitado',
        'Audio e imagem desligados',
        'O agente vai ignorar o conteudo de audios e fotos. Boa parte de quem procura o escritorio ' +
          'manda audio na primeira mensagem.',
        'Se a intencao foi essa, siga. Caso contrario, reative pelo menos o audio.'
      )
    );
  }

  // ---------- informacoes da empresa ----------
  for (const campo of CAMPOS_EMPRESA) {
    const valor = String(config.empresa?.[campo.id] || '').trim();
    if (campo.obrigatorio && !valor) {
      problemas.push(
        erro(
          `empresa.${campo.id}`,
          `Campo obrigatorio vazio: ${campo.label}`,
          `Sem isso o agente nao tem o que dizer quando perguntarem sobre "${campo.label.toLowerCase()}".`,
          campo.dica
        )
      );
    }
  }

  // ---------- credenciais em qualquer campo livre ----------
  const camposLivres = [
    ['promptPrincipal', 'Instrucoes principais', config.promptPrincipal],
    ['tomDeVoz.descricao', 'Descricao do tom', config.tomDeVoz?.descricao],
    ['audio.instrucoes', 'Instrucoes de audio', config.audio?.instrucoes],
    ['imagem.instrucoes', 'Instrucoes de imagem', config.imagem?.instrucoes],
    ['web.instrucoes', 'Instrucoes da pesquisa na internet', config.web?.instrucoes],
    ...Object.entries(MENSAGENS).map(([k, m]) => [`mensagens.${k}`, m.label, config.mensagens?.[k]]),
    ...CAMPOS_EMPRESA.map((c) => [`empresa.${c.id}`, c.label, config.empresa?.[c.id]]),
    ...regras.map((r) => [`regras.${r.id}`, 'Regra', r.texto]),
    ...(config.empresa?.faq || []).map((f, i) => [`empresa.faq.${i}`, 'Pergunta frequente', `${f.pergunta} ${f.resposta}`]),
  ];

  for (const [campo, rotulo, valor] of camposLivres) {
    problemas.push(...procurarCredenciais(campo, rotulo, valor));
  }

  // ---------- encolhimento brusco em relacao ao que esta no ar ----------
  if (publicada) {
    const antes = String(publicada.promptPrincipal || '').trim().length;
    const depois = prompt.length;
    if (antes > 400 && depois < antes * 0.4) {
      problemas.push(
        aviso(
          'promptPrincipal',
          'As instrucoes encolheram muito',
          `O texto no ar tem ${antes} caracteres e o novo tem ${depois}. Uma queda dessas costuma ser ` +
            'texto apagado sem querer (selecionar tudo e digitar por cima).',
          'Abra a comparacao ao lado e confira se nao falta nada. Se foi de proposito, pode publicar.'
        )
      );
    }

    const ativasAntes = (publicada.regras || []).filter((r) => r.ativa).length;
    if (ativasAntes >= 4 && ativas.length < ativasAntes / 2) {
      problemas.push(
        aviso(
          'regras',
          'Muitas regras saíram de uma vez',
          `O agente tinha ${ativasAntes} regras ativas e ficou com ${ativas.length}.`,
          'Confira na comparacao se alguma regra importante foi removida por engano.'
        )
      );
    }
  }

  const erros = problemas.filter((p) => p.nivel === 'erro');
  const avisos = problemas.filter((p) => p.nivel === 'aviso');

  return { ok: erros.length === 0, erros, avisos };
}

module.exports = { validar, REGRAS_ESSENCIAIS, PADROES_CREDENCIAL, PROMPT_LONGO };
