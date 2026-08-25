const configService = require('./config.service');
const sandbox = require('./sandbox.service');
const { validar } = require('./validator');
const { comparar } = require('./diff');
const {
  listarTons,
  listarMensagens,
  CAMPOS_EMPRESA,
  LIMITES,
  padraoDoAgente,
  sanitizar,
} = require('./config.schema');
const { REGRAS_INVIOLAVEIS } = require('../agent/prompt.builder');
const { getAgent } = require('../config/agents.config');
const { exigir, PAPEIS, papelDe, permissoes } = require('../auth/roles');
const authService = require('../auth/auth.service');
const { User } = require('../models');

/**
 * ROTAS DA CURADORIA
 * ------------------
 * Tudo aqui ja passou pelo hook de autenticacao (auth.hook), que exige token
 * valido de usuario ativo. Cada rota que ESCREVE ganha ainda um `preHandler`
 * de papel.
 *
 * Nenhuma rota devolve chave, token, string de conexao, nome de modelo ou
 * caminho de arquivo. E o mesmo principio do esquema: a interface trata de
 * conteudo, e conteudo nao precisa de infraestrutura para ser editado.
 */

const naoEncontrado = (reply) => reply.code(404).send({ error: 'Agente nao encontrado' });

async function curadoriaRoutes(fastify) {
  /**
   * Vocabulario da interface: tons, mensagens, campos e limites.
   *
   * Vem do servidor, e nao duplicado no front, porque sao os mesmos objetos
   * que o validador e o construtor de prompt usam. Duplicar significaria a
   * tela oferecendo um tom que o motor nao conhece.
   */
  fastify.get('/api/curadoria/opcoes', async (request) => ({
    tons: listarTons(),
    mensagens: listarMensagens(),
    camposEmpresa: CAMPOS_EMPRESA,
    limites: LIMITES,
    // Mostradas na tela como somente leitura: a equipe precisa SABER que
    // existem, senao vai tentar reescrever no prompt algo que ja e garantido.
    regrasInviolaveis: REGRAS_INVIOLAVEIS,
    papeis: Object.values(PAPEIS),
    permissoes: permissoes(request.user),
  }));

  /** Lista de agentes com versao, rascunho pendente e status. */
  fastify.get('/api/curadoria/agentes', async () => ({ agentes: await configService.listar() }));

  fastify.get('/api/curadoria/agentes/:id', async (request, reply) => {
    const estado = await configService.obter(request.params.id);
    return estado || naoEncontrado(reply);
  });

  /**
   * Salvar rascunho. Nao publica: e o "Ctrl+S" da curadoria, e pode ser
   * chamado a cada pausa de digitacao sem consequencia para o atendimento.
   */
  fastify.put(
    '/api/curadoria/agentes/:id/rascunho',
    { preHandler: exigir('editar') },
    async (request, reply) => {
      const { id } = request.params;
      if (!getAgent(id)) return naoEncontrado(reply);

      return configService.salvarRascunho(id, request.body?.config ?? request.body, request.user);
    }
  );

  /** Validacao sob demanda, sem gravar nada. Alimenta os avisos na tela. */
  fastify.post(
    '/api/curadoria/agentes/:id/validar',
    { preHandler: exigir('editar') },
    async (request, reply) => {
      const { id } = request.params;
      if (!getAgent(id)) return naoEncontrado(reply);

      const config = sanitizar(request.body?.config ?? request.body, id);
      const estado = await configService.obter(id);

      return {
        validacao: validar(config, estado.nuncaPublicada ? null : estado.publicada),
        alteracoes: comparar(estado.publicada, config),
      };
    }
  );

  /** Comparacao entre o que esta no ar e o rascunho salvo. */
  fastify.get('/api/curadoria/agentes/:id/diferencas', async (request, reply) => {
    const estado = await configService.obter(request.params.id);
    if (!estado) return naoEncontrado(reply);

    return {
      alteracoes: estado.alteracoes,
      temRascunho: estado.temRascunho,
      validacao: estado.rascunho
        ? validar(estado.rascunho, estado.nuncaPublicada ? null : estado.publicada)
        : null,
    };
  });

  /** Rascunho -> producao. A validacao roda de novo aqui, no servidor. */
  fastify.post(
    '/api/curadoria/agentes/:id/publicar',
    { preHandler: exigir('publicar') },
    async (request, reply) => {
      const { id } = request.params;
      if (!getAgent(id)) return naoEncontrado(reply);

      const resultado = await configService.publicar(id, request.user, request.body?.nota);

      if (resultado.semRascunho) {
        return reply.code(400).send({ error: 'Nao ha alteracoes para publicar.' });
      }
      // 422: o pedido esta bem formado, o conteudo e que nao pode ir ao ar.
      // A tela usa `validacao` para dizer o que corrigir, campo a campo.
      if (!resultado.ok) return reply.code(422).send(resultado);

      return resultado;
    }
  );

  /** Volta ao que esta publicado, jogando fora o rascunho. */
  fastify.post(
    '/api/curadoria/agentes/:id/descartar',
    { preHandler: exigir('editar') },
    async (request, reply) => {
      const { id } = request.params;
      if (!getAgent(id)) return naoEncontrado(reply);
      return configService.descartarRascunho(id, request.user);
    }
  );

  // ------------------------------------------------------------ historico

  fastify.get('/api/curadoria/agentes/:id/versoes', async (request, reply) => {
    const { id } = request.params;
    if (!getAgent(id)) return naoEncontrado(reply);

    return { versoes: await configService.versoes(id, Number(request.query?.limite) || 50) };
  });

  fastify.get('/api/curadoria/agentes/:id/versoes/:numero', async (request, reply) => {
    const { id, numero } = request.params;
    if (!getAgent(id)) return naoEncontrado(reply);

    const versao = await configService.versao(id, numero);
    if (!versao) return reply.code(404).send({ error: 'Versao nao encontrada' });

    // A comparacao com o que esta no ar e o que responde a pergunta real de
    // quem abre uma versao antiga: "o que eu ganho voltando para esta?"
    const estado = await configService.obter(id);
    return { ...versao, alteracoesEmRelacaoAoAtual: comparar(estado.publicada, versao.config) };
  });

  fastify.post(
    '/api/curadoria/agentes/:id/versoes/:numero/restaurar',
    { preHandler: exigir('restaurar') },
    async (request, reply) => {
      const { id, numero } = request.params;
      if (!getAgent(id)) return naoEncontrado(reply);

      const resultado = await configService.restaurar(id, numero, request.user);
      if (resultado.naoEncontrada) return reply.code(404).send({ error: 'Versao nao encontrada' });

      return resultado;
    }
  );

  // --------------------------------------------------------------- status

  fastify.post(
    '/api/curadoria/agentes/:id/status',
    { preHandler: exigir('alterarStatus') },
    async (request, reply) => {
      const { id } = request.params;
      if (!getAgent(id)) return naoEncontrado(reply);

      try {
        return await configService.definirStatus(id, request.body?.status, request.user);
      } catch (error) {
        return reply.code(400).send({ error: error.message });
      }
    }
  );

  // ---------------------------------------------------------------- teste

  /**
   * Conversa de teste com o rascunho.
   *
   * O corpo traz a configuracao a testar. Isso e deliberado: o curador
   * consegue testar o que esta na TELA, inclusive alteracoes que ainda nem
   * salvou como rascunho. Ter de salvar antes de testar empurraria a pessoa a
   * salvar coisas pela metade.
   */
  fastify.post(
    '/api/curadoria/agentes/:id/testar',
    { preHandler: exigir('testar') },
    async (request, reply) => {
      const { id } = request.params;
      if (!getAgent(id)) return naoEncontrado(reply);

      const config = request.body?.config
        ? sanitizar(request.body.config, id)
        : (await configService.obter(id))?.rascunho || configService.publicada(id);

      const resultado = await sandbox.conversar({
        agentId: id,
        config,
        mensagem: request.body?.mensagem,
        historico: request.body?.historico,
        ontologia: request.body?.ontologia,
        usuario: request.user,
      });

      if (!resultado.ok) return reply.code(400).send({ error: resultado.erro });
      return resultado;
    }
  );

  /** Configuracao de fabrica, para o botao "voltar ao padrao" de cada campo. */
  fastify.get('/api/curadoria/agentes/:id/padrao', async (request, reply) => {
    const { id } = request.params;
    if (!getAgent(id)) return naoEncontrado(reply);
    return { config: padraoDoAgente(id) };
  });

  // ------------------------------------------------------------- usuarios

  fastify.get(
    '/api/curadoria/usuarios',
    { preHandler: exigir('gerenciarUsuarios') },
    async () => {
      const usuarios = await User.find().sort({ createdAt: 1 }).lean();
      return {
        usuarios: usuarios.map((u) => ({
          id: u._id.toString(),
          email: u.email,
          nome: u.name || null,
          papel: papelDe(u),
          papelBruto: u.role,
          ativo: u.active !== false,
          ultimoAcesso: u.lastLoginAt || null,
        })),
      };
    }
  );

  fastify.post(
    '/api/curadoria/usuarios',
    { preHandler: exigir('gerenciarUsuarios') },
    async (request, reply) => {
      const { email, senha, nome, papel } = request.body || {};

      if (!senha || String(senha).length < 10) {
        return reply.code(400).send({ error: 'A senha precisa ter pelo menos 10 caracteres.' });
      }
      if (papel && !PAPEIS[papel]) {
        return reply.code(400).send({ error: 'Nivel de acesso invalido.' });
      }

      // createUser faz upsert: sem esta checagem, "criar" um email existente
      // trocaria a senha de outra pessoa em silencio.
      const jaExiste = await User.findOne({ email: String(email || '').toLowerCase().trim() }).lean();
      if (jaExiste) {
        return reply.code(409).send({ error: 'Ja existe um usuario com este email.' });
      }

      try {
        const usuario = await authService.createUser({
          email,
          password: senha,
          name: nome,
          role: papel || 'curador',
        });
        return { usuario };
      } catch (error) {
        return reply.code(400).send({ error: error.message });
      }
    }
  );

  fastify.patch(
    '/api/curadoria/usuarios/:id',
    { preHandler: exigir('gerenciarUsuarios') },
    async (request, reply) => {
      const { id } = request.params;
      const { papel, ativo, nome } = request.body || {};

      if (papel && !PAPEIS[papel]) {
        return reply.code(400).send({ error: 'Nivel de acesso invalido.' });
      }

      // Um administrador que se rebaixa ou se desativa deixa o painel sem dono
      // quando ele e o unico. Barrar a propria conta e mais simples - e mais
      // seguro - do que contar administradores a cada requisicao.
      if (id === request.user.id && ((papel && papel !== 'admin') || ativo === false)) {
        return reply.code(400).send({
          error: 'Voce nao pode remover o proprio acesso de administrador. Peca a outro administrador.',
        });
      }

      const alteracoes = {};
      if (papel) alteracoes.role = papel;
      if (typeof ativo === 'boolean') alteracoes.active = ativo;
      if (typeof nome === 'string') alteracoes.name = nome.trim();

      if (!Object.keys(alteracoes).length) {
        return reply.code(400).send({ error: 'Nada para alterar.' });
      }

      const usuario = await User.findByIdAndUpdate(id, { $set: alteracoes }, { new: true });
      if (!usuario) return reply.code(404).send({ error: 'Usuario nao encontrado' });

      return { usuario: usuario.toPublic() };
    }
  );
}

module.exports = curadoriaRoutes;
