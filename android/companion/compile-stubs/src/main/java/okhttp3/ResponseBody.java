package okhttp3;

import java.io.ByteArrayInputStream;
import java.io.InputStream;

public abstract class ResponseBody {
    public static ResponseBody create(MediaType contentType, byte[] content) {
        return new ResponseBody() {
            @Override public MediaType contentType() { return contentType; }
            @Override public long contentLength() { return content != null ? content.length : 0; }
            @Override public byte[] bytes() { return content != null ? content : new byte[0]; }
            @Override public InputStream byteStream() { return new ByteArrayInputStream(bytes()); }
            @Override public String string() { return new String(bytes()); }
        };
    }

    public static ResponseBody create(byte[] content, MediaType contentType) {
        return create(contentType, content);
    }

    public MediaType contentType() { return null; }
    public abstract long contentLength();
    public abstract byte[] bytes() throws java.io.IOException;
    public abstract InputStream byteStream();
    public abstract String string() throws java.io.IOException;
}
