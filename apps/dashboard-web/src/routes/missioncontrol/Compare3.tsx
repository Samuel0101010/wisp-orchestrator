import { MissionControlV15Stream2 } from './V15Stream2';
import { MissionControlV16Focus } from './V16Focus';
import { MissionControlV17Dispatch } from './V17Dispatch';
import { MissionControlV18Cockpit2 } from './V18Cockpit2';
import { MissionControlV19Timeline } from './V19Timeline';
import { MissionControlV20Inbox } from './V20Inbox';

const SESSION = 'mc-compare-004';

export function MissionControlCompare3() {
  return (
    <>
      {/* impeccable-variants-start mc-compare-004 */}
      <div
        data-impeccable-variants={SESSION}
        data-impeccable-variant-count={6}
        data-impeccable-variant-labels="Stream²,Focus,Dispatch,Cockpit²,Timeline,Inbox"
        style={{ display: 'contents' }}
      >
        <div data-impeccable-variant="1">
          <MissionControlV15Stream2 />
        </div>
        <div data-impeccable-variant="2" style={{ display: 'none' }}>
          <MissionControlV16Focus />
        </div>
        <div data-impeccable-variant="3" style={{ display: 'none' }}>
          <MissionControlV17Dispatch />
        </div>
        <div data-impeccable-variant="4" style={{ display: 'none' }}>
          <MissionControlV18Cockpit2 />
        </div>
        <div data-impeccable-variant="5" style={{ display: 'none' }}>
          <MissionControlV19Timeline />
        </div>
        <div data-impeccable-variant="6" style={{ display: 'none' }}>
          <MissionControlV20Inbox />
        </div>
      </div>
      {/* impeccable-variants-end mc-compare-004 */}
    </>
  );
}
