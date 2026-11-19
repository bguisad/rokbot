package oj;

public enum B {
    c("http/1.0"),
    d("http/1.1"),
    e("spdy/3.1"),
    f("h2"),
    g("h2_prior_knowledge"),
    h("quic");

    private final String a;

    B(String s) {
        this.a = s;
    }
}
