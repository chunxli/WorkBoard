import { describe, expect, it, vi } from "vitest";
import {
  ManagedSessionController,
  type ManagedSessionTransport,
} from "./managed-session-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("ManagedSessionController", () => {
  it.each(["accepted", "rejected", "released"] as const)(
    "rejects idle after session.error when an admitted send is %s",
    async (outcome) => {
      const delivery = deferred<string>();
      const controller = new ManagedSessionController({
        send: () => delivery.promise,
        abort: async () => {},
      });
      const reservation = controller.reserveSteering()!;
      const sessionError = new Error("session failed during Steering");
      const idleFailure = expect(controller.waitForIdle()).rejects.toBe(sessionError);
      controller.observeError(sessionError);
      controller.observeIdle();
      expect(controller.canAcceptSteering).toBe(false);
      if (outcome === "released") {
        reservation.release();
      } else {
        const sending = reservation.send("instruction");
        if (outcome === "accepted") {
          delivery.resolve("ack");
          await expect(sending).resolves.toMatchObject({ accepted: true });
        } else {
          const sendFailure = expect(sending).rejects.toThrow("send failed");
          delivery.reject(new Error("send failed"));
          await sendFailure;
        }
      }
      await idleFailure;
      expect(controller.reserveSteering()).toBeNull();
    }
  );

  it("defers idle observation for admitted sends and waits for the steered turn", async () => {
    const delivery = deferred<{ messageId: string }>();
    const transport: ManagedSessionTransport = {
      send: vi.fn(() => delivery.promise),
      abort: vi.fn(async () => {}),
    };
    const controller = new ManagedSessionController(transport);
    const reservation = controller.reserveSteering();
    expect(reservation).not.toBeNull();
    const idle = vi.fn();
    void controller.waitForIdle().then(idle);

    controller.observeIdle();
    await Promise.resolve();
    expect(idle).not.toHaveBeenCalled();
    expect(controller.reserveSteering()).toBeNull();

    const send = reservation!.send("redirect the active task");
    delivery.resolve({ messageId: "transport-ack" });
    await expect(send).resolves.toEqual({ accepted: true, messageId: "transport-ack" });
    await Promise.resolve();
    expect(idle).not.toHaveBeenCalled();

    controller.observeIdle();
    await controller.waitForIdle();
    expect(idle).toHaveBeenCalledOnce();
    controller.finish();
  });

  it("uses the earlier idle when a reserved send is rejected", async () => {
    const transport: ManagedSessionTransport = {
      send: vi.fn(async () => { throw new Error("transport unavailable"); }),
      abort: vi.fn(async () => {}),
    };
    const controller = new ManagedSessionController(transport);
    const reservation = controller.reserveSteering()!;
    controller.observeIdle();
    await expect(reservation.send("new instruction")).rejects.toThrow("transport unavailable");
    await expect(controller.waitForIdle()).resolves.toBeUndefined();
  });

  it("only sends once per reservation and exposes runtime abort", async () => {
    const transport: ManagedSessionTransport = {
      send: vi.fn(async () => ({ messageId: "ack" })),
      abort: vi.fn(async () => {}),
    };
    const controller = new ManagedSessionController(transport);
    const reservation = controller.reserveSteering()!;
    await reservation.send("one");
    await expect(reservation.send("duplicate")).rejects.toThrow("already been used");
    await controller.abort();
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(transport.abort).toHaveBeenCalledOnce();
  });

  it("does not lose abort completion when an admitted send resolves afterward", async () => {
    const delivery = deferred<{ messageId: string }>();
    const transport: ManagedSessionTransport = {
      send: vi.fn(() => delivery.promise),
      abort: vi.fn(async () => {}),
    };
    const controller = new ManagedSessionController(transport);
    const reservation = controller.reserveSteering()!;
    const sending = reservation.send("cancel while admitted");
    const aborting = controller.abort();
    await Promise.resolve();
    delivery.resolve({ messageId: "accepted" });
    await expect(sending).resolves.toMatchObject({ accepted: true });
    await expect(aborting).resolves.toBeUndefined();
  });
});
