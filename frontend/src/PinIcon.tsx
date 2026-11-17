/** A pushpin; filled when the notice is pinned. */
export default function PinIcon({ filled = false, size = 14 }: { filled?: boolean; size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"><path d="M9 3h6l-1 6.5 3.5 3.5v2h-11v-2L10 9.500z" /><path d="M12 15v6" fill="none" /></svg>;
}
