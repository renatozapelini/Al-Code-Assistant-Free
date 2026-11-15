package com.qoder2api.hub;

import java.time.Instant;
import java.util.TimeZone;

/** Standalone JVM test; run with java (no Android runtime or emulator needed). */
public final class ReminderWindowTest {
    private static int assertions;
    private static long at(String iso) { return Instant.parse(iso).toEpochMilli(); }
    private static void equal(long expected, long actual) {
        assertions++;
        if (expected != actual) throw new AssertionError("Expected " + expected + ", got " + actual);
    }
    public static void main(String[] args) {
        long boundary = at("2026-09-18T02:00:00Z"), day = ReminderWindow.DAY;
        equal(Math.floorDiv(boundary + 8 * ReminderWindow.HOUR - 10 * ReminderWindow.HOUR, day), ReminderWindow.window(boundary));
        equal(ReminderWindow.window(boundary) - 1, ReminderWindow.window(boundary - 1));
        equal(ReminderWindow.window(boundary), ReminderWindow.window(boundary + 1));
        equal(ReminderWindow.window(boundary), ReminderWindow.window(boundary + day - 1));
        equal(ReminderWindow.window(boundary) + 1, ReminderWindow.window(boundary + day));
        equal(boundary, ReminderWindow.nextWindowAt(boundary - 1));
        equal(boundary + day, ReminderWindow.nextWindowAt(boundary));
        equal(boundary + day, ReminderWindow.nextWindowAt(boundary + day - 1));
        equal(-1, ReminderWindow.window(0)); // floor, not truncation toward zero
        equal(2 * ReminderWindow.HOUR, ReminderWindow.nextWindowAt(0));
        equal(-1, ReminderWindow.window(-1));
        equal(-2, ReminderWindow.window(-day));
        for (String zone : new String[]{"UTC", "Asia/Singapore", "America/Sao_Paulo", "America/New_York"}) {
            TimeZone.setDefault(TimeZone.getTimeZone(zone));
            equal(boundary + day, ReminderWindow.nextWindowAt(boundary));
            equal(ReminderWindow.window(boundary), ReminderWindow.window(boundary + 6 * ReminderWindow.HOUR));
        }
        long leapBoundary = at("2028-02-29T02:00:00Z");
        equal(at("2028-03-01T02:00:00Z"), ReminderWindow.nextWindowAt(leapBoundary));
        equal(at("2027-01-01T02:00:00Z"), ReminderWindow.nextWindowAt(at("2026-12-31T02:00:00Z")));
        System.out.println("ReminderWindow: " + assertions + " assertions passed");
    }
}
