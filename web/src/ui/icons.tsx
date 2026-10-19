import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const Icons = {
  speed: (
    <Icon>
      <path d="M4 15a8 8 0 0 1 16 0" /><path d="M12 15l4-5" /><path d="M3 19h18" />
    </Icon>
  ),
  box: (
    <Icon>
      <path d="M3 8l9-4 9 4-9 4-9-4z" /><path d="M3 8v8l9 4 9-4V8" /><path d="M12 12v8" />
    </Icon>
  ),
  altitude: (
    <Icon>
      <path d="M12 3v18" /><path d="M8 7l4-4 4 4" /><path d="M5 21h14" />
    </Icon>
  ),
  calendar: (
    <Icon>
      <rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" />
    </Icon>
  ),
  clock: (
    <Icon>
      <circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />
    </Icon>
  ),
  bolt: (
    <Icon>
      <path d="M13 3L5 13h6l-1 8 8-10h-6l1-8z" />
    </Icon>
  ),
  orbit: (
    <Icon>
      <ellipse cx="12" cy="12" rx="9" ry="4.5" /><circle cx="12" cy="12" r="2.2" />
    </Icon>
  ),
  chase: (
    <Icon>
      <path d="M3 18l5-5 4 3 9-9" /><path d="M15 7h6v6" />
    </Icon>
  ),
  top: (
    <Icon>
      <rect x="4" y="4" width="16" height="16" rx="2" /><path d="M12 8v8M8 12h8" />
    </Icon>
  ),
  grid: (
    <Icon>
      <path d="M4 9h16M4 15h16M9 4v16M15 4v16" /><rect x="4" y="4" width="16" height="16" rx="2" />
    </Icon>
  ),
  terrain: (
    <Icon>
      <path d="M3 19l6-9 4 5 3-4 5 8H3z" /><circle cx="17" cy="6" r="2" />
    </Icon>
  ),
  prev: (
    <Icon>
      <path d="M15 6l-6 6 6 6" />
    </Icon>
  ),
  next: (
    <Icon>
      <path d="M9 6l6 6-6 6" />
    </Icon>
  ),
};
