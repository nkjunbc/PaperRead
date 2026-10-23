import type { JSX, ReactNode } from 'react';

/** Line icons for the question panel and the toolbars. Decorative: every control carries its own
 * words, on screen or as its label. The toolbars' icons are drawn with Edge's 1px line (`thin`). */
function Icon({ size = 16, thin = false, children }: { size?: number; thin?: boolean; children: ReactNode }): JSX.Element {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={thin ? 24 / size : 1.9}
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

export function IconCopy({ size = 14, thin }: { size?: number; thin?: boolean }): JSX.Element {
  return (
    <Icon size={size} thin={thin}>
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

export function IconQuote({ size = 14, thin }: { size?: number; thin?: boolean }): JSX.Element {
  return (
    <Icon size={size} thin={thin}>
      <path d="M9.5 7.5H6.5a1.5 1.5 0 0 0-1.5 1.5v3a1.5 1.5 0 0 0 1.5 1.5H9v.5a3 3 0 0 1-3 3M19 7.5h-3a1.5 1.5 0 0 0-1.5 1.5v3a1.5 1.5 0 0 0 1.5 1.5h2.5v.5a3 3 0 0 1-3 3" />
    </Icon>
  );
}

export function IconPlus({ size = 14, thin }: { size?: number; thin?: boolean }): JSX.Element {
  return (
    <Icon size={size} thin={thin}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function IconMinus({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <Icon size={size} thin>
      <path d="M5 12h14" />
    </Icon>
  );
}

/** Edge's "너비에 맞추기": a page's width between two arrows. */
export function IconFitWidth({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <Icon size={size} thin>
      <rect x="2.5" y="5.5" width="19" height="13" rx="2" />
      <path d="M7 12h10M9.5 9.5 7 12l2.5 2.5M14.5 9.5 17 12l-2.5 2.5" />
    </Icon>
  );
}

export function IconChevronUp({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <Icon size={size} thin>
      <path d="m6 15 6-6 6 6" />
    </Icon>
  );
}

export function IconChevronDown({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <Icon size={size} thin>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

/** Edge's "설정 및 기타": three dots in a row. */
export function IconMore({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  );
}

export function IconAttach({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <Icon size={size} thin>
      <path d="m19.5 11.5-7.4 7.4a4.5 4.5 0 0 1-6.4-6.4l7.8-7.8a3 3 0 0 1 4.2 4.2l-7.5 7.5a1.5 1.5 0 0 1-2.1-2.1l6.8-6.8" />
    </Icon>
  );
}

/** The library: papers standing on a shelf. */
export function IconLibrary({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <Icon size={size} thin>
      <rect x="3.5" y="3.5" width="4" height="17" rx="1" />
      <rect x="9.5" y="3.5" width="4" height="17" rx="1" />
      <path d="m15.6 5.2 3.8-1.1 3.3 15.5-3.8 1.1z" />
    </Icon>
  );
}

/** A memo, as Edge's "설명 추가": a speech bubble with a square body. */
export function IconComment({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <Icon size={size} thin>
      <path d="M4.5 4.5h15a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H10l-4.5 3.5v-3.5h-1a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" />
    </Icon>
  );
}

/** The memo list: memos stacked as a list. */
export function IconMemoList({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <Icon size={size} thin>
      <path d="M5.5 3.5h13a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" />
      <path d="M8 8.5h8M8 12h8M8 15.5h5" />
    </Icon>
  );
}
