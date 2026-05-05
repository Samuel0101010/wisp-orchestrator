import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRunEvents } from './ws';

interface FakeListeners {
  open?: () => void;
  message?: (ev: { data: string }) => void;
  close?: () => void;
  error?: () => void;
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  triggerOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  triggerMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  triggerClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  addEventListener(type: keyof FakeListeners) {
    void type;
  }
}

const OriginalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
  // @ts-expect-error — overriding for the test
  globalThis.WebSocket = FakeWebSocket;
});

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket;
  vi.restoreAllMocks();
});

describe('useRunEvents', () => {
  it('starts idle when runId is null', () => {
    const { result } = renderHook(() => useRunEvents(null));
    expect(result.current.status).toBe('idle');
    expect(result.current.events).toEqual([]);
  });

  it('flows valid messages into the events list', async () => {
    const { result } = renderHook(() => useRunEvents('run-1'));

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.instances[0]!;

    act(() => ws.triggerOpen());
    await waitFor(() => expect(result.current.status).toBe('open'));

    act(() => ws.triggerMessage({ type: 'run.started', payload: { runId: 'run-1' } }));
    act(() => ws.triggerMessage({ type: 'task.started', payload: { taskId: 'task-1' } }));

    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(result.current.events[0]?.type).toBe('run.started');
    expect(result.current.events[1]?.type).toBe('task.started');
  });

  it('drops invalid messages with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useRunEvents('run-2'));

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.triggerOpen());

    act(() => ws.triggerMessage({ type: 'not.a.real.event', payload: {} }));
    expect(result.current.events).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});
