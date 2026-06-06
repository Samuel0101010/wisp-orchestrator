import React from 'react';
import { AbsoluteFill, Audio, staticFile } from 'remotion';
import { TransitionSeries, linearTiming, springTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
import { COLORS } from './theme';
import { SANS } from './fonts';
import { Backdrop, ProgressBar, Vignette } from './components/primitives';
import { MUSIC_SRC, SCENE_FRAMES, TRANSITION } from './scenes.config';
import { Hook } from './scenes/Hook';
import { Problem } from './scenes/Problem';
import { Crew } from './scenes/Crew';
import { PlanGraph } from './scenes/PlanGraph';
import { LiveRun } from './scenes/LiveRun';
import { Montage } from './scenes/Montage';
import { InstallCTA } from './scenes/InstallCTA';

const fadeT = () => linearTiming({ durationInFrames: TRANSITION });
const slideT = () => springTiming({ config: { damping: 200 }, durationInFrames: TRANSITION });

export const Promo: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg, fontFamily: SANS }}>
      {/* One continuous, living ground behind every scene. */}
      <Backdrop />

      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.hook}>
          <Hook dur={SCENE_FRAMES.hook} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={fadeT()} />

        <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.problem}>
          <Problem dur={SCENE_FRAMES.problem} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={slide({ direction: 'from-right' })} timing={slideT()} />

        <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.crew}>
          <Crew dur={SCENE_FRAMES.crew} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={fadeT()} />

        <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.plan}>
          <PlanGraph dur={SCENE_FRAMES.plan} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={slide({ direction: 'from-bottom' })} timing={slideT()} />

        <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.live}>
          <LiveRun dur={SCENE_FRAMES.live} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={fadeT()} />

        <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.montage}>
          <Montage dur={SCENE_FRAMES.montage} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={slide({ direction: 'from-right' })} timing={slideT()} />

        <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES.cta}>
          <InstallCTA dur={SCENE_FRAMES.cta} />
        </TransitionSeries.Sequence>
      </TransitionSeries>

      <Vignette />
      <ProgressBar />
      {MUSIC_SRC ? <Audio src={staticFile(MUSIC_SRC)} /> : null}
    </AbsoluteFill>
  );
};
