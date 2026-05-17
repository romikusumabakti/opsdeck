import { cn } from "@/lib/utils";

type SparklineProps = {
  data: number[];
  width?: number;
  height?: number;
  strokeWidth?: number;
  className?: string;
  ariaLabel?: string;
};

// Pure-SVG inline sparkline. Uses `currentColor` so the line + fill follow
// whatever text color the parent sets — that's how we get free dark-mode
// and accent variants without baking in palette values.
export function Sparkline({
  data,
  width = 96,
  height = 28,
  strokeWidth = 1.5,
  className,
  ariaLabel,
}: SparklineProps) {
  if (data.length === 0) {
    return null;
  }

  const padY = 2;
  const innerH = Math.max(height - padY * 2, 1);
  // Floor at 1 so an all-zero series still renders a flat baseline rather
  // than dividing by zero. Max-of-1 also stops a single non-zero point
  // from spiking to the top edge.
  const maxValue = Math.max(...data, 1);
  const stepX = data.length === 1 ? 0 : width / (data.length - 1);

  const points = data.map((value, index) => {
    const x = data.length === 1 ? width / 2 : index * stepX;
    const y = padY + innerH - (value / maxValue) * innerH;
    return { x, y };
  });

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(" ");
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`;

  const lastPoint = points[points.length - 1];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("overflow-visible", className)}
      role="img"
      aria-label={ariaLabel}
    >
      <path d={areaPath} fill="currentColor" opacity={0.12} />
      <path
        d={linePath}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={lastPoint.x}
        cy={lastPoint.y}
        r={2}
        fill="currentColor"
      />
    </svg>
  );
}
