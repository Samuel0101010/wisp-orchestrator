import { NavLink } from 'react-router-dom';

const setA = [
  { path: '/mc/v1', n: '01', name: 'Terminal' },
  { path: '/mc/v2', n: '02', name: 'Broadsheet' },
  { path: '/mc/v3', n: '03', name: 'Radar' },
  { path: '/mc/v4', n: '04', name: 'Spec' },
  { path: '/mc/v5', n: '05', name: 'Transit' },
  { path: '/mc/v6', n: '06', name: 'Poster' },
  { path: '/mc/v7', n: '07', name: 'Heatmap' },
  { path: '/mc/v8', n: '08', name: 'Console' },
];
const setB = [
  { path: '/mc/v9', n: '09', name: 'Cockpit' },
  { path: '/mc/v10', n: '10', name: 'Stream' },
  { path: '/mc/v11', n: '11', name: 'Portfolio' },
  { path: '/mc/v12', n: '12', name: 'Honeycomb' },
  { path: '/mc/v13', n: '13', name: 'Exposé' },
  { path: '/mc/v14', n: '14', name: 'Now Playing' },
];
const setC = [
  { path: '/mc/v15', n: '15', name: 'Stream²' },
  { path: '/mc/v16', n: '16', name: 'Focus' },
  { path: '/mc/v17', n: '17', name: 'Dispatch' },
  { path: '/mc/v18', n: '18', name: 'Cockpit²' },
  { path: '/mc/v19', n: '19', name: 'Timeline' },
  { path: '/mc/v20', n: '20', name: 'Inbox' },
];
export function VariantSwitcher({
  tone = 'light',
  set = 'a',
}: {
  tone?: 'light' | 'dark' | 'paper' | 'cream';
  set?: 'a' | 'b' | 'c';
}) {
  const variants = set === 'c' ? setC : set === 'b' ? setB : setA;
  const otherSet = set === 'c' ? 'a' : set === 'b' ? 'c' : 'b';
  const otherFirst = set === 'c' ? '/mc/v1' : set === 'b' ? '/mc/v15' : '/mc/v9';
  const surface =
    tone === 'dark'
      ? 'bg-black/40 text-zinc-300 border-zinc-800'
      : tone === 'paper'
        ? 'bg-stone-50/80 text-stone-700 border-stone-300'
        : tone === 'cream'
          ? 'bg-[#f4ede1]/80 text-stone-900 border-stone-400'
          : 'bg-background/70 text-muted-foreground border-border';
  return (
    <nav
      className={`sticky top-0 z-30 -mx-6 -mt-6 mb-6 flex items-center gap-0 border-b px-6 py-2 backdrop-blur ${surface}`}
      aria-label="Mission Control variant"
    >
      <span className="mr-4 font-mono text-[10px] uppercase tracking-[0.18em] opacity-60">
        Mission Control / variants
      </span>
      <ul className="flex items-center gap-0">
        {variants.map((v, i) => (
          <li key={v.path}>
            <NavLink
              to={v.path}
              className={({ isActive }) =>
                [
                  'flex items-center gap-2 px-3 py-1 font-mono text-[11px] tracking-tight',
                  i > 0 ? 'border-l border-current/20' : '',
                  isActive
                    ? 'opacity-100 underline underline-offset-[6px]'
                    : 'opacity-50 hover:opacity-90',
                ].join(' ')
              }
            >
              <span className="tabular-nums">{v.n}</span>
              <span className="font-sans">{v.name}</span>
            </NavLink>
          </li>
        ))}
      </ul>
      <NavLink
        to={otherFirst}
        className="ml-auto font-mono text-[10px] uppercase tracking-[0.18em] opacity-50 hover:opacity-90"
      >
        → set {otherSet.toUpperCase()}
      </NavLink>
    </nav>
  );
}
