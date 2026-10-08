/**
 * The Teamlet mark: a T built from four tiles. The dark tile is the lead and
 * the gray ones are its workers. The lead follows `currentColor` and the
 * workers use the `--mark-worker` token, so the mark works in both themes.
 * `size` is the width; the mark is 0.65 as tall. Widths that are multiples of
 * 20 keep the tile edges on whole pixels. `web/public/favicon.svg` is the
 * same mark on a white tile, and `logo.svg` is the bare mark in fixed colors.
 */
export function TeamletMark({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size * 0.65} viewBox="0 0 100 65" aria-hidden="true" className={`mark ${className}`}>
      <rect className="mark-worker" width="30" height="30" rx="8" />
      <rect x="35" width="30" height="30" rx="8" fill="currentColor" />
      <rect className="mark-worker" x="70" width="30" height="30" rx="8" />
      <rect className="mark-worker" x="35" y="35" width="30" height="30" rx="8" />
    </svg>
  );
}
