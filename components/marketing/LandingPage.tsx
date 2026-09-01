'use client';

// FHIP public landing page (Option 1 "Financial Health Discovery" hybrid,
// per `FHIP_Landing_Page_Design_Options_Review_Pack.docx`). Promoted to the
// live "/" root on 2026-08-10 after review — see app/(marketing)/page.tsx.
// Originally staged at /preview-landing for review; that route has been
// removed now that this is the canonical public page. Pricing shown here is
// still an indicative figure pending final commercial approval (the page's
// own copy says so in the pricing section) — only the wording/legal review
// gate has been cleared, not final pricing.
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import styles from './LandingPage.module.css';
import { CountrySelector } from './CountrySelector';
import { getLandingMarketingPrice } from '@/lib/config/landingPricing';
import type { LandingCountryContext } from '@/lib/services/landingCountryContext';

// G2 — Landing-Page Localisation (spec sections 9-10). `countryContext` is
// null whenever the G2 feature flag is disabled (see
// app/(marketing)/page.tsx) — every branch below falls back to the exact
// pre-G2 behaviour (static AU pricing, no selector) in that case, so
// disabling the flag restores the original experience with no code change
// needed here.
export interface LandingPageProps {
  countryContext?: LandingCountryContext | null;
}

const BASE_ALT_POINTS: [number, number][] = [
  [0, 175],
  [90, 155],
  [180, 132],
  [270, 105],
  [360, 72],
  [450, 45],
  [520, 20],
];

function useRevealOnScroll() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const revealEls = Array.from(container.querySelectorAll<HTMLElement>(`.${styles.reveal}`));
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduceMotion || !('IntersectionObserver' in window)) {
      revealEls.forEach((el) => el.classList.add(styles.in));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add(styles.in);
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    revealEls.forEach((el) => io.observe(el));

    // Safety net: an element that never crosses the observer threshold (an
    // instant programmatic scroll/anchor jump that skips frames, etc.) must
    // still become visible — content should never be permanently stuck at
    // opacity:0.
    const fallback = window.setTimeout(() => {
      revealEls.forEach((el) => el.classList.add(styles.in));
    }, 2200);

    return () => {
      io.disconnect();
      window.clearTimeout(fallback);
    };
  }, []);

  return containerRef;
}

