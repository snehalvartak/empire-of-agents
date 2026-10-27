import type { ReactNode } from 'react';

/** Chunky pixel-bordered panel in the Blocky Chronicle style. */
export function Panel({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border-2 border-[#4a4436] bg-[#26241f]/95 shadow-[inset_0_2px_0_rgba(255,255,255,0.06),inset_0_-2px_0_rgba(0,0,0,0.4),0_4px_0_rgba(0,0,0,0.35)] ${className}`}
    >
      {children}
    </div>
  );
}

export function PixelButton({
  children,
  onClick,
  disabled,
  variant = 'default',
  className = '',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'default' | 'primary' | 'danger';
  className?: string;
  title?: string;
}) {
  const variants = {
    default:
      'border-[#4a4436] bg-[#3a3630] text-[#e9dcc0] hover:bg-[#454036] active:translate-y-px',
    primary:
      'border-[#8a6a2a] bg-[#e2b04a] text-[#1a140d] hover:bg-[#f0c263] active:translate-y-px',
    danger:
      'border-[#7a2f28] bg-[#b5443a] text-[#f5e0dc] hover:bg-[#c9554a] active:translate-y-px',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-md border-2 px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Badge({ children, tone = 'stone' }: { children: ReactNode; tone?: string }) {
  const tones: Record<string, string> = {
    stone: 'bg-[#3a3630] text-[#c9bda0] border-[#4a4436]',
    gold: 'bg-[#e2b04a]/20 text-[#e2b04a] border-[#e2b04a]/40',
    grass: 'bg-[#5b8f3a]/20 text-[#a4cf7f] border-[#5b8f3a]/40',
    water: 'bg-[#3b82c4]/20 text-[#9cc8ee] border-[#3b82c4]/40',
    ember: 'bg-[#b5443a]/20 text-[#e89a92] border-[#b5443a]/40',
  };
  return (
    <span
      className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tones[tone] ?? tones.stone}`}
    >
      {children}
    </span>
  );
}
