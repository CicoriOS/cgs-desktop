import type { ReactNode } from "react";

function Icon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg className={className ? `i ${className}` : "i"} viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

export const ChevronIcon = ({ className = "chev" }: { className?: string }) => (
  <Icon className={className}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);
export const FolderIcon = () => (
  <Icon>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </Icon>
);
export const FolderPlusIcon = () => (
  <Icon>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    <path d="M12 11v4M10 13h4" />
  </Icon>
);
export const CheckIcon = () => (
  <Icon>
    <path d="m5 12 5 5 9-10" />
  </Icon>
);
export const CopyIcon = () => (
  <Icon>
    <rect x="9" y="9" width="11" height="11" rx="2.5" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </Icon>
);
export const EditIcon = () => (
  <Icon>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Icon>
);
export const SidebarLeftIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M9 4v16" />
  </Icon>
);
export const SidebarRightIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M15 4v16" />
  </Icon>
);
export const ChatBubbleIcon = () => (
  <Icon>
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
    <path d="M9 11h.01M12 11h.01M15 11h.01" />
  </Icon>
);
export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const ArrowUpIcon = () => (
  <Icon>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Icon>
);
export const StopIcon = () => (
  <Icon>
    <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
  </Icon>
);
/** Interrupt the running output and send now. */
export const BoltIcon = () => (
  <Icon>
    <path d="M13 3 5 13h6l-1 8 8-10h-6Z" />
  </Icon>
);
export const ForkIcon = () => (
  <Icon>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="8" r="2" />
    <path d="M6 7v10M18 10c0 4-6 3-12 7" />
  </Icon>
);
export const CloseIcon = () => (
  <Icon>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);
