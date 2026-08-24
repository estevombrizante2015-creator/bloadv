import type { Metadata } from 'next';
import { Cinzel, Inter } from 'next/font/google';
import './globals.css';

/** Serif com caixa-alta gravada: e o registro tipografico da marca. */
const cinzel = Cinzel({
  variable: '--font-cinzel',
  subsets: ['latin'],
  weight: ['400', '600', '700'],
  display: 'swap',
});

/** Sans para interface: legivel em tamanho pequeno e com tabular-nums. */
const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'whatsAgent — Barbosa, Loli e Oliveira',
  description: 'Painel de atendimento por WhatsApp da Barbosa, Loli e Oliveira Sociedade de Advogados',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" className={`${cinzel.variable} ${inter.variable} h-full`}>
      <body className="min-h-full bg-navy-950 text-cream antialiased">{children}</body>
    </html>
  );
}