function useCompactHeader() {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const onScroll = () => setCompact(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return compact;
}

function ForecastSlider() {
  const [contribution, setContribution] = useState(0);

  const { altPoints, outcomeText } = useMemo(() => {
    const boost = (contribution / 800) * 55;
    const pts = BASE_ALT_POINTS.map(([x, y], i) => {
      const factor = i / (BASE_ALT_POINTS.length - 1);
      return [x, Math.max(8, y - boost * factor)] as [number, number];
    });
    const text =
      contribution === 0 ? (
        <>At today&rsquo;s contribution, the alternative path matches the baseline. Move the slider to see how extra saving may shift your 10&#8209;year position.</>
      ) : (
        <>
          An extra <b>${contribution.toLocaleString('en-AU')}/mo</b>{' '}may improve your projected 10&#8209;year net worth by roughly{' '}
          <b>${Math.round((contribution * 12 * 8) / 1000)}k</b>, based on your recorded assumptions. Illustrative only &mdash; not a guarantee.
        </>
      );
    return { altPoints: pts, outcomeText: text };
  }, [contribution]);

  const altPolylinePoints = altPoints.map(([x, y]) => `${x},${y.toFixed(1)}`).join(' ');
  const altEnd = altPoints[altPoints.length - 1];

  return (
    <div className={styles.forecastPanel}>
      <div>
        <svg
          viewBox="0 0 520 220"
          role="img"
          aria-labelledby="fcTitle fcDesc"
          style={{ width: '100%', height: 'auto' }}
        >
          <title id="fcTitle">Projected net worth, baseline vs alternative</title>
          <desc id="fcDesc">Baseline path grows steadily; the alternative path grows faster as monthly contribution increases.</desc>
          <line x1="0" y1="190" x2="520" y2="190" stroke="var(--line)" strokeWidth="1" />
          <line x1="0" y1="130" x2="520" y2="130" stroke="var(--line)" strokeWidth="1" strokeDasharray="2 4" />
          <line x1="0" y1="70" x2="520" y2="70" stroke="var(--line)" strokeWidth="1" strokeDasharray="2 4" />
          <polyline
            points="0,175 90,160 180,148 270,132 360,112 450,95 520,80"
            fill="none"
            stroke="var(--muted)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <polyline
            points={altPolylinePoints}
            fill="none"
            stroke="var(--purple)"
            strokeWidth="2.5"
            strokeDasharray="6 5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="520" cy={altEnd[1].toFixed(1)} r="4.5" fill="var(--purple)" />
          <text x="4" y="185" fontFamily="var(--font-inter), sans-serif" fontSize="10" fill="var(--muted)">
            Today
          </text>
          <text x="480" y="16" fontFamily="var(--font-inter), sans-serif" fontSize="10" fill="var(--muted)">
            In 10 yrs
          </text>
        </svg>
        <div className={styles.chartLegend}>
          <div className={styles.legendItem}>
            <span className={`${styles.legendSwatch} ${styles.legendBaseline}`} />
            Baseline (current plan)
          </div>
          <div className={styles.legendItem}>
            <span className={`${styles.legendSwatch} ${styles.legendAlt}`} />
            Alternative (adjusted contribution)
          </div>
        </div>
        <p className={styles.assumptionsNote}>
          Projected using your recorded balances, an assumed annual return and the contribution set by the slider.{' '}
          <a href="#" style={{ color: 'var(--purple)', fontWeight: 600 }}>
            View assumptions
          </a>
        </p>
      </div>

      <div className={styles.sliderBlock}>
        <div>
          <div className={styles.sliderLabel}>
            Extra monthly contribution{' '}
            <span className={`${styles.val} ${styles.tabular}`}>${contribution.toLocaleString('en-AU')}</span>
          </div>
          <input
            type="range"
            className={styles.range}
            min={0}
            max={800}
            step={50}
            value={contribution}
            aria-describedby="sliderOutcome"
            onChange={(e) => setContribution(Number(e.target.value))}
          />
        </div>
        <p className={styles.sliderOutcome} id="sliderOutcome">
          {outcomeText}
        </p>
        <a href="#" className={styles.btnGhost + ' ' + styles.btn}>
          Explore Premium forecasting
        </a>
      </div>
    </div>
  );
}

// G2: `pricingRegion` is undefined/omitted (flag disabled) => the exact
// original AU-only static markup, byte-for-byte. When the flag is enabled,
// an AU/IN pricingRegion shows that market's PO-approved price
// (lib/config/landingPricing.ts — the single controlled source, spec
// section 10); GENERIC/UNAVAILABLE never invents a price for an
// unsupported currency (spec section 9: "do not invent GBP/USD/SGD/AED
// subscription prices") and instead prompts the visitor to pick a country.
function PricingCards({ pricingRegion }: { pricingRegion?: 'AU' | 'IN' | 'GENERIC' | 'UNAVAILABLE' }) {
  const [annual, setAnnual] = useState(false);
  const price = pricingRegion === undefined ? getLandingMarketingPrice('AU') : getLandingMarketingPrice(pricingRegion);

  return (
    <>
      <div className={styles.pricingToggle} role="group" aria-label="Billing period">
        <button type="button" aria-pressed={!annual} onClick={() => setAnnual(false)}>
          Monthly
        </button>
        <button type="button" aria-pressed={annual} onClick={() => setAnnual(true)}>
          Annual <span className={styles.saveTag}>Save 17%</span>
        </button>
      </div>

      <div className={styles.pricingGrid} style={{ textAlign: 'left' }}>
        <div className={styles.priceCard}>
          <h3>Free</h3>
          <p className={styles.promise}>Understand where you stand.</p>
          <div className={`${styles.amount} ${styles.tabular}`}>$0</div>
          <p className={styles.billingNote}>No payment required.</p>
          <ul>
            <li>Financial health snapshot</li>
            <li>Core income, expense, asset &amp; debt views</li>
            <li>Basic goals &amp; priority actions</li>
            <li>Standard monthly report</li>
          </ul>
          <Link href="/signup" className={`${styles.btn} ${styles.btnGhost}`}>
            Start free
          </Link>
        </div>
        <div className={`${styles.priceCard} ${styles.priceCardFeatured}`}>
          <span className={styles.featuredBadge}>Recommended</span>
          <h3>Premium</h3>
          <p className={styles.promise}>Plan, compare and improve.</p>
          {price ? (
            <>
              <div className={`${styles.amount} ${styles.tabular}`}>
                {annual ? (
                  <>
                    {price.symbol}
                    {price.annual}
                    <span>/yr</span>
                  </>
                ) : (
                  <>
                    {price.symbol}
                    {price.monthly}
                    <span>/mo</span>
                  </>
                )}
              </div>
              <p className={styles.billingNote}>
                {annual
                  ? `Equivalent to ${price.symbol}${price.annualEquivalentMonthly}/mo, billed annually.`
                  : 'Billed monthly. Cancel anytime.'}
              </p>
            </>
          ) : (
            <>
              <div className={`${styles.amount} ${styles.tabular}`} style={{ fontSize: '1.1rem' }}>
                Pricing varies by country
              </div>
              <p className={styles.billingNote}>Choose your country above to see Premium pricing for your region.</p>
            </>
          )}
          <ul>
            <li>Full score &amp; component explanations</li>
            <li>Forecasts &amp; scenario comparison</li>
            <li>AI&#8209;supported explanations</li>
            <li>Premium report, history &amp; variance</li>
            <li>Cross&#8209;border &amp; currency insight</li>
          </ul>
          <Link href="/signup" className={`${styles.btn} ${styles.btnPrimary}`}>
            Explore Premium
          </Link>
        </div>
      </div>
      <p className={styles.assumptionsNote} style={{ marginTop: '1rem' }}>
        Pricing shown is marketing information for your selected country and is not a live checkout price &mdash;
        online payment is not yet available. Start free today; billing eligibility is always confirmed separately
        before any charge.
      </p>
    </>
  );
}

// G2: derives the country-varying FAQ answer for "Does FHIP work in my
// country?" from experienceLevel/pricingRegion rather than ever claiming
// certification the G1 registry doesn't back (spec section 9: no India
// EPF/PPF/NPS/SMSF-equivalence claim, no generic-country domestic-feature
// claim, no functioning-checkout claim).
function countryFaqEntry(countryContext: LandingCountryContext | null | undefined): [string, string] {
  if (!countryContext || !countryContext.presentationCountry) {
    return [
      'Does FHIP work in my country?',
      'FHIP supports multi‑country, multi‑currency households. Choose your country above to see country‑specific examples and pricing; core financial‑health tracking is available everywhere, with additional certified local features in supported countries.',
    ];
  }
  const { presentationCountry, experienceLevel } = countryContext;
  if (presentationCountry === 'AU') {
    return [
      'Does FHIP work in Australia?',
      'Yes. Australia has FHIP’s full certified experience, including domestic retirement (SMSF) support where applicable. Pricing above is shown in AUD.',
    ];
  }
  if (presentationCountry === 'IN') {
    return [
      'Does FHIP work in India?',
      'Yes, with India‑relevant examples and pricing shown in INR. India‑specific domestic retirement products (EPF, PPF, NPS) are not yet part of FHIP’s certified calculations, and Superannuation is an Australian product, not an equivalent to any Indian retirement scheme — these remain on our roadmap.',
    ];
  }
  return [
    'Does FHIP work in my country?',
    `FHIP’s universal financial‑health tracking is available in your region, with a ${experienceLevel === 'FULL' ? 'growing' : 'generic, non‑country‑specific'} set of features. Country‑certified domestic tax, retirement or regulatory calculations are not yet available outside Australia and India, and pricing/billing for your region is not yet confirmed.`,
  ];
}

export default function PreviewLandingPage({ countryContext = null }: LandingPageProps) {
  const containerRef = useRevealOnScroll();
  const compact = useCompactHeader();
  const pricingRegion = countryContext ? countryContext.pricingRegion : undefined;
  const faqEntry = countryContext !== null ? countryFaqEntry(countryContext) : null;

  return (
    <div className={styles.page} ref={containerRef}>
      <header className={styles.siteHeader}>
        <div className={`${styles.wrap} ${styles.headerBar} ${compact ? styles.compact : ''}`}>
          <a href="#top" className={styles.logo} aria-label="FHIP home">
            <img src="/images/fhip-logo-lockup.png" alt="FHIP" className={styles.logoMark} />
            <small>Financial Health Intelligence Platform</small>
          </a>
          <nav className={styles.primaryNav} aria-label="Primary">
            <a href="#how-it-works">How it works</a>
            <a href="#features">Features</a>
            <a href="#health">Financial Health</a>
            <a href="#forecasting">Forecasting</a>
            <Link href="/resources">Resources</Link>
            <a href="#pricing">Pricing</a>
            <a href="#security">Security</a>
          </nav>
          <div className={styles.headerActions}>
            <Link href="/login" className={`${styles.btn} ${styles.btnText}`}>
              Log in
            </Link>
            <Link href="/signup" className={`${styles.btn} ${styles.btnPrimary}`}>
              Start free
            </Link>
            <button className={styles.menuToggle} aria-label="Open menu">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M2 5h14M2 9h14M2 13h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
        {countryContext && (
          // G2: deliberately its own full-width bar BELOW the primary header
          // row, not squeezed into .headerActions alongside Log in/Start
          // free/the mobile menu toggle -- that row is already width-tight
          // at mobile breakpoints (spec section 14: "no horizontal
          // overflow", "avoid cumulative layout shift"); a dedicated row
          // gives the selector room on every viewport without touching the
          // pre-existing header's own carefully-tuned responsive behaviour.
          <div className={`${styles.wrap} ${styles.countrySelectorBar}`}>
            <CountrySelector activeCountry={countryContext.presentationCountry} />
          </div>
        )}
      </header>

      <main id="top">
        {/* HERO */}
        <section className={styles.hero}>
          <div className={`${styles.wrap} ${styles.heroGrid}`}>
            <div>
              <p className={styles.eyebrow}>
                Your financial health, explained
                {countryContext?.presentationCountry === 'AU' && ' — for Australian households'}
                {countryContext?.presentationCountry === 'IN' && ' — for Indian households'}
              </p>
              <h1>See your complete financial health &mdash; and what to do next.</h1>
              <p className={styles.lede}>
                Bring income, spending, assets, debts, investments, insurance and goals into one clear view. FHIP
                explains what is strong, what needs attention and how different choices may shape your financial
                future.
              </p>
              <div className={styles.ctaRow}>
                <Link href="/signup" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnLg}`}>
                  Start free
                </Link>
                <a href="#how-it-works" className={`${styles.btn} ${styles.btnGhost} ${styles.btnLg}`}>
                  See how FHIP works
                </a>
              </div>
              <p className={styles.microcopy}>
                <span className={styles.dot}>&#9679;</span>&ensp;A useful Free plan is available. Upgrade when you
                want deeper planning, scenarios and reporting.
              </p>
            </div>

            <div>
              <div className={`${styles.previewCard} ${styles.reveal}`}>
                <div className={styles.pcHead}>
                  <span>FHIP &mdash; Your financial health today</span>
                  <span className={styles.live}>
                    <span className={styles.pip} />
                    Updated just now
                  </span>
                </div>
                <div className={styles.pcBody}>
                  <div className={styles.scorePanel}>
                    <div className={`${styles.scoreNum} ${styles.tabular}`}>
                      72<sub>/100</sub>
                    </div>
                    <div className={styles.scoreMeta}>
                      <span className={styles.scoreStatus}>Stable</span>
                      <p>Your position is stable, with strong savings but limited emergency liquidity.</p>
                    </div>
                  </div>
                  <div className={styles.vitalsGrid}>
                    <div className={styles.vital}>
                      <div className={styles.vl}>Cash flow</div>
                      <div className={`${styles.vv} ${styles.tabular}`}>$1,240</div>
                      <div className={`${styles.vs} ${styles.vsGood}`}>Healthy</div>
                    </div>
                    <div className={styles.vital}>
                      <div className={styles.vl}>Net worth</div>
                      <div className={`${styles.vv} ${styles.tabular}`}>$486k</div>
                      <div className={`${styles.vs} ${styles.vsGood}`}>Up 4.2%</div>
                    </div>
                    <div className={styles.vital}>
                      <div className={styles.vl}>Emergency fund</div>
                      <div className={`${styles.vv} ${styles.tabular}`}>2.8 mo</div>
                      <div className={`${styles.vs} ${styles.vsWarn}`}>Review</div>
                    </div>
                  </div>
                  <div className={styles.actionCallout}>
                    <div className={styles.al}>Priority action</div>
                    <div className={styles.at}>Build your emergency buffer to four months.</div>
                    <div className={styles.ai}>Estimated impact: +8 score points</div>
                  </div>
                </div>
              </div>
              <p className={styles.previewCaption}>Example household &mdash; illustrative preview, not your personal data.</p>
            </div>
          </div>
        </section>

        {/* TRUST STRIP */}
        <section className={styles.trustStrip}>
          <div className={`${styles.wrap} ${styles.trustGrid}`}>
            <div className={styles.trustItem}>
              <div className={styles.trustIcon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M2 8l3.5 3.5L14 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div>
                <h3>Start simply</h3>
                <p>Begin with the information you have and add detail over time.</p>
              </div>
            </div>
            <div className={styles.trustItem}>
              <div className={styles.trustIcon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M8 5v3l2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </div>
              <div>
                <h3>See the source</h3>
                <p>Important results show dates, assumptions and data-confidence status.</p>
              </div>
            </div>
            <div className={styles.trustItem}>
              <div className={styles.trustIcon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M5.5 7V5a2.5 2.5 0 015 0v2" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </div>
              <div>
                <h3>Stay in control</h3>
                <p>Review, correct and remove information from your household profile.</p>
              </div>
            </div>
            <div className={styles.trustItem}>
              <div className={styles.trustIcon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M2 12.5h12M4 12.5V7.5M8 12.5V4.5M12 12.5V9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </div>
              <div>
                <h3>Clear pricing</h3>
                <p>See what is included in Free and Premium before you choose.</p>
              </div>
            </div>
          </div>
        </section>

        {/* FINANCIAL HEALTH COMPONENTS */}
        <section className={styles.block} id="health">
          <div className={styles.wrap}>
            <div className={`${styles.sectionHead} ${styles.reveal}`}>
              <p className={styles.eyebrow}>The FHIP framework</p>
              <h2>Your financial health is more than one number.</h2>
              <p className={styles.pullLine}>
                &ldquo;Every important result is paired with plain-English meaning, a status, a trend &mdash; and
                the next useful question.&rdquo;
              </p>
            </div>

            <div className={`${styles.componentsList} ${styles.reveal}`}>
              {[
                { name: 'Cash flow', color: 'var(--blue)', q: 'Is money coming in faster than it is going out?', vis: 'Income‑to‑expense waterfall' },
                { name: 'Net worth', color: 'var(--blue)', q: 'Is the household balance sheet strengthening?', vis: 'Assets, liabilities & trend' },
                { name: 'Emergency readiness', color: 'var(--teal)', q: 'How long could accessible money cover essential expenses?', vis: 'Months‑of‑runway target bar' },
                { name: 'Debt', color: 'var(--amber)', q: 'Is repayment pressure manageable?', vis: 'Debt‑service status & payoff path' },
                { name: 'Protection', color: 'var(--green)', q: 'Are important household risks sufficiently covered?', vis: 'Insurance & resilience component' },
                { name: 'Goals', color: 'var(--purple)', q: 'Are contributions and timing aligned with priorities?', vis: 'Goal path & monthly gap' },
                { name: 'Data confidence', color: 'var(--muted)', q: 'How reliable and current is this result?', vis: 'Verified / estimated / stale labels' },
              ].map((c) => (
                <div className={styles.componentRow} key={c.name}>
                  <div className={styles.cname}>
                    <span className={styles.cdot} style={{ background: c.color }} />
                    {c.name}
                  </div>
                  <div className={styles.cq}>{c.q}</div>
                  <div className={styles.cvis}>{c.vis}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ACTION LED */}
        <section className={`${styles.block} ${styles.blockTint}`}>
          <div className={styles.wrap}>
            <div className={`${styles.sectionHead} ${styles.reveal}`}>
              <p className={styles.eyebrow}>Beyond the dashboard</p>
              <h2>From financial numbers to clearer next actions.</h2>
              <p>Every FHIP result is paired with a short, ranked list of priorities &mdash; each with evidence, estimated impact and effort.</p>
            </div>

            <div className={`${styles.actionGrid} ${styles.reveal}`}>
              <div className={styles.actionCard} style={{ ['--tagColor' as string]: 'var(--red)' }}>
                <span className={styles.actionTag}>Now</span>
                <h3>Build accessible savings toward four months of essential expenses.</h3>
                <p className={styles.evidence}>
                  Evidence shown: <b>current months, target range, monthly gap</b>{' '}and data confidence.
                </p>
                <p className={styles.premiumNote}>
                  <b>Premium expands this</b>{' — '}compare contribution amounts and projected completion dates.
                </p>
              </div>
              <div className={styles.actionCard} style={{ ['--tagColor' as string]: 'var(--amber)' }}>
                <span className={styles.actionTag}>Next</span>
                <h3>Review debt with the highest repayment pressure.</h3>
                <p className={styles.evidence}>
                  Evidence shown: <b>balance, rate, repayment</b>{' '}and cash&#8209;flow effect.
                </p>
                <p className={styles.premiumNote}>
                  <b>Premium expands this</b>{' — '}model alternative repayment and investment scenarios.
                </p>
              </div>
              <div className={styles.actionCard} style={{ ['--tagColor' as string]: 'var(--muted)' }}>
                <span className={styles.actionTag}>Monitor</span>
                <h3>Check investment and currency concentration.</h3>
                <p className={styles.evidence}>
                  Evidence shown: <b>largest exposures</b>{' '}and change over time.
                </p>
                <p className={styles.premiumNote}>
                  <b>Premium expands this</b>{' — '}cross&#8209;border, scenario and recommendation impact.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* FORECASTING */}
        <section className={styles.block} id="forecasting">
          <div className={styles.wrap}>
            <div className={`${styles.sectionHead} ${styles.reveal}`}>
              <p className={styles.eyebrow}>Premium &middot; Forecasting</p>
              <h2>See where you may be heading &mdash; and what could change the path.</h2>
              <p>Explore a baseline, compare an alternative, and understand the assumptions behind the result. Forecasts are estimates, not guarantees.</p>
            </div>
            <div className={styles.reveal}>
              <ForecastSlider />
            </div>
          </div>
        </section>

        {/* ECOSYSTEM */}
        <section className={`${styles.block} ${styles.blockTint}`} id="features">
          <div className={styles.wrap}>
            <div className={`${styles.sectionHead} ${styles.reveal}`}>
              <p className={styles.eyebrow}>One connected platform</p>
              <h2>From today&rsquo;s cash flow to tomorrow&rsquo;s goals.</h2>
              <p>Every module feeds the same household picture &mdash; nothing is calculated twice, and nothing is siloed.</p>
            </div>

            <div className={`${styles.ecoGrid} ${styles.reveal}`}>
              <div className={styles.ecoCard}>
                <h3>Understand today</h3>
                <ul>
                  <li>Income, expenses, assets, liabilities</li>
                  <li>Investments &amp; insurance records</li>
                  <li>Net worth &amp; data quality</li>
                </ul>
              </div>
              <div className={styles.ecoCard}>
                <h3>Plan and improve</h3>
                <ul>
                  <li>Goals &amp; Financial Health Score</li>
                  <li>Financial DNA &amp; Resilience</li>
                  <li>Twin / Benchmark &amp; Forecasting</li>
                </ul>
              </div>
              <div className={styles.ecoCard}>
                <h3>Review and share</h3>
                <ul>
                  <li>Free &amp; Premium reports</li>
                  <li>History &amp; variance tracking</li>
                  <li>Exports &amp; household review</li>
                </ul>
              </div>
              <div className={styles.ecoCard}>
                <h3>Across borders</h3>
                <ul>
                  <li>Original &amp; reporting currency</li>
                  <li>Country &amp; FX effect</li>
                  <li>Cross&#8209;border exposure</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section className={styles.block} id="how-it-works">
          <div className={styles.wrap}>
            <div className={`${styles.sectionHead} ${styles.reveal}`}>
              <p className={styles.eyebrow}>Three steps</p>
              <h2>How it works.</h2>
            </div>
            <div className={`${styles.steps} ${styles.reveal}`}>
              <div className={styles.step}>
                <div className={styles.stepNum}>1</div>
                <h3>Build your picture</h3>
                <p>Add essential household information first. Expand into investments, insurance, goals and cross&#8209;border detail when relevant.</p>
              </div>
              <div className={styles.step}>
                <div className={styles.stepNum}>2</div>
                <h3>Understand the result</h3>
                <p>Review the score, component explanations, strengths, attention areas and data&#8209;confidence status.</p>
              </div>
              <div className={styles.step}>
                <div className={styles.stepNum}>3</div>
                <h3>Plan and review</h3>
                <p>Explore actions and scenarios, then return over time to compare progress with your previous position and plan.</p>
              </div>
            </div>
          </div>
        </section>

        {/* PRICING */}
        <section className={`${styles.block} ${styles.blockTint}`} id="pricing">
          <div className={styles.wrap} style={{ textAlign: 'center' }}>
            <div className={`${styles.sectionHead} ${styles.reveal}`} style={{ marginLeft: 'auto', marginRight: 'auto' }}>
              <p className={styles.eyebrow} style={{ textAlign: 'center' }}>
                Free and Premium
              </p>
              <h2>Start with clarity. Upgrade when you want deeper planning.</h2>
            </div>
            <div className={styles.reveal}>
              <PricingCards pricingRegion={pricingRegion} />
            </div>
          </div>
        </section>

        {/* SECURITY */}
        <section className={styles.block} id="security">
          <div className={styles.wrap}>
            <div className={`${styles.sectionHead} ${styles.reveal}`}>
              <p className={styles.eyebrow}>Security &amp; trust</p>
              <h2>Your data, explained and controlled.</h2>
            </div>
            <div className={`${styles.securityGrid} ${styles.reveal}`}>
              {[
                ['Data control', 'You can review, update and remove information in your account at any time.'],
                ['Connection status', 'Connected data shows its source and last‑refresh status — never presented as more current than it is.'],
                ['Authentication', 'Accounts use secure, modern authentication controls.'],
                ['Privacy', 'Your financial information is used to provide your experience — not to build an advertising profile.'],
                ['AI transparency', 'FHIP tells you when content is AI‑generated and when a figure is a deterministic calculation.'],
              ].map(([h, p]) => (
                <div className={styles.securityRow} key={h}>
                  <h3>{h}</h3>
                  <p>{p}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className={`${styles.block} ${styles.blockTint}`}>
          <div className={styles.wrap}>
            <div className={`${styles.sectionHead} ${styles.reveal}`}>
              <p className={styles.eyebrow}>Questions</p>
              <h2>Frequently asked.</h2>
            </div>
            <div className={`${styles.faqList} ${styles.reveal}`}>
              {[
                ['Is FHIP a financial adviser?', 'No. FHIP is a financial intelligence and planning tool. It provides financial‑health information, explanations and deterministic projections — not personalised financial, tax or legal advice.'],
                ['What happens to my financial data?', 'Your data is used to build your household picture and calculate your results. It is not sold, and it is not used to build an advertising profile. You can review, correct or remove it at any time.'],
                ['Are the forecasts guaranteed?', 'No. Forecasts are estimates based on the information you provide and the assumptions shown alongside each result. They are clearly labelled as projections, not promises.'],
                ['Can I cancel Premium at any time?', 'Yes. You can manage or cancel your plan from your account at any time — your Free plan remains available afterwards.'],
                faqEntry ?? ['Does FHIP work outside Australia?', 'FHIP supports multi‑country, multi‑currency households, with cross‑border exposure and FX effects shown alongside your results.'],
              ].map(([q, a]) => (
                <details className={styles.faqItem} key={q}>
                  <summary>
                    {q}
                    <span className={styles.chev} aria-hidden="true">
                      &#9662;
                    </span>
                  </summary>
                  <div className={styles.faqBody}>{a}</div>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* FINAL CTA */}
        <section className={`${styles.block} ${styles.finalCta}`}>
          <div className={styles.wrap} style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '2rem' }}>
            <div>
              <p className={`${styles.eyebrow} ${styles.eyebrowOnDark}`}>Get started</p>
              <h2>
                Your financial situation is already connected.
                <br />
                See it more clearly.
              </h2>
              <p>Start with a free financial health view and add deeper planning only when it becomes useful.</p>
            </div>
            <div className={styles.ctaRow} style={{ marginTop: 0 }}>
              <Link href="/signup" className={`${styles.btn} ${styles.btnOnNavy} ${styles.btnLg}`}>
                Start free
              </Link>
              <Link href="/login" className={`${styles.btn} ${styles.btnOutlineOnNavy} ${styles.btnLg}`}>
                Log in
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className={styles.siteFooter}>
        <div className={`${styles.wrap} ${styles.footerGrid}`}>
          <div>
            <div className={styles.footerBrand}>FHIP</div>
            <p>Financial Health Intelligence Platform &mdash; a clearer view of your household&rsquo;s present position and future path.</p>
          </div>
          <div>
            <h4>Product</h4>
            <ul>
              <li><a href="#features">Features</a></li>
              <li><a href="#health">Financial Health</a></li>
              <li><a href="#forecasting">Forecasting</a></li>
              <li><a href="#pricing">Pricing</a></li>
            </ul>
          </div>
          <div>
            <h4>Company</h4>
            <ul>
              <li><Link href="/about">About</Link></li>
              <li><Link href="/security">Security &amp; Trust</Link></li>
              <li><Link href="/resources">Resources</Link></li>
              <li><Link href="/contact">Contact</Link></li>
            </ul>
          </div>
          <div>
            <h4>Legal</h4>
            <ul>
              <li><a href="/privacy">Privacy</a></li>
              <li><a href="/terms">Terms</a></li>
              <li><a href="#">Disclaimer</a></li>
              <li><a href="#">Accessibility</a></li>
            </ul>
          </div>
        </div>
        <div className={`${styles.wrap} ${styles.footerBottom}`}>
          <span>&copy; 2026 Financial Health Intelligence Platform. Forecasts are estimates, not guarantees. Not personal financial advice.</span>
          <span>Sydney, Australia</span>
        </div>
      </footer>
    </div>
  );
}
