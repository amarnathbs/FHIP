import type { Metadata } from 'next';
import { Inter, Newsreader } from 'next/font/google';
import LandingPage from '@/components/marketing/LandingPage';

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

// SEO title/description per the reviewed FHIP_Landing_Page_Design_Options_Review_Pack.docx
// (section 16.1, "Search and social preview recommendations").
//
// myfhip.com short-brand update: the browser/share title is now the short
// "FHIP | Financial Health" form (was the long descriptive title). The
// original longer value proposition is preserved in `description` and in
// the landing page's own hero copy — only the title/share-card headline
// shortened, per the approved branding update.
export const metadata: Metadata = {
  title: 'FHIP | Financial Health',
  description:
    'See income, expenses, assets, debts, investments, insurance and goals in one clear financial health view. Start free and upgrade for deeper forecasts, scenarios and reports.',
  openGraph: {
    title: 'FHIP | Financial Health',
    description: 'A clear view of today’s financial position, priority actions and possible future paths.',
    siteName: 'FHIP',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FHIP | Financial Health',
    description: 'A clear view of today’s financial position, priority actions and possible future paths.',
  },
};

export default function LandingRoute() {
  return (
    <div className={`${inter.variable} ${newsreader.variable} ${newsreaderItalic.variable}`}>
      <LandingPage />
    </div>
  );
}
