import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * Em desenvolvimento o Next so aceita requisicoes ao HMR vindas de localhost.
   * O IP da rede local (o Wi-Fi/LAN da maquina) precisa ser declarado para que
   * o painel possa ser aberto de outro aparelho - util para ler o QR do
   * WhatsApp direto do celular, sem espelhar tela.
   *
   * Vale apenas em `next dev`; nao afeta o build de producao.
   */
  allowedDevOrigins: ['192.168.208.1'],
};

export default nextConfig;
