package com.qoder2api.hub;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** Independent of WebView/Gateway: no network, account action or exact alarm. */
public final class DailyReminderJob extends JobService {
    @Override public boolean onStartJob(JobParameters params) {
        try { ReminderScheduler.notifyIfDue(this); }
        catch (RuntimeException ignored) {
            // Permission can be revoked between checking it and notifying. No immediate retry.
        }
        return false; // Synchronous, bounded work is already complete.
    }
    @Override public boolean onStopJob(JobParameters params) { return false; }
}
