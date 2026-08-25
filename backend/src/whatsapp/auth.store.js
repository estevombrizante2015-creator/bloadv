const fs = require('fs');
const path = require('path');
const baileys = require('@whiskeysockets/baileys');

const { WaSession } = require('../models');
const { env } = require('../config/env');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');

const { initAuthCreds, BufferJSON, proto } = baileys;

/**
 * ESTADO DE AUTENTICACAO DO WHATSAPP, NO BANCO
 * --------------------------------------------
 * Substitui o `useMultiFileAuthState` do Baileys, que grava em arquivos.
 *
 * O contrato e o mesmo — `{ state: { creds, keys }, saveCreds }` — entao o
 * manager nao sabe a diferenca. O que muda e onde o material fica: em vez de
 * `backend/sessions/<canal>/`, na colecao `wasessions`.
 *
 * A leitura de chaves e em LOTE. A versao em arquivos abre um arquivo por
 * chave; aqui uma consulta traz todas as que o Signal pediu de uma vez. Numa
 * conversa em grupo isso e a diferenca entre uma ida ao banco e trinta.
 *
 * NENHUM MUTEX. A versao em arquivos precisa de trava porque duas escritas
 * concorrentes no mesmo arquivo se corrompem. Aqui cada chave e um documento e
 * o `updateOne` com upsert ja e atomico.
 */

/**
 * Canais que possuem credenciais. Mantido em memoria porque `publicState` e
 * sincrono e roda a cada atualizacao enviada ao painel — consultar o banco ali
 * transformaria uma projecao em uma operacao de I/O.
 */
const comCredenciais = new Set();

const temCredenciais = (channelId) => comCredenciais.has(channelId);

/** Recarrega o conjunto a partir do banco. Roda uma vez, no boot. */
async function carregar() {
  try {
    const canais = await WaSession.distinct('channelId', { chave: 'creds' });
    comCredenciais.clear();
    for (const id of canais) comCredenciais.add(id);
  } catch (error) {
    logger.warn({ err: error.message }, 'Falha ao listar credenciais de WhatsApp');
  }
  return [...comCredenciais];
}

// ------------------------------------------------------------------ acesso

const ler = async (channelId, chave) => {
  const doc = await WaSession.findOne({ channelId, chave }).lean();
  if (!doc) return null;

  try {
    return JSON.parse(doc.dados, BufferJSON.reviver);
  } catch (error) {
    // Documento corrompido e pior que documento ausente: devolver lixo ao
    // Signal derruba a sessao de um jeito que nao se explica pelo log.
    logger.warn({ channelId, chave, err: error.message }, 'Credencial ilegivel; tratando como ausente');
    return null;
  }
};

const escrever = (channelId, chave, valor) =>
  WaSession.updateOne(
    { channelId, chave },
    { $set: { dados: JSON.stringify(valor, BufferJSON.replacer), atualizadoEm: new Date() } },
    { upsert: true }
  );

const remover = (channelId, chave) => WaSession.deleteOne({ channelId, chave });

/** Apaga tudo de um canal. Usado no logout de verdade. */
async function apagar(channelId) {
  const { deletedCount } = await WaSession.deleteMany({ channelId });
  comCredenciais.delete(channelId);
  logger.info({ channelId, documentos: deletedCount }, 'Credenciais de WhatsApp apagadas');
  return deletedCount;
}

// -------------------------------------------------------------- migracao

/**
 * Traz para o banco as credenciais que ainda estao em arquivo.
 *
 * Existe para que quem ja tinha um pareamento funcionando NAO precise ler o QR
 * de novo por causa desta mudanca. Roda uma vez por canal: se o banco ja tem
 * `creds`, nao toca em nada.
 */
