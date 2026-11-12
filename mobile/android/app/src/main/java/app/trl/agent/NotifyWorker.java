package app.trl.agent;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.TimeUnit;

/**
 * Built-in result notifications (no Firebase, no extra app): every ~15 minutes Android wakes this worker, which asks the
 * cloud gate for finished agent runs newer than the last one the app has seen and shows a normal notification for each.
 */
public class NotifyWorker extends Worker {
    static final String PREFS = "trl_notify";
    static final String UNIQUE = "trl_result_notify";
    private static final String CH = "trl_results";
    /** True while the app is on screen: it shows results itself, so the worker stays quiet. */
    static volatile boolean foreground = false;

    public NotifyWorker(@NonNull Context ctx, @NonNull WorkerParameters p) { super(ctx, p); }

    static void enable(Context ctx, String url, String key, long last) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("url", url).putString("key", key).putLong("last", last).apply();
        Constraints c = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(NotifyWorker.class, 15, TimeUnit.MINUTES).setConstraints(c).build();
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(UNIQUE, ExistingPeriodicWorkPolicy.UPDATE, req);
    }

    static void setLast(Context ctx, long last) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong("last", last).apply();
    }

    static void disable(Context ctx) {
        WorkManager.getInstance(ctx).cancelUniqueWork(UNIQUE);
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }

    @NonNull
    @Override
    public Result doWork() {
        if (foreground) return Result.success();
        Context ctx = getApplicationContext();
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String url = sp.getString("url", null), key = sp.getString("key", null);
        long last = sp.getLong("last", 0);
        if (url == null || key == null) return Result.success();
        try {
            HttpURLConnection h = (HttpURLConnection) new URL(url + "/feed?after=" + last).openConnection();
            h.setRequestProperty("x-phone-key", key);
            h.setConnectTimeout(15000);
            h.setReadTimeout(20000);
            if (h.getResponseCode() != 200) return Result.retry();
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(h.getInputStream(), "UTF-8"))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            JSONObject j = new JSONObject(sb.toString());
            if (!j.optBoolean("ok")) return Result.retry();
            long newLast = j.optLong("last", last);
            if (newLast < last) { setLast(ctx, newLast); return Result.success(); } // the gate was reset
            JSONArray items = j.optJSONArray("items");
            if (last > 0 && items != null) {
                int from = Math.max(0, items.length() - 5); // never flood: the 5 newest at most
                for (int i = from; i < items.length(); i++) show(ctx, items.getJSONObject(i), i);
            }
            setLast(ctx, newLast);
            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        }
    }

    private void show(Context ctx, JSONObject it, int idx) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(new NotificationChannel(CH, "نتائج الوكلاء", NotificationManager.IMPORTANCE_DEFAULT));
        String agent = it.optString("agent", "مهمة");
        boolean fail = "fail".equals(it.optString("kind"));
        String text = it.optString("text", "");
        if (text.length() > 160) text = text.substring(0, 160);
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CH)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(agent + (fail ? ": ما خلصت" : ": خلص"))
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setContentIntent(pi);
        try { nm.notify((int) (System.currentTimeMillis() % 1000000000L) + idx, b.build()); } catch (SecurityException ignored) { /* notifications not allowed */ }
    }
}