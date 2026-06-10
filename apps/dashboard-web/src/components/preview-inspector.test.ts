import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { INSPECTOR_SCRIPT, INSPECTOR_VERSION } from './preview-inspector';

/**
 * Exercises the injected inspector script end-to-end inside jsdom via the
 * real postMessage protocol: in jsdom `window.parent === window`, so the
 * script's `harness:pick` payloads arrive back on this window. Each click
 * yields exactly one pick message, which makes the round-trip deterministic.
 */

interface PickPayload {
  kind: 'harness:pick';
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
  html: string;
  version: string;
}

/** Post a message to the inspector and resolve once it has been processed
 * (message events are delivered in order, so a trailing flush marker
 * guarantees the previous message was handled). */
function postToInspector(msg: unknown): Promise<void> {
  return new Promise((resolve) => {
    const onMsg = (e: MessageEvent) => {
      if ((e.data as { kind?: string } | null)?.kind === 'test:flush') {
        window.removeEventListener('message', onMsg);
        resolve();
      }
    };
    window.addEventListener('message', onMsg);
    window.postMessage(msg, '*');
    window.postMessage({ kind: 'test:flush' }, '*');
  });
}

/** Click an element in edit mode and resolve with the inspector's pick. */
function pickFromClick(el: Element): Promise<PickPayload> {
  return new Promise((resolve) => {
    const onMsg = (e: MessageEvent) => {
      if ((e.data as { kind?: string } | null)?.kind === 'harness:pick') {
        window.removeEventListener('message', onMsg);
        resolve(e.data as PickPayload);
      }
    };
    window.addEventListener('message', onMsg);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function mount(html: string): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-test-root', '1');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

beforeAll(async () => {
  // Evaluate the raw script exactly as the iframe would.
  new Function(INSPECTOR_SCRIPT)();
  await postToInspector({ kind: 'harness:set-edit-mode', value: true });
});

afterEach(() => {
  document.querySelectorAll('[data-test-root]').forEach((el) => el.remove());
});

describe('preview-inspector buildSelector (v2)', () => {
  it('echoes version 2 in the pick payload', async () => {
    expect(INSPECTOR_VERSION).toBe('2');
    const root = mount('<button data-testid="ok-btn">ok</button>');
    const pick = await pickFromClick(root.querySelector('button')!);
    expect(pick.version).toBe('2');
  });

  it('prefers data-testid over id and aria-label', async () => {
    const root = mount(
      '<button data-testid="save-btn" id="save" aria-label="save-now">save</button>',
    );
    const pick = await pickFromClick(root.querySelector('button')!);
    expect(pick.selector).toBe('[data-testid="save-btn"]');
  });

  it('falls back to #id when there is no data-testid', async () => {
    const root = mount('<button id="save" aria-label="save-now">save</button>');
    const pick = await pickFromClick(root.querySelector('button')!);
    expect(pick.selector).toBe('#save');
  });

  it('uses [aria-label] when it is unique in the document', async () => {
    const root = mount('<button aria-label="close-dialog">x</button>');
    const pick = await pickFromClick(root.querySelector('button')!);
    expect(pick.selector).toBe('[aria-label="close-dialog"]');
  });

  it('skips a non-unique aria-label and falls back to the path', async () => {
    const root = mount(
      '<div><button aria-label="close-dialog">a</button><button aria-label="close-dialog">b</button></div>',
    );
    const pick = await pickFromClick(root.querySelectorAll('button')[1]!);
    expect(pick.selector).not.toContain('aria-label');
    expect(pick.selector).toContain('button:nth-of-type(2)');
  });

  it('fallback path has no class segments and anchors at a data-testid ancestor', async () => {
    const root = mount(
      '<section data-testid="panel"><div class="tw-h4sh flex gap-2">' +
        '<span class="text-xs">first</span><span class="text-xs">second</span>' +
        '</div></section>',
    );
    const pick = await pickFromClick(root.querySelectorAll('span')[1]!);
    expect(pick.selector).toBe('[data-testid="panel"] > div > span:nth-of-type(2)');
    expect(pick.selector).not.toContain('.');
  });
});
