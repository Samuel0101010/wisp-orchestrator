import '@testing-library/jest-dom/vitest';
import '../i18n';

// React Flow needs ResizeObserver, DOMRect, and a reasonable viewport size in
// jsdom. We stub the bare minimum so components that mount React Flow don't
// crash when imported.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  // @ts-expect-error -- attach stub
  globalThis.ResizeObserver = ResizeObserverStub;
}

if (typeof globalThis.DOMRect === 'undefined') {
  // jsdom may not expose DOMRect on older versions.
  // @ts-expect-error -- minimal polyfill
  globalThis.DOMRect = class {
    constructor(
      public x = 0,
      public y = 0,
      public width = 0,
      public height = 0,
    ) {}
    top = 0;
    left = 0;
    right = 0;
    bottom = 0;
    static fromRect(): DOMRect {
      return new DOMRect();
    }
    toJSON(): unknown {
      return {};
    }
  };
}
