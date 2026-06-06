import React from 'react';
import { Composition } from 'remotion';
import './fonts';
import { Promo } from './Promo';
import { FPS } from './theme';
import { TOTAL_FRAMES } from './scenes.config';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="promo-landscape"
        component={Promo}
        durationInFrames={TOTAL_FRAMES}
        fps={FPS}
        width={1920}
        height={1080}
      />
    </>
  );
};
