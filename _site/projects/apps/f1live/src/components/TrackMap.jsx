import './TrackMap.css';

const PADDING_RATIO = 0.08;

function computeBounds(points) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Shared top-down track map — mode-agnostic like TelemetryChart.
 *
 * `points` is the (x, y) path traced so far for the lap in progress
 * (caller accumulates this across updates and resets it when a new lap
 * starts); `current` is the latest position for the moving dot. Neither
 * this component nor its caller-side accumulation cares whether the
 * points came from historicalAdapter or liveAdapter.
 *
 * @param {{ points: {x: number, y: number}[], current?: {x: number, y: number} }} props
 */
export function TrackMap({ points, current }) {
  if (points.length < 2) {
    return (
      <div className="track-map">
        <span className="track-map-label">Track position</span>
        <p className="track-map-waiting">Waiting for position data…</p>
      </div>
    );
  }

  const { minX, maxX, minY, maxY } = computeBounds(points);
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const padX = width * PADDING_RATIO;
  const padY = height * PADDING_RATIO;
  const viewMinX = minX - padX;
  const viewMinY = minY - padY;
  const viewWidth = width + padX * 2;
  const viewHeight = height + padY * 2;

  // Flip Y — these coordinates are metres in fastf1's local track frame,
  // not screen space, and rendering them as-is comes out mirrored
  // vertically relative to how a top-down map is usually pictured.
  const toView = (p) => {
    const x = p.x - viewMinX;
    const y = viewHeight - (p.y - viewMinY);
    return `${x},${y}`;
  };

  const pathPoints = points.map(toView).join(' ');
  const dotRadius = Math.max(viewWidth, viewHeight) * 0.015;
  const [dotX, dotY] = current ? toView(current).split(',').map(Number) : [];

  return (
    <div className="track-map">
      <span className="track-map-label">Track position</span>
      <svg
        className="track-map-svg"
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Car position on track"
      >
        <polyline
          points={pathPoints}
          fill="none"
          stroke="var(--color-border-strong)"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
        {current && (
          <circle
            cx={dotX}
            cy={dotY}
            r={dotRadius}
            fill="var(--color-accent)"
            stroke="var(--color-bg)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </div>
  );
}
