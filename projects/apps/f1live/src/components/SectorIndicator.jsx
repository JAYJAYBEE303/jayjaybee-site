import './SectorIndicator.css';

const SECTORS = [1, 2, 3];

/**
 * Shared sector-split indicator. `sector` is read straight off the latest
 * TelemetryUpdate — the pipeline bakes it in per-sample against the lap's
 * official sector-time boundaries (see docs/DATA_SHAPE.md), so this
 * component just highlights which one is active. No computation here.
 *
 * @param {{ sector: 1|2|3 }} props
 */
export function SectorIndicator({ sector }) {
  return (
    <div className="sector-indicator" role="group" aria-label="Current sector">
      {SECTORS.map((n) => (
        <span key={n} className={'sector-chip' + (n === sector ? ' is-active' : '')}>
          Sector {n}
        </span>
      ))}
    </div>
  );
}
