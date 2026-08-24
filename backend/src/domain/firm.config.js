/**
 * Dados do escritorio. Fonte unica para o agente: nada aqui pode ser inventado
 * pelo modelo, e nada que nao esteja aqui pode ser afirmado como fato.
 */

const FIRM = {
  nome: 'Barbosa, Loli e Oliveira Sociedade de Advogados',
  nomeCurto: 'Barbosa, Loli e Oliveira',
  area: 'Direito do Trabalho',
  posicionamento:
    'Atuacao estrategica na defesa dos direitos do trabalhador, com solucoes rapidas e seguras.',
  diferenciais: [
    'Contato direto com o advogado responsavel pelo caso, sem intermediarios',
    'Atendimento presencial, por visita agendada ou online',
  ],
  contato: {
    telefone: '(19) 99638-3884',
    email: 'contato@bloadv.com.br',
    site: 'bloadv.com.br',
  },
  unidades: [
    {
      id: 'sp-capital',
      uf: 'SP',
      cidade: 'Sao Paulo',
      rotulo: 'Sao Paulo - Capital',
      endereco:
        'Edificio Marques Business Center, 405, loja 2, sala 1.702, 17o andar - Barra Funda',
      telefone: '(11) 94006-1595',
    },
    {
      id: 'sp-interior',
      uf: 'SP',
      cidade: 'Santo Antonio de Posse',
      rotulo: 'Sao Paulo - Interior',
      endereco: 'Rua Assumpta Mion Bianchi, 100 - Vila Bianchi',
      telefone: null,
    },
    {
      id: 'ce',
      uf: 'CE',
      cidade: 'Iguatu',
      rotulo: 'Ceara',
      endereco: 'Rua Coronel Virgilio Correia, 352 - Centro',
      telefone: null,
    },
    {
      id: 'mt',
      uf: 'MT',
      cidade: 'Cuiaba',
      rotulo: 'Mato Grosso',
      endereco: 'Avenida Uruguai, 270 - Santa Rosa',
      telefone: null,
    },
  ],
  atendimento: {
    formatos: ['presencial no escritorio', 'visita agendada', 'online'],
    // Ajuste conforme a rotina real do escritorio.
    horario: 'segunda a sexta, das 9h as 18h',
  },
  /** Servicos anunciados. O agente nao pode oferecer nada fora desta lista. */
  servicos: [
    'Analise de rescisao e verbas rescisorias',
    'Reconhecimento de vinculo empregatico (inclusive PJ mascarado)',
    'Carteira de trabalho nao assinada',
    'Diferencas salariais e salario pago por fora',
    'Horas extras nao pagas',
    'Demissao no periodo de estabilidade',
    'Assedio moral e assedio sexual no trabalho',
    'Adicional de insalubridade e periculosidade',
    'Rescisao indireta',
  ],
};

/** Linha compacta com as unidades, usada quando o contato pergunta onde fica. */
function renderUnidades() {
  return FIRM.unidades
    .map(
      (u) =>
        `${u.rotulo} - ${u.cidade}/${u.uf}: ${u.endereco}${u.telefone ? ` (${u.telefone})` : ''}`
    )
    .join(' | ');
}

/** Bloco curto de identidade injetado em toda conversa (cabe em poucas dezenas de tokens). */
function renderIdentidade() {
  return [
    `escritorio=${FIRM.nome}`,
    `area=${FIRM.area}`,
    `contato=${FIRM.contato.telefone} / ${FIRM.contato.email}`,
    `unidades=${FIRM.unidades.map((u) => `${u.cidade}-${u.uf}`).join(', ')}`,
    `atendimento=${FIRM.atendimento.formatos.join(', ')}`,
  ].join('\n');
}

module.exports = { FIRM, renderUnidades, renderIdentidade };
