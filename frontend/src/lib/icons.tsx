/**
 * 内联 SVG 图标。
 *
 * 为什么不用 emoji：emoji 是字体渲染的，不同系统长得不一样，颜色也跟不了当前文字色，
 * 做不了设计令牌的一部分。这里的图标一律 currentColor + aria-hidden，语义由旁边的文字承担。
 */

type IconProps = { size?: number };

export function SpeakerIcon(props: IconProps) {
  const size = props.size ?? 13;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M11 5 6.5 9H3v6h3.5L11 19z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 6a9 9 0 0 1 0 12" />
    </svg>
  );
}

export function MicIcon(props: IconProps) {
  const size = props.size ?? 13;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

/** 标题旁的小星：纯装饰，所以 aria-hidden */
export function SparkleIcon(props: IconProps) {
  const size = props.size ?? 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3.5 13.9 9.4 19.8 11.3 13.9 13.2 12 19.1 10.1 13.2 4.2 11.3 10.1 9.4z" />
      <path d="M18.5 4.2v2.2M17.4 5.3h2.2" />
    </svg>
  );
}
