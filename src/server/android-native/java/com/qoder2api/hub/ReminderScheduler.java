package com.qoder2api.hub;

import android.Manifest;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import java.util.Map;

/** Opt-in, best-effort reminders only. Never logs in, claims credits or infers a claim. */
public final class ReminderScheduler {
    public static final int JOB_ID = 30001;
    private static final int NOTIFICATION_ID = 30002;
    private static final String CHANNEL = "qoder-manual-reminder-v1";
    private static final String PREFS = "native-reminder";
    private static final long SIX_HOURS = 6 * 60 * 60 * 1000L;
    private static final String EXPLANATION = "A nova janela abre às 10:00 UTC+8. Abra o Qoder Desktop e resgate manualmente em Usage → presente. "
        + "Somente contas pessoais Qoder International; Teams e Enterprise não são elegíveis. Login não concede créditos. "
        + "Este aplicativo apenas lembra: não faz login nem resgate automático. Android/Doze pode atrasar o lembrete; "
        + "forçar parada impede notificações até reabrir o aplicativo.";

    private ReminderScheduler() {}
    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
    private static JobScheduler jobs(Context context) {
        return (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
    }
    private static NotificationManager notifications(Context context) {
        return (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    }
    private static void ensureChannel(Context context) {
        NotificationManager manager = notifications(context);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Lembrete manual do Qoder Desktop", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("Lembrete opcional. O resgate só pode ser feito manualmente no Qoder Desktop.");
        manager.createNotificationChannel(channel);
    }
    public static boolean notificationPermission(Context context) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
        NotificationManager manager = notifications(context);
        if (manager == null || !manager.areNotificationsEnabled()) return false;
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }
    private static boolean schedule(Context context) {
        JobScheduler scheduler = jobs(context);
        if (scheduler == null) return false;
        if (scheduler.getPendingJob(JOB_ID) != null) return true;
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(context, DailyReminderJob.class))
            .setPeriodic(SIX_HOURS, 60 * 60 * 1000L)
            .setPersisted(true)
            .build();
        return scheduler.schedule(job) == JobScheduler.RESULT_SUCCESS;
    }
    private static void cancel(Context context) {
        JobScheduler scheduler = jobs(context);
        if (scheduler != null) scheduler.cancel(JOB_ID);
        NotificationManager manager = notifications(context);
        if (manager != null) manager.cancel(NOTIFICATION_ID);
    }
    /** Called on process startup, reopen, boot and package replacement; no permission prompt. */
    public static synchronized void restore(Context context) {
        try {
            ensureChannel(context);
            if (prefs(context).getBoolean("enabled", false)) schedule(context); else cancel(context);
        } catch (RuntimeException ignored) {
            // The settings report the actual pending job; a later reopen may retry.
        }
    }
    public static synchronized String getSettings(Context context) {
        return Json.stringify(settings(context, null));
    }
    public static synchronized String setEnabled(Context context, boolean enabled) {
        // Durable opt-in must precede any scheduling or notification side effect.
        if (!prefs(context).edit().putBoolean("enabled", enabled).commit()) {
            return Json.stringify(settings(context, "Não foi possível persistir a preferência; o agendamento não foi alterado."));
        }
        String error = null;
        try {
            ensureChannel(context);
            if (enabled) {
                if (!schedule(context)) error = "O Android não aceitou o agendamento; reabra o aplicativo para tentar novamente.";
            } else cancel(context);
        } catch (RuntimeException e) {
            error = "Não foi possível atualizar o agendamento Android. Reabra o aplicativo para tentar novamente.";
        }
        return Json.stringify(settings(context, error));
    }
    private static Map<String, Object> settings(Context context, String error) {
        SharedPreferences saved = prefs(context);
        boolean enabled = saved.getBoolean("enabled", false), permission = notificationPermission(context), scheduled = false;
        try {
            JobScheduler scheduler = jobs(context);
            scheduled = enabled && scheduler != null && scheduler.getPendingJob(JOB_ID) != null;
        } catch (RuntimeException ignored) {}
        String message = EXPLANATION;
        if (enabled && !permission) message = "Notificações não permitidas; habilite-as nas configurações do Android. " + message;
        if (enabled && !scheduled) message = "Lembrete não agendado. Reabra o aplicativo para tentar novamente. " + message;
        if (error != null) message = error + " " + message;
        return Json.obj("enabled", enabled, "notificationPermission", permission, "scheduled", scheduled,
            "nextWindowAt", ReminderWindow.nextWindowAt(System.currentTimeMillis()),
            "lastNotifiedAt", saved.getLong("lastNotifiedAt", 0), "message", message);
    }
    /** At most once per promotion window, including process death or repeated job delivery. */
    static synchronized void notifyIfDue(Context context) {
        SharedPreferences saved = prefs(context);
        if (!saved.getBoolean("enabled", false)) { cancel(context); return; }
        ensureChannel(context);
        if (!notificationPermission(context)) return;
        long now = System.currentTimeMillis(), window = ReminderWindow.window(now);
        // <= also prevents duplicates when the wall clock moves backwards.
        if (saved.contains("lastWindow") && window <= saved.getLong("lastWindow", Long.MIN_VALUE)) return;
        Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent action = PendingIntent.getActivity(context, NOTIFICATION_ID, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Lembrete: resgate manual no Qoder Desktop")
            .setContentText("Abra Usage → presente no Desktop. Login não concede créditos.")
            .setStyle(new Notification.BigTextStyle().bigText(EXPLANATION))
            .setContentIntent(action).setAutoCancel(true).setOnlyAlertOnce(true).build();
        // Prefer missing a reminder after a crash over repeating it. This is not claim state.
        if (!saved.edit().putLong("lastWindow", window).commit()) return;
        notifications(context).notify(NOTIFICATION_ID, notification);
        saved.edit().putLong("lastNotifiedAt", now).commit();
    }
}

/** Pure JVM arithmetic, independent of the device timezone or daylight-saving rules. */
final class ReminderWindow {
    static final long HOUR = 60 * 60 * 1000L;
    static final long DAY = 24 * HOUR;
    private ReminderWindow() {}
    static long window(long now) { return Math.floorDiv(now + 8 * HOUR - 10 * HOUR, DAY); }
    static long nextWindowAt(long now) { return (window(now) + 1) * DAY + 10 * HOUR - 8 * HOUR; }
}
