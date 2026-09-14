import './TelemetryChart.css';

const CHANNELS = {
  speed: { label: 'Speed', unit: 'km/h', color: 'var(--color-data-speed)' },
  throttle: { label: 'Throttle', unit: '%', color: 'var(--color-data-throttle)' },
  brake: { label: 'Brake', unit: '%', color: 'var(--color-data-brake)' },
  rpm: { label: 'RPM', unit: '', color: 'var(--color-data-rpm)' },
};

/**
 * Minimal shared sparkline for one telemetry channel. Deliberately plain —
 * this is Chapter 0 scaffolding to prove historical/live data reaches a
 * shared component unmodified; richer charting comes in a later chapter.
 *
 * @param {{ channel: keyof typeof CHANNELS, samples: import('../lib/telemetryShape').TelemetryUpdate[] }} props
 */
export function TelemetryChart({ channel, samples }) {
  const meta = CHANNELS[channel];
  const values = samples.map((s) => s[channel]);
  const latest = values.at(-1) ?? 0;
  const max = Math.max(1, ...values);

  const points = values
    .map((v, i) => {
      const x = (i / Math.max(1, values.length - 1)) * 100;
      const y = 100 - (v / max) * 100;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <div className="telemetry-chart">
      <div className="telemetry-chart-header">
        <span className="telemetry-chart-label">{meta.label}</span>
        <span className="telemetry-chart-value data-value">
          {Math.round(latest)}
          <span className="telemetry-chart-unit">{meta.unit}</span>
        </span>
      </div>
      <svg
        className="telemetry-chart-svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${meta.label} over time`}
      >
        <polyline points={points} fill="none" stroke={meta.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}
