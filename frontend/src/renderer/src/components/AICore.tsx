import { forwardRef, type CSSProperties } from "react";
import type { AIState } from "../types/assistant";

interface AICoreProps {
  state: AIState;
}

function indexVar(i: number): CSSProperties {
  return { "--i": i } as CSSProperties;
}

const BAR_COUNT = 9;
const PARTICLE_COUNT = 6;

/**
 * The central animated orb. Visual behavior per state is driven entirely by CSS via
 * the `data-state` attribute (see styles/global.css) — this component only renders
 * the layered markup the animations hook into. Forwards its ref so useAudioLevel.ts
 * can write the live `--core-level` custom property directly onto this DOM node.
 */
const AICore = forwardRef<HTMLDivElement, AICoreProps>(function AICore({ state }, ref) {
  return (
    <div className="ai-core" data-state={state} ref={ref}>
      <div className="core-glow" />
      <div className="core-orbit orbit-outer" />
      <div className="core-orbit orbit-inner" />

      <div className="core-particles">
        {Array.from({ length: PARTICLE_COUNT }).map((_, i) => (
          <span key={i} className="particle" style={indexVar(i)} />
        ))}
      </div>

      <div className="core-sphere">
        <div className="core-sheen" />
      </div>

      <div className="core-bars">
        {Array.from({ length: BAR_COUNT }).map((_, i) => (
          <span key={i} className="bar" style={indexVar(i)} />
        ))}
      </div>
    </div>
  );
});

export default AICore;
