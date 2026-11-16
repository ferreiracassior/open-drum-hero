package com.opendrumhero.app;

import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.media.midi.MidiDevice;
import android.media.midi.MidiDeviceInfo;
import android.media.midi.MidiManager;
import android.media.midi.MidiOutputPort;
import android.media.midi.MidiReceiver;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.OutputStream;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * Native part of OpenDrumHero on Android (the rest is the same app as the exe):
 *  - electronic drum kit on USB (Android MIDI API, OTG cable) -> "midi" events for the app;
 *  - save files to the Download folder (song export, debug mode log);
 *  - Songsterr window (login + Guitar Pro download with the Plus account) -> SongsterrActivity.
 */
@CapacitorPlugin(name = "DrumHero")
public class DrumHeroPlugin extends Plugin {
    private MidiManager midi;
    private final Map<Integer, MidiDevice> open = new HashMap<>();
    private final Map<Integer, String> names = new HashMap<>();
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean midiStarted = false;

    /** Language chosen in the app (error texts and the Songsterr window). */
    @PluginMethod
    public void setLang(PluginCall call) {
        String lang = call.getString("lang");
        if (lang != null) Tr.lang = lang;
        call.resolve();
    }

    /**
     * Screen orientation: "any" follows the phone (respecting the system rotation lock) — library and settings;
     * anything else stays landscape (game, drum kit map).
     */
    @PluginMethod
    public void setOrientation(PluginCall call) {
        int o = "any".equals(call.getString("mode"))
            ? ActivityInfo.SCREEN_ORIENTATION_FULL_USER
            : ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE;
        getActivity().runOnUiThread(() -> {
            getActivity().setRequestedOrientation(o);
            call.resolve();
        });
    }

    /** App closed: release the drum kit (nothing stays open/running afterwards). */
    @Override
    protected void handleOnDestroy() {
        for (Integer id : new java.util.ArrayList<>(open.keySet())) closeDevice(id);
        super.handleOnDestroy();
    }

    // ------------------------------------------------------------------------------- drum kit (MIDI)

    @PluginMethod
    public void startMidi(PluginCall call) {
        if (midi == null) midi = (MidiManager) getContext().getSystemService(Context.MIDI_SERVICE);
        if (midi == null) { call.reject(Tr.t("this device has no MIDI support", "este aparelho não tem suporte a MIDI")); return; }
        if (!midiStarted) {
            midiStarted = true;
            midi.registerDeviceCallback(MidiManager.TRANSPORT_MIDI_BYTE_STREAM, Runnable::run, new MidiManager.DeviceCallback() {
                @Override public void onDeviceAdded(MidiDeviceInfo info) { openDevice(info); }
                @Override public void onDeviceRemoved(MidiDeviceInfo info) { closeDevice(info.getId()); }
            });
            for (MidiDeviceInfo info : midi.getDevicesForTransport(MidiManager.TRANSPORT_MIDI_BYTE_STREAM)) openDevice(info);
        }
        JSObject r = new JSObject();
        r.put("ports", portList());
        call.resolve(r);
    }

    private void openDevice(MidiDeviceInfo info) {
        if (info.getOutputPortCount() == 0 || open.containsKey(info.getId())) return;
        midi.openDevice(info, device -> {
            if (device == null) return;
            open.put(info.getId(), device);
            Bundle p = info.getProperties();
            String name = p.getString(MidiDeviceInfo.PROPERTY_NAME);
            if (name == null) name = p.getString(MidiDeviceInfo.PROPERTY_PRODUCT, "MIDI USB");
            names.put(info.getId(), name);
            for (int i = 0; i < info.getOutputPortCount(); i++) {
                MidiOutputPort port = device.openOutputPort(i);
                if (port != null) port.connect(new Receiver());
            }
            emitStatus();
        }, main);
    }

    private void closeDevice(int id) {
        MidiDevice d = open.remove(id);
        names.remove(id);
        if (d != null) try { d.close(); } catch (Exception ignored) { }
        emitStatus();
    }

    private JSArray portList() {
        JSArray a = new JSArray();
        for (String n : names.values()) a.put(n);
        return a;
    }

    private void emitStatus() {
        JSObject o = new JSObject();
        o.put("ports", portList());
        notifyListeners("midiStatus", o);
    }

