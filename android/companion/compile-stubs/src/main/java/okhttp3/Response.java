package okhttp3;

import java.util.HashMap;
import java.util.Map;

public class Response {
    private final Request mRequest;
    private final Protocol mProtocol;
    private final int mCode;
    private final String mMessage;
    private final ResponseBody mBody;
    private final Map<String, String> mHeaders;

    public Response(Builder builder) {
        mRequest = builder.mRequest;
        mProtocol = builder.mProtocol;
        mCode = builder.mCode;
        mMessage = builder.mMessage;
        mBody = builder.mBody;
        mHeaders = new HashMap<>(builder.mHeaders);
    }

    public Request request() { return mRequest; }
    public Protocol protocol() { return mProtocol; }
    public int code() { return mCode; }
    public boolean isSuccessful() { return mCode >= 200 && mCode < 300; }
    public String message() { return mMessage; }
    public ResponseBody body() { return mBody; }
    public String header(String name) { return mHeaders.get(name); }
    public Builder newBuilder() { return new Builder(this); }

    public static class Builder {
        private Request mRequest;
        private Protocol mProtocol = Protocol.HTTP_1_1;
        private int mCode = 200;
        private String mMessage = "OK";
        private ResponseBody mBody;
        private final Map<String, String> mHeaders = new HashMap<>();

        public Builder() {}

        public Builder(Response response) {
            mRequest = response.mRequest;
            mProtocol = response.mProtocol;
            mCode = response.mCode;
            mMessage = response.mMessage;
            mBody = response.mBody;
            mHeaders.putAll(response.mHeaders);
        }

        public Builder request(Request request) { mRequest = request; return this; }
        public Builder protocol(Protocol protocol) { mProtocol = protocol; return this; }
        public Builder code(int code) { mCode = code; return this; }
        public Builder message(String message) { mMessage = message; return this; }
        public Builder body(ResponseBody body) { mBody = body; return this; }
        public Builder header(String name, String value) { mHeaders.put(name, value); return this; }
        public Response build() { return new Response(this); }
    }
}
