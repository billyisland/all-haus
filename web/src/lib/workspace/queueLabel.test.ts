import { describe, it, expect } from "vitest";
import { queueCountedName, queueFeedName } from "./queueLabel";

const c = (
  fresh: number,
  unread: number,
  truncated = false,
  newTruncated = false,
) => ({ new: fresh, unread, truncated, newTruncated });

describe("queue labels (§VI.1)", () => {
  it("names a feed by numeral, and by name when it has one", () => {
    expect(queueFeedName(3, "Philosophy")).toBe("Channel 3: Philosophy");
    expect(queueFeedName(3, "")).toBe("Channel 3");
  });

  it("carries the counts in the ADR's form", () => {
    expect(queueCountedName("Channel 3: Philosophy", c(2, 8))).toBe(
      "Channel 3: Philosophy, 2 new, 8 unread",
    );
  });

  it("claims nothing before the first window", () => {
    expect(queueCountedName("Channel 3", null)).toBe("Channel 3");
  });

  it("leaves a zero figure out, as the pills do", () => {
    expect(queueCountedName("Channel 3", c(0, 8))).toBe("Channel 3, 8 unread");
    expect(queueCountedName("Channel 3", c(0, 0))).toBe("Channel 3, nothing unread");
  });

  it("reads a truncated figure as a floor", () => {
    expect(queueCountedName("Channel 3", c(4, 500, true))).toBe(
      "Channel 3, 4 new, 500+ unread",
    );
    expect(queueCountedName("Channel 3", c(500, 500, true, true))).toBe(
      "Channel 3, 500+ new, 500+ unread",
    );
  });
});