    /** Receives the MIDI bytes (several messages may come together, with running status). */
    private class Receiver extends MidiReceiver {
        private int status = 0;
        @Override
        public void onSend(byte[] msg, int offset, int count, long timestamp) {
            int i = offset, end = offset + count;
            while (i < end) {
                int b = msg[i] & 0xFF;
                if (b >= 0xF8) { i++; continue; }                  // real-time clock
                if (b >= 0x80) { status = b; i++; }
                if (status == 0) { i++; continue; }
                int kind = status & 0xF0;
                int len = (kind == 0xC0 || kind == 0xD0) ? 1 : (status >= 0xF0 ? 0 : 2);
                if (status >= 0xF0) { status = 0; continue; }      // sysex and the like: ignore
                if (i + len > end) break;
                int d1 = msg[i] & 0x7F, d2 = len > 1 ? msg[i + 1] & 0x7F : 0;
                i += len;
                if (kind == 0x90 && d2 > 0) {
                    JSObject o = new JSObject();
                    o.put("status", status);
                    o.put("data1", d1);
                    o.put("data2", d2);
                    // event age when it leaves here: the app converts it to its own clock
                    o.put("ageMs", (System.nanoTime() - timestamp) / 1e6);
                    notifyListeners("midi", o);
                }
            }
        }
    }

    // ------------------------------------------------------------------------------ save file

    /** Saves to the device's Download folder. data in base64. */
    @PluginMethod
    public void saveFile(PluginCall call) {
        String name = call.getString("name", "drumhero.json");
        String mime = call.getString("mime", "application/octet-stream");
        String data = call.getString("data", "");
        Executors.newSingleThreadExecutor().execute(() -> {
            try {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.MIME_TYPE, mime);
                v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/OpenDrumHero");
                Uri uri = getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new Exception(Tr.t("could not create the file", "não consegui criar o arquivo"));
                try (OutputStream out = getContext().getContentResolver().openOutputStream(uri)) {
                    out.write(Base64.decode(data, Base64.DEFAULT));
                }
                JSObject r = new JSObject();
                r.put("path", "Download/OpenDrumHero/" + name);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(Tr.t("could not save: ", "não consegui salvar: ") + e.getMessage());
            }
        });
    }

    // ------------------------------------------------------------------------------------ Songsterr

    @PluginMethod
    public void fetchSongsterr(PluginCall call) {
        String url = call.getString("url");
        String lang = call.getString("lang");
        if (lang != null) Tr.lang = lang;
        if (url == null) { call.reject(Tr.t("empty link", "link vazio")); return; }
        SongsterrActivity.progress = msg -> {
            JSObject o = new JSObject();
            o.put("message", msg);
            notifyListeners("songsterrProgress", o);
        };
        Intent intent = new Intent(getContext(), SongsterrActivity.class);
        intent.putExtra("url", url);
        startActivityForResult(call, intent, "songsterrDone");
    }

    @ActivityCallback
    private void songsterrDone(PluginCall call, ActivityResult result) {
        SongsterrActivity.progress = null;
        Intent data = result.getData();
        String error = data != null ? data.getStringExtra("error") : null;
        String gpPath = data != null ? data.getStringExtra("gpPath") : null;
        if (gpPath == null) { call.reject(error != null ? error : Tr.t("the Songsterr window was closed before downloading the Guitar Pro file", "a janela do Songsterr foi fechada antes de baixar o Guitar Pro")); return; }
        try {
            JSObject r = new JSObject();
            r.put("url", data.getStringExtra("url"));
            r.put("gpName", data.getStringExtra("gpName"));
            r.put("gp", readB64(gpPath));
            String midPath = data.getStringExtra("midPath");
            if (midPath != null) r.put("mid", readB64(midPath));
            String vp = data.getStringExtra("videoPointsPath");
            if (vp != null) r.put("videoPoints", new String(Files.readAllBytes(new File(vp).toPath()), "UTF-8"));
            call.resolve(r);
        } catch (Exception e) {
            call.reject(Tr.t("could not read the downloaded file: ", "não consegui ler o arquivo baixado: ") + e.getMessage());
        }
    }

    private static String readB64(String path) throws Exception {
        File f = new File(path);
        String s = Base64.encodeToString(Files.readAllBytes(f.toPath()), Base64.NO_WRAP);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
        return s;
    }
}
