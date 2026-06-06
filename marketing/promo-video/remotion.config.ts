import { Config } from '@remotion/cli/config';

// H.264 MP4, high quality, deterministic stills.
// Lossless PNG intermediate frames (no per-frame JPEG "breathing" on the slow
// zooms over detailed screenshots) + a low CRF so the encoder has enough bitrate
// to keep those slow pans smooth instead of stuttering on playback.
Config.setVideoImageFormat('png');
Config.setStillImageFormat('png');
Config.setCrf(16);
Config.setOverwriteOutput(true);
Config.setChromiumOpenGlRenderer('angle');