async function migrarDoDisco(channelId) {
  const dir = path.join(env.wa.sessionsDir, channelId);
  const arquivoCreds = path.join(dir, 'creds.json');

  if (!fs.existsSync(arquivoCreds)) return 0;
  if (await WaSession.exists({ channelId, chave: 'creds' })) return 0;

  let migrados = 0;
  try {
    const arquivos = await fs.promises.readdir(dir);

    for (const arquivo of arquivos) {
      if (!arquivo.endsWith('.json')) continue;

      const texto = await fs.promises.readFile(path.join(dir, arquivo), 'utf-8');
      // A chave e o nome do arquivo sem ".json" — a mesma convencao do Baileys.
      const chave = arquivo.replace(/\.json$/, '');

      // Grava o texto como esta: ele ja veio serializado por BufferJSON.
      await WaSession.updateOne(
        { channelId, chave },
        { $set: { dados: texto, atualizadoEm: new Date() } },
        { upsert: true }
      );
      migrados += 1;
    }

    comCredenciais.add(channelId);
    logger.info(
      { ev: EV.WA_CREDENCIAIS_MIGRADAS, channelId, documentos: migrados },
      'Credenciais de WhatsApp migradas do disco para o banco'
    );
  } catch (error) {
    logger.warn({ err: error.message, channelId }, 'Falha ao migrar credenciais do disco');
  }

  return migrados;
}

// ------------------------------------------------------------ estado

/**
 * Monta o estado de autenticacao de um canal.
 *
 * Mesmo contrato de `useMultiFileAuthState`, para o manager nao mudar.
 * @returns {{state: {creds: object, keys: object}, saveCreds: Function}}
 */
async function useMongoAuthState(channelId) {
  await migrarDoDisco(channelId);

  const creds = (await ler(channelId, 'creds')) || initAuthCreds();

  const salvarCreds = async () => {
    await escrever(channelId, 'creds', creds);
    comCredenciais.add(channelId);
  };

  return {
    state: {
      creds,
      keys: {
        get: async (tipo, ids) => {
          if (!ids.length) return {};

          const chaves = ids.map((id) => `${tipo}-${id}`);
          const docs = await WaSession.find({ channelId, chave: { $in: chaves } }).lean();

          const porChave = new Map(docs.map((d) => [d.chave, d.dados]));
          const saida = {};

          for (const id of ids) {
            const texto = porChave.get(`${tipo}-${id}`);
            if (!texto) continue;

            try {
              let valor = JSON.parse(texto, BufferJSON.reviver);
              // O Baileys exige este tipo reconstruido; um objeto simples aqui
              // quebra a sincronizacao de estado do aplicativo.
              if (tipo === 'app-state-sync-key' && valor) {
                valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
              }
              saida[id] = valor;
            } catch (error) {
              logger.warn({ channelId, tipo, err: error.message }, 'Chave do Signal ilegivel');
            }
          }

          return saida;
        },

        set: async (dados) => {
          const operacoes = [];

          for (const categoria in dados) {
            for (const id in dados[categoria]) {
              const valor = dados[categoria][id];
              const chave = `${categoria}-${id}`;

              // Valor nulo significa "esqueca esta chave" — e o Signal usa isso
              // para descartar sessoes antigas. Gravar null no lugar de apagar
              // faria a colecao crescer para sempre.
              operacoes.push(
                valor
                  ? {
                      updateOne: {
                        filter: { channelId, chave },
                        update: {
                          $set: {
                            dados: JSON.stringify(valor, BufferJSON.replacer),
                            atualizadoEm: new Date(),
                          },
                        },
                        upsert: true,
                      },
                    }
                  : { deleteOne: { filter: { channelId, chave } } }
              );
            }
          }

          if (operacoes.length) await WaSession.bulkWrite(operacoes, { ordered: false });
        },
      },
    },

    saveCreds: salvarCreds,
  };
}

module.exports = {
  useMongoAuthState,
  carregar,
  temCredenciais,
  apagar,
  migrarDoDisco,
  // exportados para teste
  ler,
  escrever,
  remover,
};
