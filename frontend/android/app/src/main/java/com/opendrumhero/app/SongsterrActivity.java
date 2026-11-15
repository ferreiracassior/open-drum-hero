package com.opendrumhero.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.URLUtil;
import android.webkit.WebResourceRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.os.Message;
import android.widget.FrameLayout;
import android.widget.TextView;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * Windowless Songsterr import (same logic as the exe): the song page opens in a HIDDEN
 * WebView with your session, the app checks that you're logged in (and have Plus) and clicks download → Guitar Pro
 * (script public/songsterr-auto.js, the same as the exe). Only if you're not logged in does the WebView show the
 * login page; after signing in it disappears and the import continues by itself. Requires Songsterr Plus.
 */
public class SongsterrActivity extends Activity {
    interface Progress { void post(String msg); }
    static volatile Progress progress;

    private static final Pattern GP = Pattern.compile("(?i).*\\.(gp|gp3|gp4|gp5|gpx|gp7|gp8)$");
    private static final Pattern MID = Pattern.compile("(?i).*\\.(mid|midi)$");
    private static final Pattern STATE = Pattern.compile("<script[^>]*id=\"state\"[^>]*>([\\s\\S]*?)</script>");
    private static final String SIGNIN = "https://www.songsterr.com/signin";
    private static final long LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
    private static final long DOWNLOAD_TIMEOUT_MS = 90 * 1000;

    private enum Phase { CHECK, LOGIN, EXPORT, DONE }

