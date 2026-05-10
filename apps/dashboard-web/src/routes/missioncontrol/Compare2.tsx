import { MissionControlV9Cockpit } from './V9Cockpit';
import { MissionControlV10Stream } from './V10Stream';
import { MissionControlV11Portfolio } from './V11Portfolio';
import { MissionControlV12Honeycomb } from './V12Honeycomb';
import { MissionControlV13Expose } from './V13Expose';
import { MissionControlV14NowPlaying } from './V14NowPlaying';

const SESSION = 'mc-compare-003';

export function MissionControlCompare2() {
  return (
    <>
      {/* impeccable-variants-start mc-compare-003 */}
      <div
        data-impeccable-variants={SESSION}
        data-impeccable-variant-count={6}
        data-impeccable-variant-labels="Cockpit,Stream,Portfolio,Honeycomb,Exposé,Now Playing"
        style={{ display: 'contents' }}
      >
        <div data-impeccable-variant="1">
          <MissionControlV9Cockpit />
        </div>
        <div data-impeccable-variant="2" style={{ display: 'none' }}>
          <MissionControlV10Stream />
        </div>
        <div data-impeccable-variant="3" style={{ display: 'none' }}>
          <MissionControlV11Portfolio />
        </div>
        <div data-impeccable-variant="4" style={{ display: 'none' }}>
          <MissionControlV12Honeycomb />
        </div>
        <div data-impeccable-variant="5" style={{ display: 'none' }}>
          <MissionControlV13Expose />
        </div>
        <div data-impeccable-variant="6" style={{ display: 'none' }}>
          <MissionControlV14NowPlaying />
        </div>
      </div>
      {/* impeccable-variants-end mc-compare-003 */}
    </>
  );
}
