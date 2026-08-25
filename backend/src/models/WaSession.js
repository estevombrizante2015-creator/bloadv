const mongoose = require('mongoose');

/**
 * CREDENCIAIS DO WHATSAPP
 * -----------------------
 * O que o Baileys guardava em arquivos dentro de `backend/sessions/`.
 *
 * POR QUE SAIU DO DISCO. Container nao tem disco. Cada deploy, cada restart e
 * cada troca de maquina comeca com o sistema de arquivos zerado — e ai o
 * pareamento se perde e o escritorio precisa ler o QR de novo em cada numero.
 * A solucao anterior era um volume montado em `/app/sessions`: funciona, mas
 * depende de alguem lembrar de configurar, e o sintoma de esquecer aparece
 * dias depois, na forma de "o WhatsApp caiu outra vez".
 *
 * O banco ja e obrigatorio, ja e duravel e ja tem backup. Guardar aqui elimina
 * a dependencia de infraestrutura em vez de documenta-la.
 *
 * SEGURANCA. Isto e material sigiloso de verdade: quem tem estes documentos
 * assume a conta de WhatsApp do escritorio e le as conversas dos clientes.
 * Valem para o banco os mesmos cuidados que valiam para a pasta — acesso
 * restrito, e nunca em um banco compartilhado com terceiros.
 *
 * FORMA. `dados` e uma STRING JSON, nao um objeto. Duas razoes:
 *   - as chaves do Signal contem `.` e `:`, que o Mongo trata como caminho;
 *   - o Baileys serializa Buffers com um formato proprio (`BufferJSON`), e
 *     guardar o texto exato garante que o que volta e byte a byte o que entrou.
 */
const WaSessionSchema = new mongoose.Schema(
  {
    /** Canal ao qual a credencial pertence (leads-1, leads-2, clients-1). */
    channelId: { type: String, required: true, index: true },

    /** `creds` para o documento principal; `<tipo>-<id>` para as chaves do Signal. */
    chave: { type: String, required: true },

    dados: { type: String, required: true },

    atualizadoEm: { type: Date, default: Date.now },
  },
  { timestamps: false, minimize: false }
);

// A leitura e sempre por (canal, chave), e a gravacao e um upsert nessa dupla.
WaSessionSchema.index({ channelId: 1, chave: 1 }, { unique: true });

module.exports = mongoose.model('WaSession', WaSessionSchema);
