import { AnchorHTMLAttributes, ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

interface RouterValue {
  path: string;
  navigate(to: string): void;
}

const RouterContext = createContext<RouterValue>({ path: '/', navigate: () => {} });

const normalize = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p) || '/';

let guard: (() => string | null) | null = null;

/** Lets a page ask for confirmation before in-app navigation leaves it (unsaved work). */
export function setNavigationGuard(fn: (() => string | null) | null): void {
  guard = fn;
}

/** Minimal history-API router: the site has a handful of static routes. */
export function Router({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => normalize(window.location.pathname));
  useEffect(() => {
    const onPop = () => setPath(normalize(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    if (normalize(to) !== normalize(window.location.pathname)) {
      const question = guard?.();
      if (question && !window.confirm(question)) return;
      window.history.pushState({}, '', to);
    }
    setPath(normalize(to));
    window.scrollTo(0, 0);
  }, []);
  const value = useMemo(() => ({ path, navigate }), [path, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export const useRouter = () => useContext(RouterContext);

export function Link({ to, children, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
