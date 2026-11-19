package okhttp3;

public class MediaType {
    private final String mType;

    private MediaType(String type) {
        mType = type;
    }

    public static MediaType parse(String string) {
        return string == null ? null : new MediaType(string);
    }

    public static MediaType get(String string) {
        return new MediaType(string);
    }

    @Override
    public String toString() {
        return mType;
    }
}
