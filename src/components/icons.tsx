/** Inline line-art icons (dark stroke, pastel fill) — no external images to load. */
import { ReactNode, SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 24, children, ...rest }: P & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

const TINT = 'var(--tint, #dbe7ff)';

export const Logo = ({ size = 36 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
    <defs>
      <linearGradient id="xd-g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#19c37d" />
        <stop offset="1" stopColor="#2f6bff" />
      </linearGradient>
    </defs>
    <rect x="2" y="2" width="44" height="44" rx="13" fill="url(#xd-g)" />
    <path d="M13 15l9 18M22 15l-9 18" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
    <path d="M27 15h3.5a9 9 0 0 1 0 18H27z" fill="none" stroke="#fff" strokeWidth="4" strokeLinejoin="round" />
  </svg>
);

/* ---- navigation / actions (24px grid) ---- */
export const IconHome = (p: P) => (
  <Svg {...p}>
    <path d="M4 11.2 12 4l8 7.2V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" fill={TINT} />
  </Svg>
);
export const IconGrid = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="2" fill={TINT} />
    <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="2" fill={TINT} />
  </Svg>
);
export const IconPdfEdit = (p: P) => (
  <Svg {...p}>
    <path d="M6 3h8l4 4v6.5M6 3a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h4.5" />
    <path d="M14 3v4h4" fill={TINT} />
    <path d="m13.2 19.6 5.9-5.9a1.5 1.5 0 0 1 2.1 2.1l-5.9 5.9-2.8.7z" fill={TINT} />
    <path d="M8 11h5M8 14.5h3" />
  </Svg>
);
export const IconPhoto = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" fill={TINT} />
    <circle cx="8.5" cy="10" r="1.6" fill="#fff" />
    <path d="m4 17 5-4.5 3.5 3L15 13l5 4.5" />
  </Svg>
);
export const IconMerge = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="8" height="10" rx="1.6" fill={TINT} />
    <rect x="13" y="4" width="8" height="10" rx="1.6" />
    <path d="M7 14v2.5a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V14M12 18.5V21" />
  </Svg>
);
export const IconSplit = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="3" width="14" height="18" rx="2" fill={TINT} />
    <path d="M2.5 12h3M8 12h2M12.5 12h2M17 12h4.5" />
  </Svg>
);
export const IconFont = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="4" fill={TINT} />
    <path d="m7.5 16.5 3-9h.6l3 9M8.6 13.5h4.4M15.8 16.6c.7 0 2.4-.5 2.4-2.4V12c0-.9-.7-1.5-1.6-1.5-.8 0-1.4.4-1.6 1M18.2 13.2c-1.5 0-3 .4-3 1.8 0 .9.6 1.5 1.5 1.5" />
  </Svg>
);
export const IconQr = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" fill={TINT} />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <path d="M14 14h2.5v2.5H14zM18 18h2.5v2.5H18zM18 14h2.5M14 18.5v2" />
  </Svg>
);
export const IconCompress = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="3" width="14" height="18" rx="2" fill={TINT} />
    <path d="M12 6v4m0 0-2-2m2 2 2-2M12 18v-4m0 0-2 2m2-2 2 2" />
  </Svg>
);
export const IconSign = (p: P) => (
  <Svg {...p}>
    <path d="M3 17c2.5-6 4.5-9 6-9s.6 4-1 7c2-2.500 3.500-4 4.500-4s.5 2.500 1.500 2.500 1.500-1.500 3-1.500 1.500 1.500 4 1.500" />
    <path d="M3 21h18" />
  </Svg>
);
export const IconBack = (p: P) => (
  <Svg {...p}>
    <path d="M19 12H5m0 0 6-6m-6 6 6 6" />
  </Svg>
);
export const IconChevron = (p: P) => (
  <Svg {...p}>
    <path d="m9 5 7 7-7 7" />
  </Svg>
);
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const IconDownload = (p: P) => (
  <Svg {...p}>
    <path d="M12 4v11m0 0-4.500-4.500M12 15l4.500-4.500M5 19.500h14" />
  </Svg>
);
export const IconUndo = (p: P) => (
  <Svg {...p}>
    <path d="M8 8H5V5M5 8a8 8 0 1 1-1 6" />
  </Svg>
);
export const IconRedo = (p: P) => (
  <Svg {...p}>
    <path d="M16 8h3V5M19 8a8 8 0 1 0 1 6" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconMinus = (p: P) => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
);
export const IconCursor = (p: P) => (
  <Svg {...p}>
    <path d="M9 4h1.500a1.500 1.500 0 0 1 1.500 1.500v13a1.500 1.500 0 0 1-1.500 1.500H9M15 4h-1.500A1.500 1.500 0 0 0 12 5.500M15 20h-1.500a1.500 1.500 0 0 1-1.500-1.500M10 12h4" />
  </Svg>
);
export const IconTextAdd = (p: P) => (
  <Svg {...p}>
    <path d="M4 7V5h11v2M9.500 5v13M7.500 18h4M18 13v7M14.500 16.500h7" />
  </Svg>
);
export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M4.500 7h15M9.500 7V4.500h5V7M6.500 7l.8 12a1.500 1.500 0 0 0 1.500 1.400h6.400a1.500 1.500 0 0 0 1.500-1.400l.8-12M10 11v5.500M14 11v5.500" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="m5 12.500 4.500 4.500L19 7.500" />
  </Svg>
);
export const IconWarn = (p: P) => (
  <Svg {...p}>
    <path d="M12 4 2.800 19.500h18.400zM12 10v4.500M12 17.200v.1" />
  </Svg>
);
export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.500" />
    <path d="m16 16 4.500 4.500" />
  </Svg>
);
export const IconUpload = (p: P) => (
  <Svg {...p}>
    <path d="M12 16V5m0 0L7.500 9.500M12 5l4.500 4.500M5 19.500h14" />
  </Svg>
);
export const IconDevice = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4.500" width="18" height="12" rx="2" />
    <path d="M8.500 20h7M12 16.500V20" />
  </Svg>
);
export const IconShapes = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="4.500" />
    <rect x="11.500" y="11.500" width="9" height="9" rx="2" />
  </Svg>
);
export const IconShield = (p: P) => (
  <Svg {...p}>
    <path d="M12 3 4.500 6v5.500c0 4.500 3 8 7.500 9.500 4.500-1.500 7.500-5 7.500-9.500V6z" fill={TINT} />
    <path d="m9 12 2.200 2.200L15.200 10" />
  </Svg>
);
export const IconSpark = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.500 13.800 9l5.700 1.800-5.700 1.800L12 18l-1.800-5.400L4.500 10.800 10.200 9z" fill={TINT} />
    <path d="M18.500 16.500v4M16.500 18.500h4" />
  </Svg>
);
export const IconAlignStart = (p: P) => (
  <Svg {...p}>
    <path d="M4 4v16M8 8h11M8 16h7" />
  </Svg>
);
export const IconAlignCenter = (p: P) => (
  <Svg {...p}>
    <path d="M12 4v16M6 8h12M8 16h8" />
  </Svg>
);
export const IconAlignEnd = (p: P) => (
  <Svg {...p}>
    <path d="M20 4v16M5 8h11M9 16h7" />
  </Svg>
);
export const IconFile = (p: P) => (
  <Svg {...p}>
    <path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill={TINT} />
    <path d="M14 3v5h5M9 13h6M9 16.500h4" />
  </Svg>
);
export const IconGlobe = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.500" />
    <path d="M3.500 12h17M12 3.500c2.500 2.500 3.500 5.500 3.500 8.500s-1 6-3.500 8.500c-2.500-2.500-3.500-5.500-3.500-8.500s1-6 3.500-8.500z" />
  </Svg>
);
export const IconLock = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="10.500" width="14" height="10" rx="2.500" fill={TINT} />
    <path d="M8 10.500V8a4 4 0 0 1 8 0v2.500M12 14.500v2" />
  </Svg>
);
export const IconPdfDrop = ({ size = 56 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 56 56" fill="none" aria-hidden="true">
    <path d="M15 5h18l11 11v31a4 4 0 0 1-4 4H15a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4z" fill="#fff" stroke="#0f1419" strokeWidth="2.200" strokeLinejoin="round" />
    <path d="M33 5v8a3 3 0 0 0 3 3h8" fill="#dbe7ff" stroke="#0f1419" strokeWidth="2.200" strokeLinejoin="round" />
    <rect x="5" y="25" width="30" height="15" rx="4" fill="#e5484d" />
    <path d="M10.500 36v-7h2.300a2.200 2.200 0 0 1 0 4.400h-2.300M18.200 36v-7h1.900a3.500 3.500 0 0 1 0 7zM26.200 36v-7h4M26.200 32.600h3.200" stroke="#fff" strokeWidth="1.700" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M18 45h16" stroke="#0f1419" strokeWidth="2.200" strokeLinecap="round" />
  </svg>
);
/** Flag of Cambodia, simplified. */
export const FlagKH = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={(size * 2) / 3} viewBox="0 0 30 20" aria-label="Cambodia" role="img">
    <rect width="30" height="20" rx="2" fill="#032ea1" />
    <rect y="5" width="30" height="10" fill="#e00025" />
    <path d="M9.500 13.500h11v-1.200h-1v-2.300l-1-1.500-.800 1.500h-1.200V8L15 5.800 13.500 8v2h-1.200l-.800-1.500-1 1.500v2.300h-1z" fill="#fff" />
  </svg>
);
