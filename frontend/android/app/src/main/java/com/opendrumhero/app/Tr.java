package com.opendrumhero.app;

/** Language of the texts the Android side shows (the app tells which: "en" or "pt"; English by default). */
final class Tr {
    static volatile String lang = "en";

    private Tr() { }

    static String t(String en, String pt) {
        return "pt".equals(lang) ? pt : en;
    }
}
