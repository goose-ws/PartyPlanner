export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 1.5 22 7.5v9L12 22.5 2 16.5v-9L12 1.5Z"
        fill="var(--pp-brass)"
      />
      <path
        d="M12 1.5 22 7.5 12 12 2 7.5 12 1.5Z"
        fill="var(--pp-brass-dark)"
        opacity="0.35"
      />
      <path
        d="M12 12v10.5L2 16.5v-9L12 12Z"
        fill="var(--pp-brass-dark)"
        opacity="0.2"
      />
      <path
        d="M12 1.5 22 7.5v9L12 22.5 2 16.5v-9L12 1.5Z"
        stroke="var(--pp-ink)"
        strokeOpacity="0.15"
        strokeWidth="0.75"
        fill="none"
      />
      <path
        d="M12 1.5 22 7.5 12 12 2 7.5 12 1.5ZM12 12v10.5"
        stroke="var(--pp-ink)"
        strokeOpacity="0.15"
        strokeWidth="0.75"
        fill="none"
      />
    </svg>
  );
}
