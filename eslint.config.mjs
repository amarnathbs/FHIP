// Next.js 16 dropped `next lint` and its ESLint integration entirely, so
// this project now runs ESLint directly (see package.json's "lint" script).
// eslint-config-next now ships its shareable configs as plain flat-config
// arrays (eslint-config-next/core-web-vitals, eslint-config-next/typescript)
// rather than the legacy string-based "next/core-web-vitals" names, so no
// FlatCompat bridge is needed — that bridge (via @eslint/eslintrc) is what
// broke under ESLint 10's minimatch dependency.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript];

export default eslintConfig;
