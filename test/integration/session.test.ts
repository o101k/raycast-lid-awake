import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalStorage } from "@raycast/api";
import { disable, enable, enforce, getStatus } from "../../src/lib/session";
import { getBattery } from "../../src/lib/system";
import type { Session } from "../../src/lib/parse";
import { assertPasswordlessSudo, rawSleepDisabled, runIntegration, sudoSh } from "./env";

// Real session.ts, system.ts and pmset. Only the Raycast API is faked, since it needs the Raycast app.

type StorageHook = (key: string) => void | Promise<void>;

const raycast = vi.hoisted(() => ({
  store: new Map<string, string>(),
  prefs: { batteryThreshold: "20", defaultDuration: "60" } as Record<string, string>,
  launchCommand: vi.fn(),
  // Optional hooks that run right after a write or removal. They stand in for another Raycast command acting at an
  // exact point, since that command runs in its own process and cannot be interleaved from here.
  afterSetItem: undefined as StorageHook | undefined,
  afterRemoveItem: undefined as StorageHook | undefined,
}));

vi.mock("@raycast/api", () => ({
  getPreferenceValues: () => raycast.prefs,
  launchCommand: raycast.launchCommand,
  LaunchType: { Background: "background", UserInitiated: "userInitiated" },
  LocalStorage: {
    getItem: async (key: string) => raycast.store.get(key),
    allItems: async () => Object.fromEntries(raycast.store),
    setItem: async (key: string, value: string) => {
      raycast.store.set(key, value);
      await raycast.afterSetItem?.(key);
    },
    removeItem: async (key: string) => {
      raycast.store.delete(key);
      await raycast.afterRemoveItem?.(key);
    },
  },
}));

const MINUTE = 60_000;
const PMSET_OFF = "/usr/bin/pmset -a disablesleep 0";
const PMSET_ON = "/usr/bin/pmset -a disablesleep 1";

async function storedSessionKeys(): Promise<string[]> {
  return Object.keys(await LocalStorage.allItems()).filter((key) => key.startsWith("session:"));
}

// endsAt must fall between `minutes` after the time before the call and `minutes` after the time after it.
function expectEndsIn(endsAt: number | null | undefined, minutes: number, before: number, after: number): void {
  expect(endsAt).toBeGreaterThanOrEqual(before + minutes * MINUTE);
  expect(endsAt).toBeLessThanOrEqual(after + minutes * MINUTE);
}

