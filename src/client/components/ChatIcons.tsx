import type { JSX, ReactNode } from 'react';

/** Line icons for the question panel. Decorative: every control carries its own words. */
function Icon({ size = 16, children }: { size?: number; children: ReactNode }): JSX.Element {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function IconChat({ size }: { size?: number }): JSX.Element {
  return (
    <Icon size={size}>
      <path d="M20 12.5a7.5 7.5 0 0 1-10.9 6.7L4 20.5l1.4-4.6A7.5 7.5 0 1 1 20 12.5Z" />
      <path d="M9 11h6M9 14.5h3.5" />
    </Icon>
  );
}

export function IconClose({ size }: { size?: number }): JSX.Element {
  return (
    <Icon size={size}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  );
}

export function IconSend({ size }: { size?: number }): JSX.Element {
  return (
    <Icon size={size}>
      <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
    </Icon>
  );
}

export function IconStop({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" />
    </svg>
  );
}

export function IconCopy({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <Icon size={size}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
    </Icon>
  );
}

export function IconCheck({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <Icon size={size}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Icon>
  );
}

export function IconArrowDown({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <Icon size={size}>
      <path d="M12 5v14M5.5 12.5 12 19l6.5-6.5" />
    </Icon>
  );
}

export function IconRetry({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <Icon size={size}>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4.5 4.5v4h4" />
    </Icon>
  );
}

export function IconQuote({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <Icon size={size}>
      <path d="M9.5 7.5H6.5a1.5 1.5 0 0 0-1.5 1.5v3a1.5 1.5 0 0 0 1.5 1.5H9v.5a3 3 0 0 1-3 3M19 7.5h-3a1.5 1.5 0 0 0-1.5 1.5v3a1.5 1.5 0 0 0 1.5 1.5h2.5v.5a3 3 0 0 1-3 3" />
    </Icon>
  );
}

export function IconPlus({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <Icon size={size}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}
