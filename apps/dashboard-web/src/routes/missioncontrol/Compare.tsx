import { MissionControlV1Terminal } from './V1Terminal';
import { MissionControlV2Broadsheet } from './V2Broadsheet';
import { MissionControlV3Radar } from './V3Radar';
import { MissionControlV4SpecSheet } from './V4SpecSheet';
import { MissionControlV5Transit } from './V5Transit';
import { MissionControlV6Poster } from './V6Poster';
import { MissionControlV7Heatmap } from './V7Heatmap';
import { MissionControlV8Console } from './V8Console';

const SESSION = 'mc-compare-002';

export function MissionControlCompare() {
  return (
    <>
      {/* impeccable-variants-start mc-compare-002 */}
      <div
        data-impeccable-variants={SESSION}
        data-impeccable-variant-count={8}
        data-impeccable-variant-labels="Terminal,Broadsheet,Radar,Spec Sheet,Transit,Poster,Heatmap,Console"
        style={{ display: 'contents' }}
      >
        <div data-impeccable-variant="1">
          <MissionControlV1Terminal />
        </div>
        <div data-impeccable-variant="2" style={{ display: 'none' }}>
          <MissionControlV2Broadsheet />
        </div>
        <div data-impeccable-variant="3" style={{ display: 'none' }}>
          <MissionControlV3Radar />
        </div>
        <div data-impeccable-variant="4" style={{ display: 'none' }}>
          <MissionControlV4SpecSheet />
        </div>
        <div data-impeccable-variant="5" style={{ display: 'none' }}>
          <MissionControlV5Transit />
        </div>
        <div data-impeccable-variant="6" style={{ display: 'none' }}>
          <MissionControlV6Poster />
        </div>
        <div data-impeccable-variant="7" style={{ display: 'none' }}>
          <MissionControlV7Heatmap />
        </div>
        <div data-impeccable-variant="8" style={{ display: 'none' }}>
          <MissionControlV8Console />
        </div>
      </div>
      {/* impeccable-variants-end mc-compare-002 */}
    </>
  );
}
