import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { TransitionSeries, linearTiming, springTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
import { COLORS } from './theme';
import { SANS } from './fonts';
import { Backdrop, ProgressBar, Vignette } from './components/primitives';
import { MUSIC_SRC, SCENES, TRANSITION, type Scene, type TransKind } from './scenes.config';
import { VOICEOVER, musicVolumeAt } from './voiceover.config';
import { Hook } from './scenes/Hook';
import { Problem } from './scenes/Problem';
import { InstallCTA } from './scenes/InstallCTA';
import { ChapterCard } from './scenes/ChapterCard';
import { FeatureTour } from './scenes/FeatureTour';
import { BuildStory } from './scenes/BuildStory';
import { DesignSwap } from './scenes/DesignSwap';

function renderScene(s: Scene): React.ReactNode {
  switch (s.kind) {
    case 'hook':
      return <Hook dur={s.dur} />;
    case 'problem':
      return <Problem dur={s.dur} />;
    case 'cta':
      return <InstallCTA dur={s.dur} />;
    case 'build':
      return <BuildStory dur={s.dur} />;
    case 'design':
      return (
        <DesignSwap
          dur={s.dur}
          srcA={s.srcA}
          srcB={s.srcB}
          labelA={s.labelA}
          labelB={s.labelB}
          eyebrow={s.eyebrow}
          title={s.title}
          browserTitle={s.browserTitle}
          accent={s.accent}
          portrait={s.portrait}
        />
      );
    case 'chapter':
      return <ChapterCard dur={s.dur} index={s.index} title={s.title} accent={s.accent} />;
    case 'tour':
      return (
        <FeatureTour
          dur={s.dur}
          screenshot={s.screenshot}
          browserTitle={s.browserTitle}
          eyebrow={s.eyebrow}
          title={s.title}
          chips={s.chips}
          accent={s.accent}
          portrait={s.portrait}
        />
      );
  }
}

const presentationFor = (t: NonNullable<TransKind>) =>
  t.type === 'fade' ? fade() : slide({ direction: t.dir });
const timingFor = (t: NonNullable<TransKind>) =>
  t.type === 'fade'
    ? linearTiming({ durationInFrames: TRANSITION })
    : springTiming({ config: { damping: 200 }, durationInFrames: TRANSITION });

export const Promo: React.FC = () => {
  const children: React.ReactNode[] = [];
  SCENES.forEach((s) => {
    children.push(
      <TransitionSeries.Sequence key={s.id} durationInFrames={s.dur}>
        {renderScene(s)}
      </TransitionSeries.Sequence>,
    );
    if (s.trans) {
      children.push(
        <TransitionSeries.Transition
          key={`${s.id}-trans`}
          presentation={presentationFor(s.trans)}
          timing={timingFor(s.trans)}
        />,
      );
    }
  });

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg, fontFamily: SANS }}>
      {/* One continuous, living ground behind every scene. */}
      <Backdrop />

      <TransitionSeries>{children}</TransitionSeries>

      <Vignette />
      <ProgressBar />

      {/* Background music — ducked under the voice-over. */}
      {MUSIC_SRC ? <Audio src={staticFile(MUSIC_SRC)} volume={musicVolumeAt} /> : null}

      {/* Voice-over: one clip per narrated scene, in front of the music. */}
      {VOICEOVER.map((v) => (
        <Sequence key={v.src} from={v.from} durationInFrames={v.dur}>
          <Audio src={staticFile(v.src)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
