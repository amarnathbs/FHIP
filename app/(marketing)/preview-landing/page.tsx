import type { Metadata } from 'next';
import { Inter, Newsreader } from 'next/font/google';
import PreviewLandingPage from '@/components/marketing/PreviewLandingPage';

// Self-hosted via next/font (no external requests at runtime, no CDN/CSP
// concerns — unlike the standalone Artifact version of this page, which had
// to embed fonts as base64 data URIs to work around the Artifact sandbox's
// CSP blocking font CDNs).
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-inter',
  display: 'swap',
});
const newsreader = Newsreader({
  subsets: ['latin'],
  weight: ['600', '700'],
  style: ['normal'],
  variable: '--font-newsreader',
  display: 'swap',
});
const newsreaderItalic = Newsreader({
  subsets: ['latin'],
  weight: ['500'],
  style: ['italic'],
  variable: '--font-newsreader-italic',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'FHIP — See your complete financial health, and what to do next (design preview)',
  description:
    'Staged design preview of the FHIP public landing page (Option 1 hybrid). Not the live public site — pricing and legal copy are placeholders pending approval.',
  robots: { index: false, follow: false },
};

export default function PreviewLandingRoute() {
  return (
    <div className={`${inter.variable} ${newsreader.variable} ${newsreaderItalic.variable}`}>
      <PreviewLandingPage />
    </div>
  );
}
