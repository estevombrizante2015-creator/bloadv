const clienteService = require('./cliente.service');
const tarefaService = require('./tarefa.service');
const timeline = require('./timeline.service');
const pipeline = require('./pipeline.service');
const dashboard = require('./dashboard.service');
const ia = require('./ia.service');
const importacao = require('./importacao.service');
const { exigir, papelDe } = require('../auth/roles');
const { User, Cliente } = require('../models');

/**
 * ROTAS DA GESTAO DE CLIENTES
 * ---------------------------
 * Ja passaram pelo hook de autenticacao. Papeis:
 *
 *   visualizador  le tudo (lista, ficha, timeline, painel)
 *   curador       edita ficha, move no kanban, cria tarefa, usa a IA
 *   admin         configura o pipeline e exclui ficha
 *
 * Excluir e admin porque e a unica acao daqui que perde informacao de verdade:
 * a ficha vai junto com a timeline e as tarefas. Arquivar — que e o que a
 * equipe quer em 99% dos casos — e edicao comum.
 */

const naoEncontrado = (reply) => reply.code(404).send({ error: 'Cliente nao encontrado' });

async function clientesRoutes(fastify) {
  // ------------------------------------------------------------- pipeline

  fastify.get('/api/clientes/pipeline', async (request) => ({
    ...pipeline.atual(),
    prioridades: ['baixa', 'normal', 'alta', 'urgente'],
    podeConfigurar: papelDe(request.user) === 'admin',
  }));

  fastify.put(
    '/api/clientes/pipeline',
    { preHandler: exigir('alterarStatus') },
    async (request, reply) => {
      try {
        return await pipeline.salvar(request.body, request.user);
      } catch (error) {
        return reply.code(400).send({ error: error.message });
      }
    }
  );

  fastify.post(
    '/api/clientes/pipeline/restaurar',
    { preHandler: exigir('alterarStatus') },
    async (request) => pipeline.restaurarPadrao(request.user)
  );

  // --------------------------------------------------------------- listas

  fastify.get('/api/clientes', async (request) => clienteService.listar(request.query));

  fastify.get('/api/clientes/kanban', async (request) => clienteService.kanban(request.query));

  fastify.get('/api/clientes/painel', async () => dashboard.gerar());

  fastify.get('/api/clientes/agenda', async (request) =>
    tarefaService.agenda({
      responsavel: request.query?.responsavel,
      diasAFrente: Number(request.query?.dias) || 7,
    })
  );

  /** Quem pode ser responsavel por um cliente. */
  fastify.get('/api/clientes/responsaveis', async () => {
    const usuarios = await User.find({ active: true }, { name: 1, email: 1, role: 1 })
      .sort({ name: 1 })
      .lean();

    return {
      responsaveis: usuarios.map((u) => ({
        id: u._id.toString(),
        nome: u.name || u.email,
        email: u.email,
      })),
    };
  });

  // ----------------------------------------------------------- importacao

  /**
   * O arquivo chega em base64, dentro do JSON.
   *
   * Poderia ser multipart, mas isso exigiria mais uma dependencia no servidor —
   * e, principalmente, o navegador decidiria a codificacao do texto por conta
   * propria. Recebendo os BYTES, quem descobre se e UTF-8 ou Windows-1252 e o
   * servidor, que e onde essa decisao pode ser testada.
   *
   * O limite de corpo sobe: uma carteira de milhares de clientes passa
   * folgado do 1 MB padrao do Fastify, e o erro que isso produz nao explica
   * nada a quem esta importando.
   */
  const limiteDoArquivo = { bodyLimit: 12 * 1024 * 1024 };

  const bytesDoCorpo = (request, reply) => {
    const base64 = request.body?.conteudoBase64;
    if (!base64) {
      reply.code(400).send({ error: 'Envie o arquivo.' });
      return null;
    }

    const bytes = Buffer.from(String(base64), 'base64');
    if (!bytes.length) {
      reply.code(400).send({ error: 'O arquivo chegou vazio.' });
      return null;
    }

    return bytes;
  };

  /** Passo 1: le o arquivo e sugere o mapeamento. Nao grava nada. */
  fastify.post(
    '/api/clientes/importar/analisar',
    { preHandler: exigir('editar'), ...limiteDoArquivo },
    async (request, reply) => {
      const bytes = bytesDoCorpo(request, reply);
      if (!bytes) return undefined;

      const analise = await importacao.analisar(bytes);
      if (analise.erro) return reply.code(400).send({ error: analise.erro });
      return analise;
    }
  );

  /** Passo 2: simula a importacao com o mapeamento escolhido. Nao grava nada. */
  fastify.post(
    '/api/clientes/importar/prever',
    { preHandler: exigir('editar'), ...limiteDoArquivo },
    async (request, reply) => {
      const bytes = bytesDoCorpo(request, reply);
      if (!bytes) return undefined;

      const previa = await importacao.prever(bytes, request.body?.mapeamento || {}, {
        atualizarExistentes: request.body?.atualizarExistentes === true,
      });
      if (previa.erro) return reply.code(400).send({ error: previa.erro });
      return previa;
    }
  );

  /** Passo 3: grava. */
  fastify.post(
    '/api/clientes/importar',
    { preHandler: exigir('editar'), ...limiteDoArquivo },
    async (request, reply) => {
      const bytes = bytesDoCorpo(request, reply);
      if (!bytes) return undefined;

      const resultado = await importacao.importar(bytes, request.body?.mapeamento || {}, {
        atualizarExistentes: request.body?.atualizarExistentes === true,
        usuario: request.user,
      });
      if (resultado.erro) return reply.code(400).send({ error: resultado.erro });
      return resultado;
    }
  );

  // ---------------------------------------------------------------- ficha

  fastify.post('/api/clientes', { preHandler: exigir('editar') }, async (request, reply) => {
    try {
      const cliente = await clienteService.criar(request.body, request.user);
      return { cliente: clienteService.detalhe(cliente) };
    } catch (error) {
      // 409 com o id: a tela oferece "abrir a ficha existente" em vez de
      // deixar a pessoa descobrir sozinha que o cliente ja estava cadastrado.
      const status = error.clienteId ? 409 : 400;
      return reply.code(status).send({ error: error.message, clienteId: error.clienteId });
    }
  });

  fastify.get('/api/clientes/:id', async (request, reply) => {
    const cliente = await clienteService.porId(request.params.id).catch(() => null);
    if (!cliente) return naoEncontrado(reply);

    const [tarefas, eventos, desatualizado] = await Promise.all([
      tarefaService.doCliente(cliente._id),
      timeline.listar(cliente._id, { limite: 60 }),
      ia.estaDesatualizado(cliente),
    ]);

    return {
      cliente: clienteService.detalhe(cliente),
      tarefas,
      timeline: eventos,
      resumoDesatualizado: desatualizado,
      perguntasSugeridas: ia.PERGUNTAS_SUGERIDAS,
    };
  });

  fastify.patch('/api/clientes/:id', { preHandler: exigir('editar') }, async (request, reply) => {
    try {
      const cliente = await clienteService.atualizar(request.params.id, request.body, request.user);
      if (!cliente) return naoEncontrado(reply);
      return { cliente: clienteService.detalhe(cliente) };
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  fastify.delete(
    '/api/clientes/:id',
    { preHandler: exigir('gerenciarUsuarios') },
    async (request, reply) => {
      const removido = await clienteService.remover(request.params.id, request.user);
      if (!removido) return naoEncontrado(reply);
      return { removido: true };
    }
  );

  fastify.post('/api/clientes/:id/mover', { preHandler: exigir('editar') }, async (request, reply) => {
    try {
      const cliente = await clienteService.moverParaColuna(
        request.params.id,
        request.body?.coluna,
        request.user
      );
      if (!cliente) return naoEncontrado(reply);
      return { cliente: clienteService.resumo(cliente) };
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  // ------------------------------------------------------------- timeline

  fastify.get('/api/clientes/:id/timeline', async (request) => ({
    eventos: await timeline.listar(request.params.id, {
      limite: Number(request.query?.limite) || 80,
      tipos: request.query?.tipos ? String(request.query.tipos).split(',') : undefined,
      antesDe: request.query?.antesDe,
    }),
  }));

  /** Anotacao avulsa: entra na timeline sem mexer em campo nenhum. */
  fastify.post(
    '/api/clientes/:id/observacao',
    { preHandler: exigir('editar') },
    async (request, reply) => {
      const texto = String(request.body?.texto || '').trim().slice(0, 4000);
      if (!texto) return reply.code(400).send({ error: 'Escreva a observacao.' });

      const cliente = await Cliente.findById(request.params.id).lean();
      if (!cliente) return naoEncontrado(reply);

      const evento = await timeline.registrar({
        clienteId: cliente._id,
        tipo: timeline.TIPOS.OBSERVACAO,
        titulo: 'Observacao registrada',
        descricao: texto,
        autor: {
          tipo: 'usuario',
          id: request.user?.id,
          nome: request.user?.nome || request.user?.email,
        },
      });

      return { evento: evento && { id: evento._id.toString(), em: evento.em } };
    }
  );

  // ----------------------------------------------------------- pendencias

  fastify.post(
    '/api/clientes/:id/pendencias',
    { preHandler: exigir('editar') },
    async (request, reply) => {
      try {
        const cliente = await clienteService.adicionarPendencia(
          request.params.id,
          request.body?.texto,
          request.user
        );
        if (!cliente) return naoEncontrado(reply);
        return { cliente: clienteService.detalhe(cliente) };
      } catch (error) {
        return reply.code(400).send({ error: error.message });
      }
    }
  );

  fastify.post(
    '/api/clientes/:id/pendencias/:pendenciaId/resolver',
    { preHandler: exigir('editar') },
    async (request, reply) => {
      const cliente = await clienteService.resolverPendencia(
        request.params.id,
        request.params.pendenciaId,
        request.user
      );
      if (!cliente) return naoEncontrado(reply);
      return { cliente: clienteService.detalhe(cliente) };
    }
  );

  // -------------------------------------------------------------- tarefas

  fastify.post('/api/clientes/:id/tarefas', { preHandler: exigir('editar') }, async (request, reply) => {
    try {
      const tarefa = await tarefaService.criar(
        { ...request.body, clienteId: request.params.id },
        request.user
      );
      return { tarefa };
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  fastify.patch(
    '/api/clientes/tarefas/:tarefaId',
    { preHandler: exigir('editar') },
    async (request, reply) => {
      const tarefa = await tarefaService.atualizar(request.params.tarefaId, request.body, request.user);
      if (!tarefa) return reply.code(404).send({ error: 'Tarefa nao encontrada' });
      return { tarefa };
    }
  );

  fastify.delete(
    '/api/clientes/tarefas/:tarefaId',
    { preHandler: exigir('editar') },
    async (request, reply) => {
      const removida = await tarefaService.remover(request.params.tarefaId);
      if (!removida) return reply.code(404).send({ error: 'Tarefa nao encontrada' });
      return { removida: true };
    }
  );

  // ------------------------------------------------------------------- IA

  fastify.post('/api/clientes/:id/resumo', { preHandler: exigir('testar') }, async (request, reply) => {
    const resultado = await ia.gerarResumo(request.params.id, {
      forcar: request.body?.forcar === true,
      usuario: request.user,
    });

    if (!resultado) return naoEncontrado(reply);
    if (resultado.erro) return reply.code(502).send({ error: resultado.erro });
    return resultado;
  });

  fastify.post(
    '/api/clientes/:id/assistente',
    { preHandler: exigir('testar') },
    async (request, reply) => {
      const resultado = await ia.perguntar(request.params.id, request.body?.pergunta, request.user);
      if (resultado.erro) return reply.code(400).send({ error: resultado.erro });
      return resultado;
    }
  );

  fastify.post('/api/clientes/:id/sugestoes', { preHandler: exigir('testar') }, async (request, reply) => {
    const resultado = await ia.sugerir(request.params.id, request.user);
    if (resultado.erro) return reply.code(400).send({ error: resultado.erro });
    return resultado;
  });

  /**
   * Aplica as sugestoes que o colaborador aceitou.
   *
   * Vem uma lista de campos, nao "aplique tudo": a pessoa marca o que
   * concorda. O caminho passa pelo `atualizar` normal, entao cada campo
   * aceito vira linha na timeline como qualquer edicao.
   */
  fastify.post(
    '/api/clientes/:id/sugestoes/aplicar',
    { preHandler: exigir('editar') },
    async (request, reply) => {
      const aceitas = Array.isArray(request.body?.sugestoes) ? request.body.sugestoes : [];
      if (!aceitas.length) return reply.code(400).send({ error: 'Nenhuma sugestao selecionada.' });

      const mudancas = {};
      let pendencia = null;

      for (const sugestao of aceitas) {
        if (sugestao?.campo === 'pendencia') pendencia = sugestao.valor;
        else if (sugestao?.campo) mudancas[sugestao.campo] = sugestao.valor;
      }

      try {
        if (pendencia) {
          await clienteService.adicionarPendencia(request.params.id, pendencia, request.user);
        }

        const cliente = Object.keys(mudancas).length
          ? await clienteService.atualizar(request.params.id, mudancas, request.user)
          : await clienteService.porId(request.params.id);

        if (!cliente) return naoEncontrado(reply);
        return { cliente: clienteService.detalhe(cliente) };
      } catch (error) {
        return reply.code(400).send({ error: error.message });
      }
    }
  );
}

module.exports = clientesRoutes;
