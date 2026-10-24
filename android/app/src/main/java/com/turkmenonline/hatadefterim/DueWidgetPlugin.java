package com.turkmenonline.hatadefterim;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Lets the web app ask the home-screen widget to refresh its numbers. */
@CapacitorPlugin(name = "DueWidget")
public class DueWidgetPlugin extends Plugin {

    @PluginMethod
    public void refresh(PluginCall call) {
        Context context = getContext();
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, DueWidgetProvider.class));
        for (int id : ids) {
            DueWidgetProvider.update(context, manager, id);
        }
        call.resolve();
    }
}
