package com.turkmenonline.hatadefterim;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.widget.RemoteViews;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Home-screen widget: shows how many questions are due for review.
 * It reads the questions the web app saved with the Capacitor Preferences plugin
 * (SharedPreferences file "CapacitorStorage") and applies the same rule as the app:
 * a question is due when it is not mastered, or when its next review time has passed.
 */
public class DueWidgetProvider extends AppWidgetProvider {

    private static final String PREFS = "CapacitorStorage";
    private static final String KEY = "hata_defterim_questions_v1";

    static int countDue(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString(KEY, null);
        if (raw == null) {
            raw = prefs.getString("_cap_" + KEY, null); // older plugin versions prefixed the key
        }
        if (raw == null) {
            return 0;
        }
        try {
            JSONArray arr = new JSONArray(raw);
            long now = System.currentTimeMillis();
            int due = 0;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject q = arr.optJSONObject(i);
                if (q == null) {
                    continue;
                }
                boolean mastered = q.optBoolean("mastered", false);
                long dueAt = q.isNull("dueAt") ? 0L : q.optLong("dueAt", 0L);
                if (!mastered || (dueAt > 0 && dueAt <= now)) {
                    due++;
                }
            }
            return due;
        } catch (Exception e) {
            return 0;
        }
    }

    static void update(Context context, AppWidgetManager manager, int widgetId) {
        int due = countDue(context);
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_due);
        views.setTextViewText(R.id.widget_count, String.valueOf(due));
        views.setTextViewText(
            R.id.widget_label,
            context.getString(due == 0 ? R.string.widget_all_done : R.string.widget_due_label)
        );

        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pendingIntent = PendingIntent.getActivity(context, 0, intent, flags);
        views.setOnClickPendingIntent(R.id.widget_root, pendingIntent);

        manager.updateAppWidget(widgetId, views);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        for (int id : appWidgetIds) {
            update(context, manager, id);
        }
    }
}
