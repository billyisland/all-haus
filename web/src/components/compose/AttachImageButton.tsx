'use client'

// The picture control on BOTH compose surfaces. The icon's 1.5 stroke is drawn
// in a 16-unit box at 18px, so it renders at ~1.7px — an icon, not a rule.
export function AttachImageButton({
  onClick,
  disabled,
}: {
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-grey-600 hover:text-black disabled:opacity-40 transition-colors"
      title="Add image"
      aria-label="Add image"
      data-explain="composer.image"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
        <circle cx="5.5" cy="5.5" r="1" />
        <path d="M14.5 10.5L11 7L3.5 14.5" />
      </svg>
    </button>
  )
}