    private WebView web;
    private WebView popup;      // windows the site opens (e.g. "Sign in with Google")
    private String defaultUa, desktopUa;
    private TextView status;
    private TextView loginHelp;
    private FrameLayout root;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private volatile String videoPointsUrl;
    private volatile java.util.Map<String, String> videoPointsHeaders;   // includes the X-Sr-Token the site requires
    private volatile java.util.concurrent.CountDownLatch vpLatch;
    private volatile String vpBody;
    /** Addresses requested after the download click (to find the file on the network and for the error message). */
    private final java.util.List<String> exportRequests = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
    private volatile boolean netGrabbed = false;
    private String songUrl, midPath, autoJs;
    private Phase phase = Phase.CHECK;
    private boolean afterLogin = false;
    private long loginStarted;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        songUrl = getIntent().getStringExtra("url");
        autoJs = "window.__drumheroLang='" + Tr.lang + "';\n" + readAsset("public/songsterr-auto.js");

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(5, 8, 14));
        web = new WebView(this);
        web.setVisibility(View.INVISIBLE);
        status = new TextView(this);
        status.setTextColor(Color.WHITE);
        status.setTextSize(18);
        status.setGravity(Gravity.CENTER);
        status.setPadding(48, 48, 48, 48);
        // fixed notice at the top during login: Google doesn't allow signing in with a Google account inside apps
        loginHelp = new TextView(this);
        loginHelp.setTextColor(Color.rgb(255, 213, 138));
        loginHelp.setBackgroundColor(Color.rgb(40, 28, 6));
        loginHelp.setTextSize(13);
        loginHelp.setPadding(32, 20, 32, 20);
        loginHelp.setText(Tr.t(
            "Signing in with Google doesn't work inside apps (Google blocks it). Use your Songsterr e-mail and password — "
                + "or import the song on the PC and bring it here (Export → Import from another device).",
            "Entrar com o Google não funciona dentro de apps (o Google bloqueia). Use o e-mail e a senha do Songsterr — "
                + "ou importe a música no PC e passe para cá (Exportar → Importar de outro aparelho)."));
        loginHelp.setVisibility(View.GONE);
        FrameLayout.LayoutParams top = new FrameLayout.LayoutParams(-1, -2);
        top.gravity = Gravity.TOP;
        FrameLayout.LayoutParams page = new FrameLayout.LayoutParams(-1, -1);
        root.addView(web, page);
        root.addView(status, new FrameLayout.LayoutParams(-1, -1));
        root.addView(loginHelp, top);
        setContentView(root);

        setupWebView(web);
        web.addJavascriptInterface(new Bridge(), "DrumHeroBridge");
        // the site may open a new window for the login: show it on top, inside the app
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                closePopup();
                popup = new WebView(SongsterrActivity.this);
                setupWebView(popup);
                popup.addJavascriptInterface(new Bridge(), "DrumHeroBridge");
                attachDownloads(popup);
                popup.getSettings().setUserAgentString(defaultUa);   // Google login window
                popup.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                        return reloadWithUa(v, req);
                    }
                });
                popup.setWebChromeClient(new WebChromeClient() {
                    @Override public void onCloseWindow(WebView w) { closePopup(); }
                });
                root.addView(popup, new FrameLayout.LayoutParams(-1, -1));
                loginHelp.bringToFront();
                fitBelowHelp();
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(popup);
                resultMsg.sendToTarget();
                return true;
            }
        });
        // the Songsterr site has a service worker: what goes through it doesn't reach the WebViewClient
        // (the YouTube video points request, for example); record it here too
        try {
            ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest req) {
                    String u = req.getUrl().toString();
                    if (u.contains("/api/video-points/") && u.contains("/list")) { videoPointsUrl = u; videoPointsHeaders = req.getRequestHeaders(); }
                    return null;
                }
            });
        } catch (Exception ignored) { /* no service worker */ }
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                String u = req.getUrl().toString();
                if (u.contains("/api/video-points/") && u.contains("/list")) { videoPointsUrl = u; videoPointsHeaders = req.getRequestHeaders(); }
                if (phase == Phase.EXPORT) {
                    exportRequests.add(u);
                    // the Guitar Pro requested directly over the network: download it here as well (with your session)
                    String path = req.getUrl().getPath();
                    if (!netGrabbed && path != null && GP.matcher(path).matches()) {
                        netGrabbed = true;
                        String name = path.substring(path.lastIndexOf('/') + 1);
                        String cookies = CookieManager.getInstance().getCookie(u);
                        String ua = req.getRequestHeaders() != null ? req.getRequestHeaders().get("User-Agent") : null;
                        io.execute(() -> {
                            try { received(name, httpGet(u, cookies, ua)); } catch (Exception ignored) { netGrabbed = false; }
                        });
                    }
                }
                return null;
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return reloadWithUa(view, req);
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                if (url == null || !url.contains("songsterr.com") || url.contains("/signin")) return;
                if (phase == Phase.CHECK) runCheck();
                // during login: the site returns to one of its pages when you sign in; check on the page itself
                // (besides the network check) and set up download capture in case you download by hand
                else if (phase == Phase.LOGIN) web.evaluateJavascript(autoJs
                    + "\n;__drumheroAuto.check().then(r=>DrumHeroBridge.loginState(JSON.stringify(r))).catch(()=>{});", null);
            }
        });
        attachDownloads(web);
        post(Tr.t("Importing from Songsterr…", "Importando do Songsterr…"));
        uaFor(web, songUrl);
        web.loadUrl(songUrl);
    }

    /** Download triggered by the page (Guitar Pro): takes the file, whether blob: (generated in the page) or a link. */
    private void attachDownloads(WebView w) {
        w.setDownloadListener((dlUrl, userAgent, disposition, mime, length) -> {
            String name = URLUtil.guessFileName(dlUrl, disposition, mime);
            if (dlUrl.startsWith("blob:")) {
                // songsterr-auto.js keeps the file (the site revokes the link right after the click)
                String js = "(function(){var u=" + quote(dlUrl) + ";var b=window.__dhBlobs&&window.__dhBlobs[u];"
                    + "(b?Promise.resolve(b):fetch(u).then(function(r){return r.blob();}))"
                    + ".then(function(b){return new Promise(function(res){var f=new FileReader();"
                    + "f.onload=function(){res(f.result.split(',')[1]);};f.readAsDataURL(b);});})"
                    + ".then(function(d){DrumHeroBridge.file(" + quote(name) + ",d);})"
                    + ".catch(function(e){DrumHeroBridge.fail(" + quote(Tr.t("could not read the downloaded file: ", "não consegui ler o arquivo baixado: ")) + "+String(e));});})();";
                w.evaluateJavascript(js, null);
            } else {
                String cookies = CookieManager.getInstance().getCookie(dlUrl);
                io.execute(() -> {
                    try { received(name, httpGet(dlUrl, cookies, userAgent)); }
                    catch (Exception e) { fail(Tr.t("failed to download ", "falha ao baixar ") + name + ": " + e.getMessage()); }
                });
            }
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView(WebView w) {
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        if (defaultUa == null) {
            defaultUa = s.getUserAgentString();
            java.util.regex.Matcher cv = Pattern.compile("Chrome/([\\d.]+)").matcher(defaultUa);
            desktopUa = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"
                + (cv.find() ? cv.group(1) : "130.0.0.0") + " Safari/537.36";
        }
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
    }

    /** The login page starts right below the top notice (it isn't hidden behind it). */
    private void fitBelowHelp() {
        int h = loginHelp.getVisibility() == View.VISIBLE ? loginHelp.getHeight() : 0;
        for (WebView w : new WebView[] { web, popup }) {
            if (w == null) continue;
            FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) w.getLayoutParams();
            lp.topMargin = h;
            w.setLayoutParams(lp);
        }
    }

    /**
     * Songsterr site in desktop mode (the same as the exe); Google pages (Google account login)
     * with the device's normal identification — with another one, Google shows "browser not secure".
     */
    private boolean uaFor(WebView w, String url) {
        if (url == null || defaultUa == null || !url.startsWith("http")) return false;
        // during login, everything with the device's normal identification (as it always worked with Google);
        // the (hidden) song page in desktop mode, where the download button is
        String want = phase != Phase.LOGIN && url.contains("songsterr.com") ? desktopUa : defaultUa;
        if (want.equals(w.getSettings().getUserAgentString())) return false;
        w.getSettings().setUserAgentString(want);
        return true;
    }

    /** Moving between Songsterr and Google: switch the identification and open the address again with it. */
    private boolean reloadWithUa(WebView v, WebResourceRequest req) {
        if (!"GET".equalsIgnoreCase(req.getMethod())) return false;
        String url = req.getUrl().toString();
        if (!uaFor(v, url)) return false;
        v.loadUrl(url);
        return true;
    }

    private void closePopup() {
        if (popup == null) return;
        root.removeView(popup);
        popup.destroy();
        popup = null;
    }

    // ---------------------------------------------------------------------------------- steps

    private void runCheck() {
        phase = Phase.EXPORT;   // avoids running twice if the page finishes loading again
        web.evaluateJavascript(autoJs + "\n;__drumheroAuto.check().then(r=>DrumHeroBridge.checked(JSON.stringify(r)))"
            + ".catch(e=>DrumHeroBridge.fail(String(e)));", null);
    }

    private void onChecked(String json) {
        try {
            JSONObject r = new JSONObject(json);
            if (!r.optBoolean("loggedIn")) {
                if (afterLogin) { fail(Tr.t("Songsterr didn't recognize the login yet; try importing again", "o Songsterr ainda não reconheceu o login; tente importar de novo")); return; }
                startLogin();
                return;
            }
            if (!r.optBoolean("hasPlus")) {
                String name = r.optString("name", "");
                fail(Tr.t("the Songsterr account" + (name.isEmpty() ? "" : " (" + name + ")") + " has no Plus: Guitar Pro download "
                        + "is a Songsterr Plus feature. Subscribe to Plus or import a Guitar Pro file manually.",
                    "a conta do Songsterr" + (name.isEmpty() ? "" : " (" + name + ")") + " não tem Plus: o download de "
                        + "Guitar Pro é recurso do Songsterr Plus. Assine o Plus ou importe um arquivo Guitar Pro manualmente."));
                return;
            }
            post(Tr.t("Downloading the Guitar Pro file…", "Baixando o Guitar Pro…"));
            web.evaluateJavascript(autoJs + "\n;__drumheroAuto.exportGp().catch(e=>DrumHeroBridge.fail(String(e && e.message || e)));", null);
            ui.postDelayed(() -> { if (phase != Phase.DONE) fail(Tr.t("Songsterr didn't deliver the Guitar Pro file in time", "o Songsterr não entregou o Guitar Pro a tempo") + diag()); }, DOWNLOAD_TIMEOUT_MS);
        } catch (Exception e) {
            fail(Tr.t("unexpected answer from the Songsterr page", "resposta inesperada da página do Songsterr"));
        }
    }

    /** Not logged in: show the login page and watch until the account shows up as logged in. */
    private void startLogin() {
        phase = Phase.LOGIN;
        loginStarted = System.currentTimeMillis();
        post(Tr.t("You are not logged in to Songsterr: sign in to your account.", "Você não está logado no Songsterr: entre na sua conta."));
        status.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        loginHelp.setVisibility(View.VISIBLE);
        loginHelp.bringToFront();
        loginHelp.post(this::fitBelowHelp);
        uaFor(web, SIGNIN);
        web.loadUrl(SIGNIN);
        ui.postDelayed(this::pollLogin, 2500);
    }

    /** Last addresses requested after the download click (helps understand when the file doesn't arrive). */
    private String diag() {
        java.util.List<String> list;
        synchronized (exportRequests) { list = new java.util.ArrayList<>(exportRequests); }
        StringBuilder b = new StringBuilder();
        int from = Math.max(0, list.size() - 6);
        for (int i = from; i < list.size(); i++) {
            String u = list.get(i).replaceFirst("^https?://", "");
            if (u.length() > 90) u = u.substring(0, 90) + "…";
            b.append(i == from ? "" : " | ").append(u);
        }
        return b.length() == 0 ? Tr.t(" (no request after the click)", " (nenhum pedido depois do clique)") : " [" + b + "]";
    }

    private void pollLogin() {
        if (phase != Phase.LOGIN) return;
        if (System.currentTimeMillis() - loginStarted > LOGIN_TIMEOUT_MS) { fail(Tr.t("the Songsterr login was not completed in time", "o login no Songsterr não foi concluído a tempo")); return; }
        // check from inside the Songsterr page itself (same WebView session, including protected cookies)
        String cur = web.getUrl();
        if (cur != null && cur.contains("songsterr.com")) {
            web.evaluateJavascript("fetch('https://www.songsterr.com/',{credentials:'include',cache:'no-store'}).then(r=>r.text()).then(h=>{"
                + "var m=h.match(/<script[^>]*id=\"state\"[^>]*>([\\s\\S]*?)<\\/script>/);var s=m?JSON.parse(m[1]):null;"
                + "DrumHeroBridge.loginState(JSON.stringify({loggedIn:!!(s&&s.user&&s.user.isLoggedIn)}));}).catch(()=>{});", null);
        }
        io.execute(() -> {
            boolean ok = isLoggedIn();
            ui.post(() -> {
                if (phase != Phase.LOGIN) return;
                if (!ok) { ui.postDelayed(this::pollLogin, 2500); return; }
                loginDone();
            });
        });
    }

    /** Logged in: close the login screen (and the Google window, if any) and continue the import hidden. */
    private void loginDone() {
        if (phase != Phase.LOGIN) return;
        afterLogin = true;
        phase = Phase.CHECK;
        closePopup();
        loginHelp.setVisibility(View.GONE);
        fitBelowHelp();
        web.setVisibility(View.INVISIBLE);
        status.setVisibility(View.VISIBLE);
        post(Tr.t("Logged in; importing…", "Login feito; importando…"));
        uaFor(web, songUrl);
        web.loadUrl(songUrl);
    }

    private boolean isLoggedIn() {
        try {
            CookieManager.getInstance().flush();
            String url = "https://www.songsterr.com/";
            String html = new String(httpGet(url, CookieManager.getInstance().getCookie(url), web.getSettings().getUserAgentString()), "UTF-8");
            Matcher m = STATE.matcher(html);
            return m.find() && new JSONObject(m.group(1)).optJSONObject("user") != null
                && new JSONObject(m.group(1)).getJSONObject("user").optBoolean("isLoggedIn");
        } catch (Exception e) {
            return false;
        }
    }

    private class Bridge {
        @JavascriptInterface public void checked(String json) { ui.post(() -> onChecked(json)); }
        @JavascriptInterface public void loginState(String json) {
            ui.post(() -> {
                try { if (new JSONObject(json).optBoolean("loggedIn")) loginDone(); } catch (Exception ignored) { }
            });
        }
        @JavascriptInterface public void file(String name, String b64) {
            io.execute(() -> received(name, Base64.decode(b64, Base64.DEFAULT)));
        }
        @JavascriptInterface public void fail(String err) { ui.post(() -> SongsterrActivity.this.fail(err)); }
        @JavascriptInterface public void videoPoints(String text) {
            vpBody = text;
            java.util.concurrent.CountDownLatch l = vpLatch;
            if (l != null) l.countDown();
        }
    }

    private void received(String name, byte[] data) {
        try {
            if (MID.matcher(name).matches()) { midPath = save("songsterr.mid", data); return; }
            // name without extension (file coming straight from the page): counts as Guitar Pro during the download
            if (!GP.matcher(name).matches() && phase != Phase.EXPORT && phase != Phase.LOGIN) return;
            if (phase == Phase.DONE) return;
            String gpPath = save("songsterr.gp", data);
            post(Tr.t("Guitar Pro received; building the song…", "Guitar Pro recebido; montando a música…"));
            String vpPath = null;
            String vpText = fetchVideoPoints();
            if (vpText != null) vpPath = save("video-points.json", vpText.getBytes("UTF-8"));
            Intent r = new Intent();
            r.putExtra("url", songUrl);
            r.putExtra("gpName", name);
            r.putExtra("gpPath", gpPath);
            if (midPath != null) r.putExtra("midPath", midPath);
            if (vpPath != null) r.putExtra("videoPointsPath", vpPath);
            ui.post(() -> { phase = Phase.DONE; setResult(RESULT_OK, r); finish(); });
        } catch (Exception e) {
            fail(Tr.t("failure: ", "falha: ") + e.getMessage());
        }
    }

    /**
     * Address of the YouTube video sync points (/api/video-points/…) that the song page
     * requested. If the Guitar Pro arrived first, wait a little; also look in the list of resources the
     * page itself loaded (catches requests that didn't go through the interceptors). Runs off the UI thread.
     */
    private String findVideoPointsUrl() {
        final String js = "(function(){var n=performance.getEntriesByType('resource').map(function(e){return e.name})"
            + ".filter(function(x){return x.indexOf('/api/video-points/')>=0});return n.length?n[0]:''})()";
        for (int i = 0; i < 10 && videoPointsUrl == null; i++) {
            final java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
            final String[] found = { null };
            ui.post(() -> {
                try {
                    web.evaluateJavascript(js, v -> {
                        if (v != null && v.length() > 2 && v.startsWith("\"")) found[0] = v.substring(1, v.length() - 1).replace("\\/", "/");
                        done.countDown();
                    });
                } catch (Exception e) { done.countDown(); }
            });
            try { done.await(2, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException ignored) { break; }
            if (found[0] != null && found[0].startsWith("http")) { videoPointsUrl = found[0]; break; }
            try { Thread.sleep(500); } catch (InterruptedException ignored) { break; }
        }
        return videoPointsUrl;
    }

    /**
     * List of synced YouTube videos (/api/video-points/{song}/{revision}/list). The site only
     * returns it with the X-Sr-Token header (a song code that comes from /api/meta/…); without it the response
     * isn't the list and the song ended up without the Original modes. First repeats the page's request with the same
     * headers; otherwise requests it from inside the page itself, fetching the code first. Runs off the UI thread.
     */
    private String fetchVideoPoints() {
        String url = findVideoPointsUrl();
        java.util.Map<String, String> h = videoPointsHeaders;
        if (url != null && h != null) {
            try {
                String text = new String(httpGet(url, CookieManager.getInstance().getCookie(url), h), "UTF-8").trim();
                if (text.startsWith("[")) return text;
            } catch (Exception ignored) { /* try through the page */ }
        }
        String js = "(async function(){"
            + "var u=" + (url != null ? quote(url) : "null") + ";"
            + "if(!u){var m=/-s(\\d+)/.exec(location.pathname);var st=document.getElementById('state');"
            + "var rid=st&&/\"revisionId\":([1-9]\\d*)/.exec(st.textContent);if(!m||!rid)return '';"
            + "u='/api/video-points/'+m[1]+'/'+rid[1]+'/list';}"
            + "var o={credentials:'include',cache:'no-store'};"
            + "var t=await (await fetch(u,o)).text();if(t.trim().charAt(0)==='[')return t;"
            + "var ids=/video-points\\/(\\d+)\\/(\\d+)/.exec(u);"
            + "var meta=await (await fetch('/api/meta/'+ids[1]+'/'+ids[2],o)).json();"
            + "if(!meta||!meta.image)return '';"
            + "return await (await fetch(u,{credentials:'include',cache:'no-store',headers:{'X-Sr-Token':meta.image}})).text();"
            + "})().then(function(t){DrumHeroBridge.videoPoints(t||'')},function(){DrumHeroBridge.videoPoints('')})";
        vpBody = null;
        vpLatch = new java.util.concurrent.CountDownLatch(1);
        ui.post(() -> { try { web.evaluateJavascript(js, null); } catch (Exception e) { vpLatch.countDown(); } });
        try { vpLatch.await(10, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
        String text = vpBody != null ? vpBody.trim() : "";
        return text.startsWith("[") ? text : null;
    }

    private void fail(String msg) {
        ui.post(() -> {
            if (phase == Phase.DONE) return;
            phase = Phase.DONE;
            Intent r = new Intent();
            r.putExtra("error", msg);
            setResult(RESULT_OK, r);
            finish();
        });
    }

    // ---------------------------------------------------------------------------------- utilities

    private String save(String name, byte[] data) throws Exception {
        File f = new File(getCacheDir(), System.nanoTime() + "-" + name);
        try (FileOutputStream out = new FileOutputStream(f)) { out.write(data); }
        return f.getAbsolutePath();
    }

    private String readAsset(String path) {
        try (InputStream in = getAssets().open(path); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } catch (Exception e) {
            return "";
        }
    }

    private static byte[] httpGet(String url, String cookies, String ua) throws Exception {
        java.util.Map<String, String> h = new java.util.HashMap<>();
        if (ua != null) h.put("User-Agent", ua);
        return httpGet(url, cookies, h);
    }

    private static byte[] httpGet(String url, String cookies, java.util.Map<String, String> headers) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        if (cookies != null) c.setRequestProperty("Cookie", cookies);
        for (java.util.Map.Entry<String, String> e : headers.entrySet()) c.setRequestProperty(e.getKey(), e.getValue());
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } finally {
            c.disconnect();
        }
    }

    private void post(String msg) {
        Progress p = progress;
        if (p != null) p.post(msg);
        ui.post(() -> status.setText(msg));
    }

    private static String quote(String s) {
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'";
    }

    @Override
    public void onBackPressed() {
        if (popup != null) { if (popup.canGoBack()) popup.goBack(); else closePopup(); return; }
        if (phase == Phase.LOGIN && web.canGoBack()) web.goBack();
        else { fail(Tr.t("import canceled", "importação cancelada")); }
    }

    @Override
    protected void onDestroy() {
        if (phase != Phase.DONE) {
            Intent r = new Intent();
            r.putExtra("error", Tr.t("import canceled", "importação cancelada"));
            setResult(RESULT_OK, r);
        }
        CookieManager.getInstance().flush();
        closePopup();
        if (web != null) web.destroy();
        io.shutdown();
        super.onDestroy();
    }
}
