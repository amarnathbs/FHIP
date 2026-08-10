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
export const metadata: Metadata = {
  title: 'FHIP | Understand Your Financial Health and Plan What Comes Next',
  description:
    'See income, expenses, assets, debts, investments, insurance and goals in one clear financial health view. Start free and upgrade for deeper forecasts, scenarios and reports.',
  openGraph: {
    title: 'See your complete financial health — and what to do next',
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