describe.runIf(runIntegration)("session.ts on macOS", () => {
  beforeAll(() => {
    assertPasswordlessSudo();
  });

  beforeEach(() => {
    raycast.store.clear();
    raycast.prefs.batteryThreshold = "20";
    raycast.prefs.defaultDuration = "60";
    raycast.launchCommand.mockReset();
    raycast.launchCommand.mockResolvedValue(undefined);
    raycast.afterSetItem = undefined;
    raycast.afterRemoveItem = undefined;
    sudoSh(PMSET_OFF);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    raycast.store.clear();
    sudoSh(PMSET_OFF);
  });

  describe("starting and stopping", () => {
    it("keeps the Mac awake for 30 minutes and records one session that ends in 30 minutes", async () => {
      const before = Date.now();
      await enable(30);
      const after = Date.now();

      expect(rawSleepDisabled()).toBe(true);
      const status = await getStatus();
      expect(status.on).toBe(true);
      expectEndsIn(status.session?.endsAt, 30, before, after);
      expect(await storedSessionKeys()).toHaveLength(1);
      expect(raycast.launchCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "menu-bar" }));
    });

    it("keeps the Mac awake indefinitely when the duration is null, with no end time", async () => {
      await enable(null);

      const status = await getStatus();
      expect(status.on).toBe(true);
      expect(status.session?.endsAt).toBeNull();
      expect(rawSleepDisabled()).toBe(true);
    });

    it("allows sleep again and removes every session when disabled", async () => {
      await enable(30);

      await disable();

      expect(rawSleepDisabled()).toBe(false);
      expect((await getStatus()).on).toBe(false);
      expect(await storedSessionKeys()).toEqual([]);
    });
  });

  describe("automatic turn-off", () => {
    it("keeps sleep disabled before the timer ends", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const start = Date.now();
      await enable(30);

      vi.setSystemTime(start + 29 * MINUTE);

      await expect(enforce()).resolves.toBeNull();
      expect(rawSleepDisabled()).toBe(true);
      expect((await getStatus()).on).toBe(true);
    });

    it("allows sleep again once the timer has run out", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const start = Date.now();
      await enable(30);

      vi.setSystemTime(start + 31 * MINUTE);

      await expect(enforce()).resolves.toBe("timer");
      expect(rawSleepDisabled()).toBe(false);
      expect((await getStatus()).on).toBe(false);
    });

    it("turns sleep off after a restart, when the stored boot time no longer matches", async () => {
      await enable(60);
      const [key] = await storedSessionKeys();
      const session = JSON.parse(raycast.store.get(key) ?? "{}") as Session;
      // Boot time 1 is a Unix time from 1970, so it never matches the real boot time.
      raycast.store.set(key, JSON.stringify({ ...session, bootTime: 1 }));

      await expect(enforce()).resolves.toBe("restart");

      expect(rawSleepDisabled()).toBe(false);
      expect((await getStatus()).on).toBe(false);
    });

    it("reports the session as off, and removes it, when sleep was turned back on outside the extension", async () => {
      await enable(30);

      sudoSh(PMSET_OFF);

      const status = await getStatus();
      expect(status.on).toBe(false);
      expect(status.session).toBeNull();
      expect(await storedSessionKeys()).toEqual([]);
    });

    it("keeps a new 60 minute session when a Start overlaps the expiry of the previous one", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const start = Date.now();
      await enable(5);
      vi.setSystemTime(start + 6 * MINUTE);
      const before = Date.now();

      await Promise.all([enforce(), enable(60)]);
      const after = Date.now();

      expect(rawSleepDisabled()).toBe(true);
      const status = await getStatus();
      expect(status.on).toBe(true);
      expectEndsIn(status.session?.endsAt, 60, before, after);
    });
  });

  describe("overlapping actions", () => {
    it("ends with one session, the later one, when two Starts run at once", async () => {
      const before = Date.now();
      await Promise.all([enable(30), enable(120)]);
      const after = Date.now();

      expect(rawSleepDisabled()).toBe(true);
      expect(await storedSessionKeys()).toHaveLength(1);
      expectEndsIn((await getStatus()).session?.endsAt, 120, before, after);
    });

    it("keeps another Start's timer when the first Start's menu bar launch fails after the second Start saved", async () => {
      let rejectFirstLaunch!: (error: Error) => void;
      raycast.launchCommand.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirstLaunch = reject;
          }),
      );

      const first = enable(30);
      await vi.waitFor(() => expect(raycast.launchCommand).toHaveBeenCalledTimes(1));
      const before = Date.now();
      await enable(60);
      const after = Date.now();
      rejectFirstLaunch(new Error("menu bar command is not enabled"));

      await expect(first).rejects.toThrow("Run Lid Awake Menu Bar once");
      expect(rawSleepDisabled()).toBe(true);
      expect(await storedSessionKeys()).toHaveLength(1);
      expectEndsIn((await getStatus()).session?.endsAt, 60, before, after);
    });

    it("leaves sleep allowed and no session when a Turn Off in another command runs right after a Start saves", async () => {
      let fired = false;
      raycast.afterSetItem = (key) => {
        if (!fired && key.startsWith("session:")) {
          fired = true;
          sudoSh(PMSET_OFF);
          raycast.store.clear();
        }
      };

      await enable(30);

      expect(fired).toBe(true);
      expect(rawSleepDisabled()).toBe(false);
      expect(await storedSessionKeys()).toEqual([]);
    });

    it("leaves sleep allowed when a Start in another command disables it while a Turn Off clears the sessions", async () => {
      await enable(30);
      let fired = false;
      raycast.afterRemoveItem = (key) => {
        if (!fired && key.startsWith("session:")) {
          fired = true;
          sudoSh(PMSET_ON);
        }
      };

      await disable();

      expect(fired).toBe(true);
      expect(rawSleepDisabled()).toBe(false);
      expect(await storedSessionKeys()).toEqual([]);
    });
  });

  describe("when the menu bar cannot launch", () => {
    it("rejects Start, leaves sleep allowed, and stores no session", async () => {
      raycast.launchCommand.mockRejectedValueOnce(new Error("menu bar command is not enabled"));

      await expect(enable(30)).rejects.toThrow("Run Lid Awake Menu Bar once");

      expect(rawSleepDisabled()).toBe(false);
      expect(await storedSessionKeys()).toEqual([]);
    });
  });

  describe("battery cutoff", () => {
    it("never cuts off on AC power or without a battery, even at a 100% cutoff", async (context) => {
      const battery = await getBattery();
      if (battery.hasBattery && !battery.onAC) {
        // The cutoff would apply here, and that case is not what this test is about.
        context.skip();
      }
      raycast.prefs.batteryThreshold = "100";

      await enable(30);
      await enforce();

      expect(rawSleepDisabled()).toBe(true);
    });
  });
});
