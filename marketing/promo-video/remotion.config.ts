import { Config } from '@remotion/cli/config';

// H.264 MP4, high quality, deterministic stills.
Config.setVideoImageFormat('jpeg');
Config.setStillImageFormat('png');
Config.setOverwriteOutput(true);
Config.setChromiumOpenGlRenderer('angle');
