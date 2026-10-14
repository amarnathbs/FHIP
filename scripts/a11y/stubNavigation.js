// Stand-in for next/navigation in the accessibility harness (path comes from window.__HARNESS__.path).
export const usePathname = () => (typeof window !== 'undefined' && window.__HARNESS__ && window.__HARNESS__.path) || '/profile';
export const useRouter = () => ({ push() {}, refresh() {}, replace() {}, back() {} });
export const useSearchParams = () => new URLSearchParams();
export const redirect = () => {};
export const notFound = () => {};
