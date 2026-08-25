/**
 * NIVEIS DE ACESSO
 * ----------------
 *   admin        altera, publica, restaura versoes, liga/desliga agentes e gerencia usuarios
 *   curador      edita, testa e publica a configuracao dos agentes
 *   visualizador consulta configuracao, historico e metricas; nao altera nada
 *
 * `operador` e o papel que existia antes desta interface. Ele continua valendo
 * como sinonimo de curador em vez de ser migrado no banco: renomear papel de
 * usuario num sistema em producao e a forma classica de trancar todo mundo
 * para fora numa sexta-feira. Contas novas ja nascem com os nomes novos.
 */
const PAPEIS = {
  admin: {
    id: 'admin',
    label: 'Administrador',
    descricao: 'Altera, publica, restaura versoes e gerencia usuarios.',
  },
  curador: {
    id: 'curador',
    label: 'Curador',
    descricao: 'Edita, testa e publica a configuracao dos agentes.',
  },
  visualizador: {
    id: 'visualizador',
    label: 'Visualizador',
    descricao: 'Consulta configuracoes, historico e metricas. Nao altera nada.',
  },
};

/** Papel efetivo de um usuario, ja resolvendo o nome legado. */
const papelDe = (usuario) => {
  const papel = usuario?.role;
  if (papel === 'operador') return 'curador';
  return PAPEIS[papel] ? papel : 'visualizador';
};

const ehAdmin = (usuario) => papelDe(usuario) === 'admin';
const podeCurar = (usuario) => ['admin', 'curador'].includes(papelDe(usuario));
const podeVer = (usuario) => Boolean(usuario);

/**
 * O que a interface deve mostrar. Enviado junto com o usuario no login para
 * que o painel esconda o que a pessoa nao pode fazer - e o servidor confere
 * de novo em cada rota, porque esconder botao nao e permissao.
 */
const permissoes = (usuario) => ({
  papel: papelDe(usuario),
  ver: podeVer(usuario),
  editar: podeCurar(usuario),
  testar: podeCurar(usuario),
  publicar: podeCurar(usuario),
  restaurar: ehAdmin(usuario),
  alterarStatus: ehAdmin(usuario),
  gerenciarUsuarios: ehAdmin(usuario),
});

/**
 * preHandler do Fastify. Recusa com 403 e uma frase que diz o que fazer -
 * "Nao autorizado" sozinho faz a pessoa achar que o sistema quebrou.
 */
function exigir(capacidade) {
  return async (request, reply) => {
    if (!permissoes(request.user)[capacidade]) {
      return reply.code(403).send({
        error:
          `Seu acesso (${PAPEIS[papelDe(request.user)].label}) nao permite esta acao. ` +
          'Peca a um administrador do painel.',
      });
    }
  };
}

module.exports = { PAPEIS, papelDe, ehAdmin, podeCurar, podeVer, permissoes, exigir };
