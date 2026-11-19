package okhttp3;

public abstract class RequestBody {
    public abstract MediaType contentType();
    public long contentLength() throws java.io.IOException { return -1; }
    public abstract void writeTo(Object sink) throws java.io.IOException;

    public static RequestBody create(MediaType contentType, byte[] content) {
        return new RequestBody() {
            @Override public MediaType contentType() { return contentType; }
            @Override public long contentLength() { return content != null ? content.length : 0; }
            @Override public void writeTo(Object sink) {}
        };
    }

    public static RequestBody create(byte[] content, MediaType contentType) {
        return create(contentType, content);
    }
}
